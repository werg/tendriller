import {
  createApplicationSession, createChainGenesis, decodeRecord, defineApplication,
  defineCommand, defineQuery, encodeRecord,
} from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import quickjsWasmUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import { serveBrowserOwner } from '../../../session/worker.mjs';

let quickjsWasmPromise;
const loadQuickJsWasm = () => (quickjsWasmPromise ??= fetch(new URL(quickjsWasmUrl, import.meta.url))
  .then(r => { if (!r.ok) throw Error(`QuickJS WASM fetch failed: ${r.status}`); return r.arrayBuffer(); })
  .then(buf => WebAssembly.compile(buf)));

const profileId = new URL(import.meta.url).searchParams.get('profile') || 'browser-owner-test';
const MSG_REDUCER = `
export default {
  reduce(state, tx) {
    return { ok: true, state: { count: ((state && state.count) || 0) + 1 }, events: [{ topic: 'message', payload: tx.payload }] };
  },
};
`;

const definition = defineApplication({
  id: 'owner-fixture',
  version: '1',
  commands: {
    say: defineCommand({
      description: 'Retain test message',
      input: { type: 'string', minLength: 1, maxLength: 128 },
      prepare: text => [{ topic: 'messages', input: { text } }],
    }),
  },
  queries: {
    messages: defineQuery({
      description: 'Coherent test messages',
      input: { type: 'null' },
      read: view => view.readEvents(),
    }),
  },
});

serveBrowserOwner({
  async load() {
    // Exercise first-message delivery while configuration performs real async work.
    await new Promise(resolve => setTimeout(resolve, 30));
    return {
      profileId,
      async createIdentity() {
        const device = await openBrowserDevice({ name: profileId, create: true });
        try { return device.identity.publicKey; }
        finally { await device.close(); }
      },
      async openSession() {
        const device = await openBrowserDevice({ name: profileId, create: true });
        let session;
        try {
          let genesisBytes = await device.store.get('test/genesis-v2');
          let casRaw = await device.store.get('test/cas-v2');
          let key = await device.store.get('test/epoch-v2');
          let casNodes = [];
          if (!genesisBytes) {
            const created = await createChainGenesis({
              creator: {
                publicKey: device.identity.publicKey,
                wrapKey: device.wrapKey?.publicKey,
                reader: true,
                writer: true,
                administrator: true,
                publisher: true,
                finalizer: false,
              },
              imports: { 'app/messages': MSG_REDUCER },
              topics: { messages: { module: 'app/messages', initialState: { count: 0 } } },
            });
            genesisBytes = created.genesisBytes;
            casNodes = created.casNodes;
            key = created.epoch0Key;
            await device.store.put('test/genesis-v2', genesisBytes);
            await device.store.put('test/cas-v2', encodeRecord(casNodes));
            await device.store.put('test/epoch-v2', key);
          } else if (casRaw) {
            casNodes = decodeRecord(casRaw);
          }
          if (!(key instanceof Uint8Array) || key.length !== 32) throw Error('RETAINED_FIXTURE_EPOCH_KEY_MISSING');
          session = await createApplicationSession({
            device,
            applicationId: '91'.repeat(32),
            definition,
            genesis: genesisBytes,
            casNodes,
            epochKeys: new Map([[0, key]]),
            wasmModule: await loadQuickJsWasm(),
          });
          return { session };
        } catch (error) {
          if (session) await session.close(); else await device.close();
          throw error;
        }
      },
    };
  },
});
