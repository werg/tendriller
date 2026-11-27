// Unified lazy-pull P2P media & attachment helper over Chronolog `session.content`.
// Never stuffs large blobs into eager CAS or host R2 storage: chunks are encrypted under
// epoch keys (for private logs) or hash-addressed (for public logs) and pulled on demand
// from local OPFS/SQLite cache or connected peers.

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

async function normalizeInputBytes(input, fallbackType = 'application/octet-stream') {
  if (input instanceof Uint8Array) return { bytes: input, mediaType: fallbackType, name: null };
  if (ArrayBuffer.isView(input)) {
    return { bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength), mediaType: fallbackType, name: null };
  }
  if (input instanceof ArrayBuffer) return { bytes: new Uint8Array(input), mediaType: fallbackType, name: null };
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return {
      bytes: new Uint8Array(await input.arrayBuffer()),
      mediaType: input.type || fallbackType,
      name: typeof input.name === 'string' && input.name ? input.name : null,
    };
  }
  throw Object.assign(new TypeError('Expected Uint8Array, ArrayBuffer, Blob, or File'), { code: 'MEDIA_INPUT_INVALID' });
}

/**
 * Store media bytes via Chronolog's unified lazy-pull content pipe (`session.content.put`).
 * Returns a compact JSON-serializable `MediaRef` safe to store in `chronolog-db` or CRDT state.
 */
export async function putMedia(session, input, {
  visibility,
  deduplicate = true,
  mediaType,
  name,
  pin = false,
  signal,
} = {}) {
  if (typeof session?.content?.put !== 'function') {
    throw Object.assign(new Error('Session does not expose unified session.content.put'), { code: 'CONTENT_UNSUPPORTED' });
  }
  const effectiveVisibility = visibility ?? (session?.genesis?.privateLog === false ? 'public' : 'private');
  let ref, byteLength, effectiveType, effectiveName;
  if (typeof Blob !== 'undefined' && input instanceof Blob && typeof input.stream === 'function' && typeof session.content.putStream === 'function') {
    effectiveType = mediaType || input.type || 'application/octet-stream';
    effectiveName = name ?? (typeof input.name === 'string' && input.name ? input.name : undefined);
    byteLength = input.size;
    ref = await session.content.putStream(input.stream(), {
      visibility: effectiveVisibility,
      deduplicate,
      mediaType: effectiveType,
      ...(signal ? { signal } : {}),
    });
  } else {
    const normalized = await normalizeInputBytes(input, mediaType ?? 'application/octet-stream');
    effectiveType = mediaType || normalized.mediaType || 'application/octet-stream';
    effectiveName = name ?? normalized.name ?? undefined;
    byteLength = normalized.bytes.byteLength;
    ref = await session.content.put(normalized.bytes, {
      visibility: effectiveVisibility,
      deduplicate,
      mediaType: effectiveType,
      ...(signal ? { signal } : {}),
    });
  }
  if (pin && typeof session.content.pin === 'function') {
    await session.content.pin(ref);
  }
  return Object.freeze({
    v: 1,
    visibility: effectiveVisibility,
    mediaType: effectiveType,
    bytes: byteLength,
    ...(effectiveName ? { name: effectiveName } : {}),
    ref,
  });
}

/** Stream chunks of a `MediaRef`, `BlobReference`, or 64-hex SHA-256 hash without buffering the full payload in RAM. */
export function readMediaStream(session, mediaRefOrTarget, options = {}) {
  const target = mediaRefOrTarget && typeof mediaRefOrTarget === 'object' && mediaRefOrTarget.v === 1 && mediaRefOrTarget.ref
    ? mediaRefOrTarget.ref
    : mediaRefOrTarget;
  return session.content.readStream(target, options);
}

/** Pin a media reference in the local content cache so LRU pruning never evicts it. */
export function pinMedia(session, mediaRefOrTarget) {
  const target = mediaRefOrTarget?.v === 1 ? mediaRefOrTarget.ref : mediaRefOrTarget;
  return session.content.pin(target);
}

/** Unpin a previously pinned media reference. */
export function unpinMedia(session, mediaRefOrTarget) {
  const target = mediaRefOrTarget?.v === 1 ? mediaRefOrTarget.ref : mediaRefOrTarget;
  return session.content.unpin(target);
}

/** Prune unpinned local content cache entries down to `maxBytes`. */
export function pruneMediaCache(session, options) {
  return session.content.pruneCache(options);
}

/**
 * Resolve a `MediaRef`, raw `BlobReference`, or 64-hex SHA-256 hash into verified bytes,
 * reading from local cache first and lazily pulling chunks from connected P2P peers on miss.
 */
export async function getMediaBytes(session, mediaRefOrTarget, { signal, cache = true } = {}) {
  if (typeof session?.content?.get !== 'function') {
    throw Object.assign(new Error('Session does not expose unified session.content.get'), { code: 'CONTENT_UNSUPPORTED' });
  }
  const target = mediaRefOrTarget && typeof mediaRefOrTarget === 'object' && mediaRefOrTarget.v === 1 && mediaRefOrTarget.ref
    ? mediaRefOrTarget.ref
    : mediaRefOrTarget;
  if (!target || (typeof target === 'string' && !HEX_SHA256.test(target))) {
    throw Object.assign(new Error('Invalid media reference or SHA-256 hash'), { code: 'MEDIA_REF_INVALID' });
  }
  return session.content.get(target, {
    cache,
    ...(signal ? { signal } : {}),
  });
}

