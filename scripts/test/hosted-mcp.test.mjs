import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bytesToHex,
  createApplicationSession,
  defineApplication,
  defineCommand,
  defineQuery,
  encryptedEnvelopeDigest,
  hexToBytes,
  openApplicationDevice,
} from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { composeOwnerExtensions, createAdmission, deviceWrapKey, openPageGenesis } from '../../session/admission.mjs';
import { createAdmissionHost } from './helpers/admission-host.mjs';
import {
  connectHostedMcpGrant,
  enableHostedMcp,
  hostedMcpExtensions,
  sealHostedKeys,
  syncHostedMcpEnvelopes,
} from '../../docs/tutorial/shared/helpers/hosted-mcp.mjs';

class MemoryStore {
  #map = new Map();
  async get(k) { return this.#map.get(k)?.slice() ?? null; }
  async put(k, v) { this.#map.set(k, v.slice()); }
  async delete(k) { this.#map.delete(k); }
  async entries() { return [...this.#map.entries()].map(([key, value]) => ({ key, value: value.slice() })); }
}

function unbase64url(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const NOTES_REDUCER = `
export default {
  reduce(state, tx) {
    const list = Array.isArray(state?.notes) ? state.notes.concat([tx.payload]) : [tx.payload];
    return { ok: true, state: { notes: list }, events: [{ topic: 'note', payload: tx.payload }] };
  },
  query(state) { return Array.isArray(state?.notes) ? state.notes : []; },
};
`;

const definition = defineApplication({
  id: 'hosted-mcp-helper-test',
  version: '1',
  commands: {
    putNote: defineCommand({
      description: 'Store a note',
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      prepare: ({ text }) => [{ topic: 'notes', input: { text } }],
    }),
  },
  queries: {
    notes: defineQuery({
      description: 'Read notes',
      input: { type: 'null' },
      read: view => view.readEvents({ topics: ['note'] }).events.map(e => e.payload.text),
    }),
  },
});

async function openFixture(t) {
  const host = await createAdmissionHost();
  const peers = host.client({ account: { accountId: 'acct_owner', email: 'owner@example.test' } });
  const device = await openApplicationDevice({ store: new MemoryStore(), create: true });
  const wrapKey = await deviceWrapKey(device.store);
  const opened = await openPageGenesis({
    store: device.store,
    identity: device.identity,
    wrapKey,
    peers,
    imports: { 'app/notes': NOTES_REDUCER },
    topics: { notes: { module: 'app/notes', initialState: { notes: [] } } },
  });
  const session = await createApplicationSession({
    device,
    definition,
    genesis: opened.genesisBytes,
    casNodes: opened.casNodes,
    epochKeys: new Map([[0, opened.epoch0Key]]),
  });
  const admission = createAdmission(session, { peers, wrapKey, store: device.store, memberIntervalMs: 60_000 });
  const owner = createApplicationOwner(session, {
    extensions: composeOwnerExtensions(admission.extensions, hostedMcpExtensions({ session, admission })),
  });
  const channel = new MessageChannel();
  owner.attach(channel.port1);
  const page = await connectApplicationOwner(channel.port2, { applicationId: opened.logId });
  t.after(async () => {
    await page.detach().catch(() => {});
    admission.close();
    await owner.close();
    channel.port1.close();
    channel.port2.close();
  });
  return { appId: opened.logId, opened, session, page, peers, host, admission, epochKey: opened.epoch0Key };
}

test('connectHostedMcpGrant adds a revocable identity through the owner and X25519-seals epoch keys; the page never sees them', async t => {
  const f = await openFixture(t);
  const wrapPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const wrapPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', wrapPair.publicKey));
  const wrapPubHex = bytesToHex(wrapPubRaw);

  let postedConnect = null;
  let syncCalls = 0;
  let refreshed = 0;
  const runtime = {
    identity: { page: 'pg1234567890', base: 'https://page.example/p/' },
    application: { id: f.appId },
    agents: { async refresh() { refreshed++; } },
  };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('_tendril/mcp/connect')) {
      postedConnect = JSON.parse(init.body);
      return new Response(JSON.stringify({ connected: true, grant_id: postedConnect.grantId }), { status: 201 });
    }
    if (String(url).endsWith('_tendril/mcp/sync')) {
      syncCalls++;
      return new Response(JSON.stringify({ stored: 0, envelopes: [] }), { status: 200 });
    }
    throw Error('Unexpected URL: ' + url);
  };

  await connectHostedMcpGrant({
    runtime,
    session: f.page,
    peers: f.peers,
    grantId: 'og_test_grant',
    wrapPublicKey: wrapPubHex,
    handle: 'chatgpt',
    bio: 'Hosted notes helper',
    label: 'Notes',
    fetchImpl,
  });

  assert.ok(postedConnect, 'connect payload posted');
  assert.equal(postedConnect.grantId, 'og_test_grant');
  assert.equal(postedConnect.handle, 'chatgpt');
  assert.match(postedConnect.publicKey, /^[a-f0-9]{64}$/u);
  assert.equal(refreshed, 1);
  assert.equal(syncCalls, 1);

  // Decrypt using the OAuth grant's X25519 private key and verify exact AAD + epoch key match
  const sealedEnvelope = JSON.parse(new TextDecoder().decode(unbase64url(postedConnect.wrappedKeysBase64)));
  assert.equal(sealedEnvelope.v, 1);
  const epkBytes = hexToBytes(sealedEnvelope.epk);
  const epkKey = await crypto.subtle.importKey('raw', epkBytes, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: epkKey }, wrapPair.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(epkBytes, 0);
  salt.set(wrapPubRaw, 32);
  const aad = new TextEncoder().encode(`tendriller-mcp-keys-v1:pg1234567890:${f.appId}:og_test_grant`);
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: aad }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unbase64url(sealedEnvelope.iv), additionalData: aad },
    aesKey,
    unbase64url(sealedEnvelope.ct),
  );
  const material = JSON.parse(new TextDecoder().decode(plain));
  assert.equal(material.signingPublicKey, postedConnect.publicKey);
  assert.match(material.signingSeedHex, /^[a-f0-9]{96}$/u);
  assert.equal(material.epochKeys['0'], bytesToHex(f.epochKey));
  // The hosted identity is an ordinary administrator-signed member, visible on both session and blind host.
  const added = f.session.member(postedConnect.publicKey);
  assert.deepEqual([added.reader, added.writer, added.administrator], [true, true, false]);
  assert.ok(f.host.state.control.permissions.members.some(m => m.publicKey === postedConnect.publicKey));
});

test('syncHostedMcpEnvelopes and enableHostedMcp exchange blind encrypted envelopes across sessions without plaintext', async t => {
  const f = await openFixture(t);
  const op1 = await f.session.command('putNote', { text: 'From browser' }, { operationId: 'op-browser-1' });
  await op1.materialized({ signal: AbortSignal.timeout(5000) });

  // Simulate DO mcp_store retaining blind encrypted v2 envelopes keyed by encryptedEnvelopeDigest
  const doStore = new Map();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('_tendril/mcp/sync')) {
      const body = JSON.parse(init.body);
      for (const b64 of body.envelopes) {
        const raw = unbase64url(b64);
        const digest = bytesToHex(encryptedEnvelopeDigest(raw));
        doStore.set(digest, b64);
      }
      const known = new Set(body.knownIds);
      const missing = [...doStore.entries()].filter(([id]) => !known.has(id)).map(([digest, envelopeBase64]) => ({ digest, envelopeBase64 }));
      return new Response(JSON.stringify({ stored: body.envelopes.length, envelopes: missing }), { status: 200 });
    }
    throw Error('Unexpected URL: ' + url);
  };

