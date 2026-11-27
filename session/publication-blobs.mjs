// Historical publication blob retention and Chronolog P2P recovery.
// When the host prunes older publication versions to save storage, retained
// SignedPublication manifests remain verifiable and any connected Chronolog peer
// that still holds a blob can serve its exact SHA-256 verified bytes over P2P.

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

async function verifyAsset(file, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.hash) {
    throw Object.assign(new Error(`Publication asset verification failed for ${file.path ?? file.hash}`), {
      code: 'PUBLICATION_ASSET_INVALID',
    });
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string') throw new TypeError('Expected base64 string');
  if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(value, 'base64'));
  const binary = atob(value);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return decodeBase64(value);
  throw new TypeError('Expected Uint8Array, ArrayBuffer, or base64 string');
}

function checkFile(file) {
  if (!file || typeof file !== 'object' || typeof file.hash !== 'string' || !HEX_SHA256.test(file.hash) ||
      !Number.isSafeInteger(file.size) || file.size < 0) {
    throw Object.assign(new Error('Invalid publication file descriptor'), { code: 'PUBLICATION_FILE_INVALID' });
  }
}

/**
 * Retain verified publication asset blobs in the local Chronolog session store
 * via the unified lazy public blob pipe (`session.content.put` + `pin`)
 * so connected peers can recover historical versions if the host later prunes them.
 */
