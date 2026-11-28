import assert from 'node:assert/strict';
import test from 'node:test';
import { participateApplication } from '../../session/participation.mjs';

const NONCE = 'a1b2c3d4e5f6';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function harness({ syncControl } = {}) {
  const selfKey = '11'.repeat(32), sessionAbort = new AbortController();
  const host = { c: 3, a: 0, d: 5, m: 0 };
  const calls = { syncControl: 0, discover: 0, mailbox: 0 };
  const frames = [];
  let wake;
  const vector = () => `${NONCE}.${host.c}.${host.a}.${host.d}.${host.m}`;
  const push = frame => { frames.push(frame); wake?.(); };
  const peers = {
    async syncControl() { calls.syncControl++; await tick(); return { publicOps: [], casNodes: [], checkpoints: [], revision: `${NONCE}.${host.c}` }; },
    async syncMailbox() { calls.mailbox++; return { encryptedEnvelopes: [], publicOps: [], casNodes: [], revision: `${NONCE}.${host.m}` }; },
    async discover() { calls.discover++; await tick(); return { applicationId: 'app', peers: [], revision: `${NONCE}.${host.d}` }; },
    async advertise() { return { ok: true }; },
    async withdraw() { return { ok: true }; },
    watchDiscovery(_id, { signal }) {
      return { ready: Promise.resolve(), closed: Promise.resolve({ code: 1000, reason: '' }), close() {},
        notifications: { async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (frames.length) { yield frames.shift(); continue; }
            await new Promise(resolve => { wake = resolve; signal.addEventListener('abort', resolve, { once: true }); });
          }
        } } };
    },
    listenInvitations(_id, { signal }) {
      return { ready: Promise.resolve(), closed: Promise.resolve({ code: 1000, reason: '' }), close() {},
        invitations: { async *[Symbol.asyncIterator]() { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } } };
    },
    async invite() {}, rendezvous() { return { ready: new Promise(() => {}), close() {} }; }, relay() { throw new Error('unused'); },
  };
  const session = {
    identity: { publicKey: selfKey }, device: { storageId: 'self' }, signal: sessionAbort.signal,
    genesis: { privateLog: true }, isReader: () => false, onChange: () => () => {},
    async exportFacts() { return { encryptedEnvelopes: [], publicOps: [], casNodes: [] }; },
    async exportPublicControlFacts() { return { publicOps: [], casNodes: [] }; },
    async mergeFacts() {}, async connectPeer() { throw new Error('unused'); },
  };
  const notifications = [];
  const controller = participateApplication(session, {
    peers, ...(syncControl === undefined ? {} : { syncControl }), passiveDialDelayMs: 0,
    async openDirectConnection() { throw new Error('unused'); },
    onNotification: n => notifications.push(n),
  });
  return { host, calls, push, vector, notifications, close: () => { sessionAbort.abort(); return controller.close(); } };
}

test('boot reads each host scope once even when the first ready arrives mid-refresh', async () => {
  const h = harness();
  h.push({ type: 'ready', rev: h.vector() });
  await tick(); await tick(); await tick();
  assert.deepEqual(h.calls, { syncControl: 1, discover: 1, mailbox: 1 });
  assert.equal(h.notifications.length, 1);
  await h.close();
});

test('a pushed change re-reads only its scope; an unchanged vector costs nothing', async () => {
  const h = harness();
  await tick(); await tick(); await tick();
  const base = { ...h.calls };
  h.host.d++;
  h.push({ type: 'changed', rev: h.vector() });
  await tick(); await tick();
  assert.deepEqual(h.calls, { ...base, discover: base.discover + 1 });
  h.push({ type: 'changed', rev: h.vector() });
  await tick(); await tick();
  assert.deepEqual(h.calls, { ...base, discover: base.discover + 1 });
  h.host.c++;
  h.push({ type: 'changed', rev: h.vector() });
  await tick(); await tick(); await tick();
  assert.equal(h.calls.syncControl, base.syncControl + 1);
  assert.equal(h.calls.discover, base.discover + 1);
  // A notification without a vector (older host) still refreshes everything.
  h.push({ type: 'changed' });
  await tick(); await tick(); await tick();
  assert.equal(h.calls.discover, base.discover + 2);
  await h.close();
});

test('with control sync owned elsewhere, participation never syncs control', async () => {
  const h = harness({ syncControl: false });
  h.push({ type: 'ready', rev: h.vector() });
  await tick(); await tick(); await tick();
  h.host.c++;
  h.push({ type: 'changed', rev: h.vector() });
  await tick(); await tick();
  assert.equal(h.calls.syncControl, 0);
  assert.equal(h.calls.discover, 1);
  await h.close();
});
