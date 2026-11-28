// Browser-side helper for opt-in Hosted MCP (OAuth-token-wrapped X25519 keys)
// and blind encrypted Chronolog envelope sync (`_tendril/mcp/*`).
//
// Zero plaintext keys ever touch the Tendriller host or the page: the owner Worker
// (an administrator device) generates a revocable Ed25519 identity, signs its
// membership grant, X25519-seals it with every epoch key to the OAuth grant's
// `wrap_public_key`, and discards the ephemeral identity.
// The page imports `enableHostedMcp` at boot, but the Chronolog primitives are only
// needed when sealing or syncing (normally inside the Worker). Loading them lazily
// keeps the full peer-session/QuickJS graph out of the page's critical bundle.
const chronolog = () => import('@chronolog/peer-session');

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function asBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Seal `{ signingSeedHex, signingPublicKey, epochKeys }` to an OAuth grant's X25519
 * `wrap_public_key` using the exact HKDF-SHA256 + AES-256-GCM envelope verified by
 * `server/src/mcp-crypto.ts`.
 */
export async function sealHostedKeys(wrapPublicKeyHex, material, aadContext) {
  const { bytesToHex, hexToBytes } = await chronolog();
  const recipientPubBytes = hexToBytes(wrapPublicKeyHex);
  const recipientPub = await crypto.subtle.importKey('raw', asBuffer(recipientPubBytes), { name: 'X25519' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeralPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: recipientPub }, ephemeral.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(ephemeralPubBytes, 0);
  salt.set(recipientPubBytes, 32);
  const aad = encoder.encode(`tendriller-mcp-keys-v1:${aadContext}`);
  const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: asBuffer(aad) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(material));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad) },
    aesKey,
    asBuffer(plaintext),
  ));
  return encoder.encode(JSON.stringify({
    v: 1,
    epk: bytesToHex(ephemeralPubBytes),
    iv: base64url(iv),
    ct: base64url(ciphertext),
  }));
}

/**
 * Owner-side half of hosted MCP opt-in, composed beside device admission in the
 * page Worker: an administrator device adds a fresh revocable hosted identity to
 * signed membership and seals that identity plus every epoch key to the OAuth
 * grant's wrap key. Plaintext keys never reach the page or the host.
 */
export function hostedMcpExtensions({ session, admission, base = null, fetchImpl = globalThis.fetch }) {
  const uploadedIds = new Set();
  return Object.freeze({
    async call(name, args) {
      if (name === 'hosted.sync') {
        const [{ base: callBase } = {}] = args ?? [];
        const targetBase = callBase ?? base;
        if (!targetBase) return { supported: false, uploaded: 0, merged: 0 };
        return syncHostedMcpEnvelopes({ base: targetBase, session, uploadedIds, fetchImpl });
      }
      if (name !== 'hosted.seal') throw Object.assign(Error('EXTENSION_UNKNOWN'), { code: 'EXTENSION_UNKNOWN' });
      const [{ wrapPublicKey, aad, writer = true }] = args;
      if (!/^[0-9a-f]{64}$/u.test(wrapPublicKey ?? '') || typeof aad !== 'string' || !aad) throw Error('HOSTED_MCP_INPUT_INVALID');
      const { bytesToHex, createSigningIdentity, exportSigningIdentity } = await chronolog();
      const hostedIdentity = await createSigningIdentity(), exported = await exportSigningIdentity(hostedIdentity);
      await admission.call('admission.addKey', hostedIdentity.publicKey, null, { writer });
      const epochKeys = {};
      if (typeof session.exportEpochKeys === 'function') {
        for (const [ep, keyBytes] of session.exportEpochKeys()) epochKeys[String(ep)] = bytesToHex(keyBytes);
      }
      const sealed = await sealHostedKeys(wrapPublicKey, { signingSeedHex: exported.privateKey, signingPublicKey: exported.publicKey, epochKeys }, aad);
      return { publicKey: exported.publicKey, wrappedKeysBase64: base64url(sealed) };
    },
  });
}