function mediaCacheKey(mediaRef) {
  const ref = mediaRef?.v === 1 ? mediaRef.ref : mediaRef;
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object') return String(ref.hash ?? ref.id ?? JSON.stringify(ref));
  return String(ref);
}

/**
 * Managed LRU cache of `blob:` ObjectURLs backed by lazy `getMediaBytes`, ensuring
 * ObjectURLs are deterministically revoked on eviction or component teardown.
 */
export function createMediaUrlCache(session, { maxEntries = 64 } = {}) {
  const cap = Math.max(1, Math.min(512, Number(maxEntries) || 64));
  const urls = new Map();
  const inflight = new Map();
  let closed = false;

  const revokeUrl = url => {
    try { URL.revokeObjectURL(url); } catch {}
  };

  async function resolve(mediaRef, { signal } = {}) {
    if (closed) throw Object.assign(new Error('Media cache closed'), { code: 'MEDIA_CACHE_CLOSED' });
    const key = mediaCacheKey(mediaRef);
    const existing = urls.get(key);
    if (existing) {
      urls.delete(key);
      urls.set(key, existing);
      return existing;
    }
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      const bytes = await getMediaBytes(session, mediaRef, { signal });
      if (bytes === null || closed) return null;
      const mime = mediaRef?.mediaType || mediaRef?.ref?.mediaType || 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (closed) { revokeUrl(url); return null; }
      while (urls.size >= cap) {
        const oldestKey = urls.keys().next().value;
        const oldestUrl = urls.get(oldestKey);
        urls.delete(oldestKey);
        if (oldestUrl) revokeUrl(oldestUrl);
      }
      urls.set(key, url);
      return url;
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  }

  function clear() {
    for (const url of urls.values()) revokeUrl(url);
    urls.clear();
  }

  return Object.freeze({
    resolve,
    size: () => urls.size,
    clear,
    destroy() { closed = true; clear(); },
  });
}

/**
 * Lightweight accessible attachment/media gallery widget using `putMedia` and `createMediaUrlCache`.
 */
export function mountMediaGallery({
  root,
  session,
  refs = [],
  onUpload,
  onRemove,
  accept = 'image/*,application/pdf,audio/*,text/plain',
  visibility,
} = {}) {
  if (!root || !session) return { update() {}, destroy() {} };
  const cache = createMediaUrlCache(session);
  const wrap = document.createElement('section');
  wrap.className = 'tm-gallery';
  const controls = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const list = document.createElement('div');
  controls.append(input);
  wrap.append(controls, status, list);
  root.append(wrap);

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.textContent = `Storing ${file.name} locally (${Math.ceil(file.size / 1024)} KiB)…`;
    try {
      const mediaRef = await putMedia(session, file, { visibility, name: file.name, mediaType: file.type || 'application/octet-stream' });
      status.textContent = `Stored ${file.name} (${mediaRef.visibility === 'private' ? 'encrypted P2P' : 'public hash-addressed P2P'}).`;
      await onUpload?.(mediaRef);
    } catch (err) {
      status.textContent = `Upload failed: ${err?.message ?? String(err)}`;
    } finally {
      input.value = '';
    }
  });

  async function render(nextRefs) {
    const items = Array.isArray(nextRefs) ? nextRefs : [];
    const frag = document.createDocumentFragment();
    for (const ref of items) {
      const card = document.createElement('article');
      const title = document.createElement('strong');
      title.textContent = ref.name || mediaCacheKey(ref).slice(0, 16);
      const meta = document.createElement('small');
      meta.textContent = ` · ${ref.visibility === 'private' ? 'Encrypted P2P' : 'Public P2P'} · ${Math.ceil((ref.bytes ?? 0) / 1024)} KiB`;
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.textContent = 'Load';
      const preview = document.createElement('div');
      loadBtn.onclick = async () => {
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading…';
        try {
          const url = await cache.resolve(ref);
          if (!url) { preview.textContent = 'Not currently cached locally or on connected peers.'; return; }
          if (String(ref.mediaType ?? '').startsWith('image/')) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = ref.name || 'Attachment';
            img.style.maxWidth = '100%';
            preview.replaceChildren(img);
          } else {
            const a = document.createElement('a');
            a.href = url;
            a.download = ref.name || 'attachment';
            a.textContent = `Download ${ref.name || 'attachment'}`;
            preview.replaceChildren(a);
          }
          loadBtn.hidden = true;
        } catch (err) {
          preview.textContent = err?.message ?? String(err);
          loadBtn.disabled = false;
          loadBtn.textContent = 'Retry';
        }
      };
      card.append(title, meta, loadBtn);
      if (typeof onRemove === 'function') {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = 'Remove';
        rm.onclick = () => void onRemove(ref);
        card.append(rm);
      }
      card.append(preview);
      frag.append(card);
    }
    list.replaceChildren(frag);
  }

  void render(refs);
  return Object.freeze({
    element: wrap,
    update: render,
    destroy() { cache.destroy(); wrap.remove(); },
  });
}