export async function retainPublicationBlobs(session, assets, { pin = true, signal } = {}) {
  if (typeof session?.content?.put !== 'function') {
    return { supported: false, retained: 0, skipped: Array.isArray(assets) ? assets.length : 0 };
  }
  const seen = new Set();
  let retained = 0, skipped = 0;
  for (const asset of assets ?? []) {
    signal?.throwIfAborted();
    if (!asset || typeof asset.hash !== 'string' || !HEX_SHA256.test(asset.hash) || seen.has(asset.hash)) {
      skipped++;
      continue;
    }
    seen.add(asset.hash);
    const bytes = toBytes(asset.bytes);
    if (await sha256Hex(bytes) !== asset.hash) {
      throw Object.assign(new Error(`Publication asset hash mismatch for ${asset.hash}`), { code: 'PUBLICATION_HASH_MISMATCH' });
    }
    const info = await session.content.put(bytes, {
      visibility: 'public',
      ...(typeof asset.type === 'string' && asset.type.length > 0 ? { mediaType: asset.type } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    if (info.hash !== asset.hash) {
      throw Object.assign(new Error(`Publication asset hash mismatch for ${asset.hash}`), { code: 'PUBLICATION_HASH_MISMATCH' });
    }
    if (pin && typeof session.content.pin === 'function') {
      await session.content.pin(info).catch(() => {});
    }
    retained++;
  }
  return { supported: true, retained, skipped };
}

async function resolveHostBytes(fetchHost, file, signal) {
  if (typeof fetchHost !== 'function') return null;
  const result = await fetchHost(file, { signal });
  if (result === null || result === undefined) return null;
  if (typeof Response === 'function' && result instanceof Response) {
    if (result.status === 404 || result.status === 410) return null;
    if (!result.ok) {
      throw Object.assign(new Error(`Host asset fetch failed with HTTP ${result.status}`), {
        code: 'HOST_ASSET_FETCH_FAILED',
        status: result.status,
      });
    }
    return new Uint8Array(await result.arrayBuffer());
  }
  return toBytes(result);
}

/**
 * Fetch one verified publication asset: try the host first (when `fetchHost` is
 * supplied), and on 404/miss fall back to connected Chronolog peers by SHA-256 hash.
 * Every byte returned is cryptographically verified against the signed manifest entry.
 */
export async function recoverPublicationAsset(session, file, options = {}) {
  checkFile(file);
  const { fetchHost, signal, cache = true, seedFromHost = false } = options;
  signal?.throwIfAborted();

  const hostBytes = await resolveHostBytes(fetchHost, file, signal);
  if (hostBytes !== null) {
    await verifyAsset(file, hostBytes);
    if (seedFromHost) {
      try {
        if (typeof session?.content?.put === 'function') {
          const info = await session.content.put(hostBytes, {
            visibility: 'public',
            ...(typeof file.type === 'string' && file.type.length > 0 ? { mediaType: file.type } : {}),
            ...(signal === undefined ? {} : { signal }),
          });
          if (typeof session.content.pin === 'function') await session.content.pin(info).catch(() => {});
        }
      } catch { /* Best-effort local seeding never blocks reads. */ }
    }
    return { source: 'host', bytes: hostBytes };
  }

  if (typeof session?.content?.get !== 'function') return null;
  const peerBytes = await session.content.get(file.hash, {
    expectedBytes: file.size,
    cache,
    ...(signal === undefined ? {} : { signal }),
  });
  if (peerBytes === null) return null;
  await verifyAsset(file, peerBytes);
  return { source: 'peer', bytes: peerBytes };
}

/**
 * Recover all unique asset blobs referenced by a SignedPublication manifest,
 * trying the host first and transparently falling back to Chronolog P2P peers
 * for any assets the host has pruned.
 */
export async function recoverPublication(session, publication, options = {}) {
  const manifestFiles = publication?.payload?.files;
  if (!Array.isArray(manifestFiles)) {
    throw Object.assign(new Error('Expected a SignedPublication with payload.files'), { code: 'PUBLICATION_INVALID' });
  }
  const uniqueByHash = new Map();
  for (const file of manifestFiles) {
    checkFile(file);
    if (!uniqueByHash.has(file.hash)) uniqueByHash.set(file.hash, file);
  }

  const recoveredByHash = new Map();
  const missing = [];
  let fromHost = 0, fromPeers = 0;

  for (const [hash, file] of uniqueByHash) {
    options.signal?.throwIfAborted();
    const found = await recoverPublicationAsset(session, file, options);
    if (found === null) {
      missing.push(file);
      continue;
    }
    recoveredByHash.set(hash, found);
    if (found.source === 'host') fromHost++;
    else fromPeers++;
  }

  const assets = new Map();
  for (const [hash, entry] of recoveredByHash) assets.set(hash, entry.bytes);

  const files = [];
  for (const file of manifestFiles) {
    const entry = recoveredByHash.get(file.hash);
    if (entry !== undefined) {
      files.push({
        path: file.path,
        hash: file.hash,
        size: file.size,
        type: file.type,
        source: entry.source,
        bytes: entry.bytes,
      });
    }
  }

  return {
    complete: missing.length === 0,
    assets,
    files,
    missing,
    fromHost,
    fromPeers,
  };
}

function collectContentRefs(value, out, depth = 0) {
  if (depth > 8 || value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectContentRefs(item, out, depth + 1);
    return;
  }
  if (value.profile === 'authored-content-v1' && typeof value.id === 'string' && HEX_SHA256.test(value.id)) {
    out.set(`priv:${value.id}`, value);
    return;
  }
  if (value.profile === 'chronolog-blob-v2' && typeof value.hash === 'string' && HEX_SHA256.test(value.hash)) {
    out.set(`pub:${value.hash}`, value);
    return;
  }
  for (const v of Object.values(value)) collectContentRefs(v, out, depth + 1);
}

/**
 * Proactively fetch and pin recent `session.content` references observed in materialized
 * topics and events (e.g. inside `tendril agent run`) under a bounded cache budget, so mobile
 * or offline uploads remain recoverable from the user's always-on agent even after the uploader
 * goes offline.
 */
export function attachAgentContentPinner(session, {
  maxBytes = 128 * 1024 * 1024,
  maxRefsPerScan = 32,
  signal,
} = {}) {
  if (!session || typeof session.content?.get !== 'function' || typeof session.content?.pin !== 'function') {
    return Object.freeze({ scanNow: async () => ({ pinned: 0 }), close() {} });
  }
  const pinnedKeys = new Set();
  let inFlight = null;
  let queued = false;
  let closed = false;

  const scanNow = () => {
    if (closed || signal?.aborted) return Promise.resolve({ pinned: 0 });
    if (inFlight) { queued = true; return inFlight; }
    inFlight = (async () => {
      let pinned = 0;
      const refs = new Map();
      try {
        const reducers = session.topic?.('$reducers');
        const topicNames = Object.keys(reducers?.topics ?? {}).filter(name => !name.startsWith('$'));
        for (const name of topicNames) collectContentRefs(session.topic?.(name), refs);
        if (typeof session.readEvents === 'function') {
          const batch = await session.readEvents({ limit: 64 }).catch(() => null);
          for (const ev of batch?.events ?? []) collectContentRefs(ev.payload, refs);
        }
        let processed = 0;
        for (const [key, ref] of refs) {
          if (closed || signal?.aborted || processed >= maxRefsPerScan) break;
          if (pinnedKeys.has(key)) continue;
          processed++;
          const bytes = await session.content.get(ref, { cache: true, ...(signal ? { signal } : {}) }).catch(() => null);
          if (bytes !== null) {
            await session.content.pin(ref).catch(() => {});
            pinnedKeys.add(key);
            pinned++;
          }
        }
        if (typeof session.content.pruneCache === 'function' && Number.isFinite(maxBytes) && maxBytes > 0) {
          await session.content.pruneCache({ maxBytes }).catch(() => {});
        }
      } catch { /* best-effort background pinner */ }
      return { pinned };
    })().finally(() => {
      inFlight = null;
      if (queued && !closed && !signal?.aborted) { queued = false; void scanNow(); }
    });
    return inFlight;
  };

  const offChange = typeof session.onChange === 'function' ? session.onChange(() => { void scanNow(); }) : () => {};
  const offPeer = typeof session.onPeerLink === 'function' ? session.onPeerLink(ev => { if (ev?.type === 'connected') void scanNow(); }) : () => {};
  void scanNow();

  const close = () => { closed = true; offChange(); offPeer(); };
  signal?.addEventListener('abort', close, { once: true });
  return Object.freeze({ scanNow, close });
}