/**
 * Opt this page into hosted MCP for an active OAuth grant.
 * Seals a fresh revocable Ed25519 identity + current epoch keys to `grant.wrap_public_key`.
 */
export async function connectHostedMcpGrant({
  runtime = globalThis.window?.tendril,
  session,
  peers,
  grantId,
  wrapPublicKey,
  handle,
  bio = 'Hosted MCP assistant',
  label,
  capabilities,
  writer = true,
  fetchImpl = globalThis.fetch,
}) {
  if (!runtime?.identity?.base || !runtime?.identity?.page) throw Error('Tendriller runtime identity is required');
  if (!session?.extensions) throw Error('An attached Chronolog owner session with extensions is required');
  if (!grantId || !wrapPublicKey) throw Error('OAuth grantId and wrapPublicKey are required');
  const applicationId = session.applicationId ?? runtime.application?.id;
  if (!applicationId) throw Error('Application ID unavailable');

  // The page Worker (an administrator device) signs the membership grant and seals the keys.
  const aad = `${runtime.identity.page}:${applicationId}:${grantId}`;
  const exported = await session.extensions.call('hosted.seal', [{ grantId, wrapPublicKey, aad, writer }]);

  const res = await fetchImpl(`${runtime.identity.base}_tendril/mcp/connect`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantId,
      handle,
      bio,
      publicKey: exported.publicKey,
      wrappedKeysBase64: exported.wrappedKeysBase64,
      ...(label ? { label } : {}),
      ...(capabilities ? { capabilities } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Error(data?.error?.message || `Could not connect hosted MCP (${res.status})`);
  await runtime.agents?.refresh?.().catch(() => {});
  await syncHostedMcpEnvelopes({ base: runtime.identity.base, session, fetchImpl }).catch(() => {});
  return data;
}

/** Disconnect a hosted MCP grant from this page immediately. */
export async function disconnectHostedMcpGrant({
  runtime = globalThis.window?.tendril,
  grantId,
  fetchImpl = globalThis.fetch,
}) {
  if (!runtime?.identity?.base) throw Error('Tendriller runtime identity is required');
  const res = await fetchImpl(`${runtime.identity.base}_tendril/mcp/${encodeURIComponent(grantId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Error(data?.error?.message || `Could not disconnect hosted MCP (${res.status})`);
  await runtime.agents?.refresh?.().catch(() => {});
  return data;
}

/**
 * Exchange blind encrypted Chronolog envelopes with `_tendril/mcp/sync`.
 * Works with any session exposing `exportFacts()` and `mergeFacts()`.
 */
export async function syncHostedMcpEnvelopes({
  base,
  session,
  uploadedIds = new Set(),
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof session?.exportFacts !== 'function' || typeof session?.mergeFacts !== 'function') {
    return { supported: false, uploaded: 0, merged: 0 };
  }
  const { bytesToHex, encryptedEnvelopeDigest } = await chronolog();
  const facts = await session.exportFacts();
  const localEnvelopes = Array.isArray(facts?.encryptedEnvelopes) ? facts.encryptedEnvelopes : [];
  const knownIds = [];
  const outgoing = [];
  for (const raw of localEnvelopes) {
    const digest = bytesToHex(encryptedEnvelopeDigest(raw));
    knownIds.push(digest);
    if (!uploadedIds.has(digest) && outgoing.length < 256) {
      outgoing.push(base64url(raw));
    }
  }
  const res = await fetchImpl(`${base}_tendril/mcp/sync`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelopes: outgoing, knownIds }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    if (res.status === 409) return { supported: true, uploaded: 0, merged: 0 };
    const err = await res.json().catch(() => null);
    throw Error(err?.error?.message || `Hosted MCP envelope sync failed (${res.status})`);
  }
  for (const id of knownIds) uploadedIds.add(id);
  const data = await res.json();
  const incoming = [];
  for (const item of Array.isArray(data?.envelopes) ? data.envelopes : []) {
    if (typeof item?.envelopeBase64 === 'string') {
      try {
        incoming.push(unbase64url(item.envelopeBase64));
        if (typeof item.digest === 'string') uploadedIds.add(item.digest);
      } catch { /* ignore malformed envelope */ }
    }
  }
  if (incoming.length > 0) {
    await session.mergeFacts({ publicOps: [], encryptedEnvelopes: incoming, casNodes: [], retentions: [], checkpoints: [] });
  }
  return { supported: true, uploaded: outgoing.length, merged: incoming.length };
}

/**
 * Enable one-click Hosted MCP opt-in inside Page options → An agent AND
 * start reactive, zero-polling blind encrypted envelope sync.
 */
export function enableHostedMcp({
  runtime = globalThis.window?.tendril,
  session,
  peers,
  label,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (!runtime?.identity?.base || !session) return { syncNow: async () => ({ supported: false, uploaded: 0, merged: 0 }), close() {} };
  const stop = new AbortController();
  const lifetime = signal ? AbortSignal.any([stop.signal, signal]) : stop.signal;
  const uploadedIds = new Set();
  let timer = null;
  let inFlight = null;
  let queued = false;

  const hasHostedAgent = () => (runtime.agents?.snapshot?.()?.agents ?? []).some(a => a.kind === 'hosted-mcp');

  const syncNow = () => {
    if (lifetime.aborted) return Promise.resolve({ supported: false, uploaded: 0, merged: 0 });
    if (inFlight) { queued = true; return inFlight; }
    // Run envelope export/fetch/merge inside the Worker when available so large batches
    // never copy over main-thread Worker IPC; fall back to direct session calls in tests.
    const run = typeof session?.extensions?.call === 'function'
      ? session.extensions.call('hosted.sync', [{ base: runtime.identity.base }])
        .catch(err => err?.code === 'EXTENSION_UNKNOWN'
          ? syncHostedMcpEnvelopes({ base: runtime.identity.base, session, uploadedIds, signal: lifetime, fetchImpl })
          : Promise.reject(err))
      : syncHostedMcpEnvelopes({ base: runtime.identity.base, session, uploadedIds, signal: lifetime, fetchImpl });
    inFlight = run
      .catch(() => ({ supported: true, uploaded: 0, merged: 0 }))
      .finally(() => {
        inFlight = null;
        if (queued && !lifetime.aborted) {
          queued = false;
          void syncNow();
        }
      });
    return inFlight;
  };

  const scheduleSync = () => {
    if (lifetime.aborted || !hasHostedAgent()) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void syncNow(); }, 250);
  };

  const unregisterConnector = runtime.agents?.registerMcpConnector?.(async input => {
    const out = await connectHostedMcpGrant({
      runtime,
      session,
      peers,
      grantId: input.grantId,
      wrapPublicKey: input.wrapPublicKey,
      handle: input.handle,
      bio: input.bio,
      label: input.label ?? label,
      capabilities: input.capabilities,
      writer: input.writer,
      fetchImpl,
    });
    void syncNow();
    return out;
  }) ?? (() => {});

  const offChange = typeof session.onChange === 'function' ? session.onChange(() => scheduleSync()) : () => {};
  const offMcpPush = typeof runtime.on === 'function' ? runtime.on('mcp-sync', () => { void syncNow(); }) : () => {};
  const offAgents = runtime.agents?.onChange?.(() => { if (hasHostedAgent()) scheduleSync(); }) ?? (() => {});
  const onOnline = () => { if (hasHostedAgent()) void syncNow(); };
  globalThis.window?.addEventListener?.('online', onOnline);
  if (hasHostedAgent()) void syncNow();

  const close = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    stop.abort();
    unregisterConnector();
    offChange();
    offMcpPush();
    offAgents();
    globalThis.window?.removeEventListener?.('online', onOnline);
  };
  lifetime.addEventListener('abort', close, { once: true });
  return { syncNow, close };
}
