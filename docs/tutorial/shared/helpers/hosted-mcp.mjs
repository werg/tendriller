// Browser-side helper for opt-in Hosted MCP (OAuth-token-wrapped X25519 keys)
// and blind encrypted Chronolog envelope sync (`_tendril/mcp/*`).
//
// Zero plaintext keys ever touch the Tendriller host: the browser generates a
// revocable Ed25519 identity, grants it membership, extracts current epoch keys
// in RAM via Chronolog's standard provisioning protocol, X25519-seals them to
// the OAuth grant's `wrap_public_key`, and discards all ephemeral keys.
import {
  bytesToHex,
  createApplicationSession,
  createSigningIdentity,
  defineApplication,
  exportSigningIdentity,
  hexToBytes,
  openApplicationDevice,
} from '@chronolog/peer-session';
import { decodeRecord, encodeRecord, recordDigest, signEnrollmentRequest } from '@chronolog/authority';

const authorityBytes = value => {
  if (!value || typeof value !== 'object' || typeof value.record !== 'string' || !/^[0-9a-f]+$/iu.test(value.record) || value.record.length % 2 !== 0) {
    throw Error('AUTHORITY_RECORD_INVALID');
  }
  return hexToBytes(value.record);
};

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

class EphemeralStore {
  #map = new Map();
  async get(key) { return this.#map.get(key)?.slice() ?? null; }
  async put(key, value) { this.#map.set(key, value.slice()); }
  async delete(key) { this.#map.delete(key); }
  async initialize(entries) {
    for (const entry of entries) if (!this.#map.has(entry.key)) this.#map.set(entry.key, entry.value.slice());
  }
}

/**
 * Seal `{ signingSeedHex, signingPublicKey, epochKeys }` to an OAuth grant's X25519
 * `wrap_public_key` using the exact HKDF-SHA256 + AES-256-GCM envelope verified by
 * `server/src/mcp-crypto.ts`.
 */
export async function sealHostedKeys(wrapPublicKeyHex, material, aadContext) {
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
 * Grant a revocable hosted identity membership in Chronolog authority and extract
 * the page's current epoch keys strictly in RAM via standard Chronolog provisioning.
 */
async function provisionHostedIdentityInRam({ session, peers, hostedIdentity, writer = true }) {
  const metadata = await peers.application();
  let bundle = decodeRecord(authorityBytes(metadata.authority));
  const head = bundle.memberships.at(-1);
  const existing = head.payload.members.find(m => m.publicKey === hostedIdentity.publicKey);
  if (!existing?.reader || (writer && !existing?.writer)) {
    // The host grants membership only to a key that proved itself for this account: answer an
    // account-bound challenge with the fresh hosted identity before requesting its grant.
    const { applicationId } = bundle.descriptor.payload, { epoch, epochKeyDigest } = head.payload;
    const challenge = await peers.challenge(hostedIdentity.publicKey);
    const proof = await signEnrollmentRequest({ applicationId, publicKey: hostedIdentity.publicKey, challenge: challenge.challenge, epoch, epochKeyDigest }, hostedIdentity);
    await peers.enroll({ record: bytesToHex(encodeRecord(proof)) });
    const intent = {
      requestId: crypto.randomUUID(),
      expectedMembershipId: await recordDigest(head),
      authorTimeAfterMs: (BigInt(Date.now()) > head.payload.authorTimeAfterMs
        ? BigInt(Date.now())
        : head.payload.authorTimeAfterMs + 1n).toString(),
      grant: {
        publicKey: hostedIdentity.publicKey,
        reader: true,
        writer: Boolean(existing?.writer || writer),
        administrator: existing?.administrator ?? false,
        publisher: existing?.publisher ?? false,
        finalizer: existing?.finalizer ?? false,
      },
    };
    const result = await peers.grant(intent);
    bundle = decodeRecord(authorityBytes(result.authority));
  }
  await session.mergeAuthority(bundle);

  const memStore = new EphemeralStore();
  const tempDevice = await openApplicationDevice({ store: memStore, managedSigner: hostedIdentity, create: true });
  const tempSession = await createApplicationSession({
    device: tempDevice,
    definition: defineApplication({ id: 'tendriller-mcp-key-export', version: '1', commands: {}, queries: {} }),
    authority: bundle,
  });
  try {
    const req = await tempSession.provisioning.createProvisioningRequest();
    const pkg = await session.provisioning.exportProvisioning(req);
    await tempSession.provisioning.importProvisioning(pkg);
    const epochs = [...new Set(bundle.memberships.map(m => m.payload.epoch))];
    const epochKeys = {};
    for (const epoch of epochs) {
      const key = tempSession.authority.epochKey(epoch);
      if (!key) throw Error(`Missing epoch key ${epoch} for hosted MCP export`);
      epochKeys[String(epoch)] = bytesToHex(key);
    }
    return { bundle, epochKeys };
  } finally {
    await tempSession.close().catch(() => {});
  }
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
  if (!session || !peers) throw Error('Chronolog session and peers client are required');
  if (!grantId || !wrapPublicKey) throw Error('OAuth grantId and wrapPublicKey are required');
  const applicationId = session.applicationId ?? runtime.application?.id;
  if (!applicationId) throw Error('Application ID unavailable');

  const hostedIdentity = await createSigningIdentity();
  const exported = await exportSigningIdentity(hostedIdentity);
  const { epochKeys } = await provisionHostedIdentityInRam({ session, peers, hostedIdentity, writer });

  const aad = `${runtime.identity.page}:${applicationId}:${grantId}`;
  const sealed = await sealHostedKeys(wrapPublicKey, {
    signingSeedHex: exported.privateKey,
    signingPublicKey: exported.publicKey,
    epochKeys,
  }, aad);

  const res = await fetchImpl(`${runtime.identity.base}_tendril/mcp/connect`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantId,
      handle,
      bio,
      publicKey: exported.publicKey,
      wrappedKeysBase64: base64url(sealed),
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
  const facts = await session.exportFacts();
  const localEnvelopes = Array.isArray(facts?.envelopes) ? facts.envelopes : [];
  const knownIds = [];
  const outgoing = [];
  for (const env of localEnvelopes) {
    const id = env?.payload?.proposalId;
    if (typeof id !== 'string') continue;
    knownIds.push(id);
    if (!uploadedIds.has(id) && outgoing.length < 256) {
      outgoing.push(base64url(encodeRecord(env)));
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
        incoming.push(decodeRecord(unbase64url(item.envelopeBase64)));
        if (typeof item.proposalId === 'string') uploadedIds.add(item.proposalId);
      } catch { /* ignore malformed envelope */ }
    }
  }
  if (incoming.length > 0) {
    await session.mergeFacts({ envelopes: incoming, retentions: [], finality: [] });
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
    inFlight = syncHostedMcpEnvelopes({ base: runtime.identity.base, session, uploadedIds, signal: lifetime, fetchImpl })
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