  // Push browser envelope to DO store
  const push = await syncHostedMcpEnvelopes({ base: 'https://page.example/p/', session: f.session, fetchImpl });
  assert.equal(push.supported, true);
  assert.equal(push.uploaded, 1);
  assert.equal(push.merged, 0);
  assert.equal(doStore.size, 1);
  assert.equal([...doStore.values()].join('').includes('From browser'), false, 'DO store holds ciphertext only');

  // Second device/session (simulating hosted MCP) writes an op and pushes to DO store
  const peerDevice = await openApplicationDevice({ store: new MemoryStore(), create: true });
  await f.admission.call('admission.addKey', peerDevice.identity.publicKey, null, { writer: true });
  const exported = await f.session.exportFacts({ includePrivateCas: false });
  const peerSession = await createApplicationSession({
    device: peerDevice,
    definition,
    genesis: f.opened.genesisBytes,
    casNodes: f.opened.casNodes,
    epochKeys: new Map([[0, f.epochKey]]),
  });
  await peerSession.mergeFacts({ publicOps: exported.publicOps, encryptedEnvelopes: [], casNodes: [], retentions: [], checkpoints: [] });
  t.after(() => peerSession.close());
  const op2 = await peerSession.command('putNote', { text: 'From hosted MCP' }, { operationId: 'op-mcp-1' });
  await op2.materialized({ signal: AbortSignal.timeout(5000) });
  await syncHostedMcpEnvelopes({ base: 'https://page.example/p/', session: peerSession, fetchImpl });
  assert.equal(doStore.size, 2);

  // Trigger enableHostedMcp via `mcp-sync` runtime event and verify browser merges hosted MCP's op!
  const listeners = new Map();
  let registeredConnector = null;
  const runtime = {
    identity: { page: 'pg1', base: 'https://page.example/p/' },
    application: { id: f.appId },
    on(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
      return () => set.delete(fn);
    },
    agents: {
      snapshot: () => ({ primary_agent_id: 'mcp:g1', agents: [{ id: 'mcp:g1', handle: 'chatgpt', kind: 'hosted-mcp' }] }),
      onChange: () => () => {},
      registerMcpConnector: fn => { registeredConnector = fn; return () => { registeredConnector = null; }; },
    },
  };
  const ctrl = enableHostedMcp({ runtime, session: f.session, peers: f.peers, fetchImpl });
  t.after(() => ctrl.close());
  assert.equal(typeof registeredConnector, 'function');
  for (const fn of listeners.get('mcp-sync') ?? []) fn({ type: 'mcp-sync', version: 1 });
  await ctrl.syncNow();
  const notes = (await f.session.query('notes', null)).value;
  assert.deepEqual(notes.sort(), ['From browser', 'From hosted MCP']);
  assert.equal(typeof sealHostedKeys, 'function');
});
