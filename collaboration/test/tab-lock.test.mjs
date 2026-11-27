import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, describeApplication } from '@chronolog/peer-session';
import { openBrowserOwner, TAB_OWNER_PROTOCOL } from '../../session/browser.mjs';
import { serveBrowserOwner } from '../../session/worker.mjs';

const testDefinition = defineApplication({
  id: 'tendriller.multi-tab',
  version: '1',
  commands: {},
  queries: {},
});

function createMockBrowserEnv() {
  const heldLocks = new Map(); // name -> { release }
  const locks = {
    async request(name, optsOrCb, maybeCb) {
      const opts = typeof optsOrCb === 'function' ? {} : (optsOrCb ?? {});
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (heldLocks.has(name)) {
        if (opts.ifAvailable) return await cb(null);
        if (opts.steal) {
          const prev = heldLocks.get(name);
          heldLocks.delete(name);
          prev?.onStolen?.();
        } else {
          await new Promise(resolve => heldLocks.get(name).waiters.push(resolve));
        }
      }
      let stolen = false;
      const entry = { waiters: [], onStolen: () => { stolen = true; } };
      heldLocks.set(name, entry);
      try {
        return await cb({ name });
      } finally {
        if (!stolen && heldLocks.get(name) === entry) {
          heldLocks.delete(name);
          const next = entry.waiters.shift();
          if (next) next();
        }
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

test('multi-tab lock-free browser owners open concurrently over direct MessagePort and elect a stealable network leader', async () => {
  const env = createMockBrowserEnv();
  const origNav = globalThis.navigator;
  const origLoc = globalThis.location;
  const origDoc = globalThis.document;
  const origBC = globalThis.BroadcastChannel;
  const origWorker = globalThis.Worker;

  const networkRoles = [];
  const syncCalls = [];

  class MockWorker extends EventTarget {
    constructor() {
      super();
      this.terminated = false;
      const workerScope = new EventTarget();
      workerScope.postMessage = (data, transfer) => {
        if (!this.terminated) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: structuredClone(data), ports: transfer ?? [] })));
        }
      };
      this._scope = workerScope;
      const idx = networkRoles.length;
      networkRoles.push(null);
      syncCalls.push(0);
      this._server = serveBrowserOwner({
        scope: workerScope,
        profileId: 'profile-multi-1',
        async openSession() {
          const lifetime = new AbortController();
          const fakeSession = {
            applicationId: 'a'.repeat(64),
            definition: testDefinition,
            describe: async () => describeApplication(testDefinition),
            identity: { publicKey: 'b'.repeat(64) },
            signal: lifetime.signal,
            status: { phase: 'ready', canAuthor: true, database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null },
            onStatus: () => () => {},
            onChange: () => () => {},
            onFacts: () => () => {},
            syncFromStore: async () => { syncCalls[idx]++; return { applied: 0 }; },
            operations: { get: async () => null, list: async () => [], retry: async () => { throw Error('none'); }, subscribe: async function* () {} },
            signals: { delivery: 'neighbors', send: async () => {}, subscribe: async function* () {} },
            content: { stage: async () => { throw Error('unused'); }, read: async () => { throw Error('unused'); } },
            provisioning: { createProvisioningRequest: async () => ({}), exportProvisioning: async () => ({}), importProvisioning: async () => {} },
            authority: { bundle: () => ({}) },
            async close() { lifetime.abort(); },
          };
          return {
            session: fakeSession,
            setNetworkActive(active) { networkRoles[idx] = active; },
            async close() { await fakeSession.close(); },
          };
        },
      });
    }
    postMessage(data, transfer) {
      if (!this.terminated) {
        queueMicrotask(() => this._scope.dispatchEvent(new MessageEvent('message', { data: structuredClone(data), ports: transfer ?? [] })));
      }
    }
    terminate() {
      this.terminated = true;
      void this._server.close();
    }
  }

  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: env.locks } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://app.example/notes/') });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  globalThis.BroadcastChannel = env.MockBroadcastChannel;
  globalThis.Worker = MockWorker;

  try {
    assert.equal(TAB_OWNER_PROTOCOL, 'tendriller/tab-owner/v3');
    const tab1 = await openBrowserOwner({
      workerUrl: 'https://app.example/notes/worker.mjs',
      profileId: 'profile-multi-1',
      applicationId: 'a'.repeat(64),
      persistStorage: false,
    });
    // Opening a second concurrent tab for the same profile succeeds immediately without throwing!
    const tab2 = await openBrowserOwner({
      workerUrl: 'https://app.example/notes/worker.mjs',
      profileId: 'profile-multi-1',
      applicationId: 'a'.repeat(64),
      persistStorage: false,
    });
    assert.equal(tab1.mode, 'dedicated');
    assert.equal(tab2.mode, 'dedicated');
    assert.equal(typeof tab1.rtc.getPeer, 'function');
    assert.equal(typeof tab2.rtc.getPeer, 'function');

    // Allow microtasks for leader election to settle: tab 1 holds network leadership.
    await new Promise(r => setTimeout(r, 40));
    assert.equal(networkRoles[0], true);

    // Detaching tab 1 promotes tab 2 cleanly.
    await tab1.detach();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(networkRoles[1], true);

    await tab2.detach();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: origLoc });
    if (origDoc === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
    globalThis.BroadcastChannel = origBC;
    globalThis.Worker = origWorker;
  }
});
