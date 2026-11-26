import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, eventExecutionManifest } from '@chronolog/peer-session';
import { openBrowserOwner, TAB_OWNER_PROTOCOL } from '../../session/browser.mjs';
import { serveBrowserOwner } from '../../session/worker.mjs';

const testDefinition = defineApplication({
  id: 'tendriller.call-room',
  version: '1',
  executionManifest: eventExecutionManifest(),
  commands: {},
  queries: {},
});

function createMockBrowserEnv() {
  const heldLocks = new Map(); // name -> { waiters: [] }
  const locks = {
    async request(name, optsOrCb, maybeCb) {
      const opts = typeof optsOrCb === 'function' ? {} : (optsOrCb ?? {});
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (heldLocks.has(name)) {
        if (opts.ifAvailable) return await cb(null);
        await new Promise(resolve => heldLocks.get(name).waiters.push(resolve));
      }
      const entry = { waiters: [] };
      heldLocks.set(name, entry);
      try {
        return await cb({ name });
      } finally {
        heldLocks.delete(name);
        const next = entry.waiters.shift();
        if (next) next();
      }
    },
  };

  const channels = new Map();
  class MockBroadcastChannel extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      let set = channels.get(name);
      if (!set) channels.set(name, set = new Set());
      set.add(this);
    }
    postMessage(data) {
      const copy = structuredClone(data);
      for (const peer of channels.get(this.name) ?? []) {
        if (peer !== this) queueMicrotask(() => peer.dispatchEvent(new MessageEvent('message', { data: copy })));
      }
    }
    close() { channels.get(this.name)?.delete(this); }
  }

  return { locks, MockBroadcastChannel };
}

test('single-active-tab lock auto-takes over for foreground tabs, respects hidden/opt-out, and hands over cleanly', async () => {
  const env = createMockBrowserEnv();
  const origNav = globalThis.navigator;
  const origLoc = globalThis.location;
  const origDoc = globalThis.document;
  const origBC = globalThis.BroadcastChannel;
  const origWorker = globalThis.Worker;

  // Wire a minimal in-process Worker pair backed by serveBrowserOwner + mock session.
  class MockWorker extends EventTarget {
    constructor() {
      super();
      this.terminated = false;
      const workerScope = new EventTarget();
      workerScope.postMessage = data => {
        if (!this.terminated) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: structuredClone(data) })));
      };
      this._scope = workerScope;
      this._server = serveBrowserOwner({
        scope: workerScope,
        profileId: 'profile-call-1',
        async openSession() {
          const lifetime = new AbortController();
          const fakeSession = {
            applicationId: 'a'.repeat(64),
            definition: testDefinition,
            identity: { publicKey: 'b'.repeat(64) },
            signal: lifetime.signal,
            status: { phase: 'ready', canAuthor: true, database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null },
            onStatus: () => () => {},
            onChange: () => () => {},
            operations: { get: async () => null, list: async () => [], retry: async () => { throw Error('none'); }, subscribe: async function* () {} },
            signals: { delivery: 'neighbors', send: async () => {}, subscribe: async function* () {} },
            content: { stage: async () => { throw Error('unused'); }, read: async () => { throw Error('unused'); } },
            provisioning: { createProvisioningRequest: async () => ({}), exportProvisioning: async () => ({}), importProvisioning: async () => {} },
            authority: { bundle: () => ({}) },
            async close() { lifetime.abort(); },
          };
          return { session: fakeSession, async close() { await fakeSession.close(); } };
        },
      });
    }
    postMessage(data) {
      if (!this.terminated) queueMicrotask(() => this._scope.dispatchEvent(new MessageEvent('message', { data: structuredClone(data) })));
    }
    terminate() {
      this.terminated = true;
      void this._server.close();
    }
  }

  let visibilityState = 'visible';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: env.locks } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://app.example/call/') });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { get visibilityState() { return visibilityState; }, addEventListener() {}, removeEventListener() {} } });
  globalThis.BroadcastChannel = env.MockBroadcastChannel;
  globalThis.Worker = MockWorker;

  try {
    let tab1Replaced = null;
    const tab1 = await openBrowserOwner({
      workerUrl: 'https://app.example/call/worker.mjs',
      profileId: 'profile-call-1',
      applicationId: 'a'.repeat(64),
      persistStorage: false,
      onOwnerReplaced: info => { tab1Replaced = info; },
    });
    assert.equal(tab1.mode, 'dedicated');
    assert.equal(typeof tab1.rtc.getPeer, 'function');
    assert.equal(typeof tab1.rtc.onPeer, 'function');
    assert.equal(TAB_OWNER_PROTOCOL, 'tendriller/tab-owner/v2');

    // Explicit takeover:false fails immediately with TAB_ACTIVE_ELSEWHERE and exposes takeover().
    let optOutError;
    try {
      await openBrowserOwner({
        workerUrl: 'https://app.example/call/worker.mjs',
        profileId: 'profile-call-1',
        applicationId: 'a'.repeat(64),
        persistStorage: false,
        takeover: false,
      });
    } catch (err) { optOutError = err; }
    assert.equal(optOutError?.code, 'TAB_ACTIVE_ELSEWHERE');
    assert.equal(typeof optOutError.takeover, 'function');
    assert.equal(tab1Replaced, null);

    // Default 'auto' in a hidden background tab must NOT steal from the active foreground tab.
    visibilityState = 'hidden';
    let hiddenError;
    try {
      await openBrowserOwner({
        workerUrl: 'https://app.example/call/worker.mjs',
        profileId: 'profile-call-1',
        applicationId: 'a'.repeat(64),
        persistStorage: false,
      });
    } catch (err) { hiddenError = err; }
    assert.equal(hiddenError?.code, 'TAB_ACTIVE_ELSEWHERE');
    assert.equal(tab1Replaced, null);

    // Default 'auto' in a visible foreground tab/PWA seamlessly takes over from Tab 1 -> Tab 2!
    visibilityState = 'visible';
    let tab2Replaced = null;
    const tab2 = await openBrowserOwner({
      workerUrl: 'https://app.example/call/worker.mjs',
      profileId: 'profile-call-1',
      applicationId: 'a'.repeat(64),
      persistStorage: false,
      onOwnerReplaced: info => { tab2Replaced = info; },
    });
    assert.equal(tab2.mode, 'dedicated');
    assert.equal(tab1Replaced?.reason, 'tab_takeover');

    // Calling optOutError.takeover() also hands off cleanly from Tab 2 -> Tab 3!
    const tab3 = await optOutError.takeover();
    assert.equal(tab3.mode, 'dedicated');
    assert.equal(tab2Replaced?.reason, 'tab_takeover');

    await tab3.detach();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: origLoc });
    if (origDoc === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    globalThis.BroadcastChannel = origBC;
    globalThis.Worker = origWorker;
  }
});
