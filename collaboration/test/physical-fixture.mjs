// Public-package fixtures: real Chronolog v2 genesis, operation set, QuickJS-NG materializer, and owner.
// In-memory bytes qualify local protocol boundaries, not disk/native/Internet persistence.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const packageRoot = process.env.CHRONOLOG_SESSION_PACKAGE;
export const peerModule = suffix => packageRoot
  ? pathToFileURL(join(resolve(packageRoot), suffix ? suffix + '.mjs' : 'index.mjs')).href
  : import.meta.resolve('@chronolog/peer-session' + (suffix ? '/' + suffix : ''));
export const p = await import(peerModule(''));
export const worker = await import(peerModule('worker'));
export const browser = await import(peerModule('browser'));

export function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key)?.slice() ?? null; },
    async put(key, bytes) { values.set(key, bytes.slice()); },
    async delete(key) { values.delete(key); },
    async entries() { return [...values.entries()].map(([key, value]) => ({ key, value: value.slice() })); },
  };
}

export const EVENT_EMITTER_REDUCER = `
export default {
  reduce(state, tx) {
    const input = tx.payload ?? {};
    const topic = typeof input.eventTopic === 'string' ? input.eventTopic : 'event';
    const payload = Object.hasOwn(input, 'payload') ? input.payload : input;
    return { ok: true, state: { count: ((state && state.count) || 0) + 1 }, events: [{ topic, payload }] };
  },
  query(state) { return state ?? { count: 0 }; },
};
`;

export async function genesisForDevices(devices, { imports = {}, topics = {}, privateLog = true } = {}) {
  const creator = {
    publicKey: devices[0].identity.publicKey,
    wrapKey: devices[0].wrapKey?.publicKey,
    reader: true,
    writer: true,
    administrator: true,
    publisher: true,
    finalizer: false,
  };
  const members = devices.slice(1).map(d => ({
    publicKey: d.identity.publicKey,
    wrapKey: d.wrapKey?.publicKey,
    reader: true,
    writer: true,
    administrator: false,
    publisher: false,
    finalizer: false,
  }));
  const created = await p.createLogGenesis({
    creator,
    members,
    privateLog,
    imports: { 'app/events': EVENT_EMITTER_REDUCER, ...imports },
    topics: { events: { module: 'app/events', initialState: { count: 0 } }, ...topics },
  });
  return {
    logId: created.logId,
    genesis: created.genesis,
    genesisBytes: created.genesisBytes,
    casNodes: created.casNodes,
    key: created.epoch0Key,
  };
}

export async function createPhysicalSession({ definition, close, imports = {}, topics = {} } = {}) {
  const device = await p.openApplicationDevice({ store: memoryStore(), create: true, ...(close ? { close } : {}) });
  try {
    const { genesisBytes, casNodes, key } = await genesisForDevices([device], { imports, topics });
    return await p.createApplicationSession({
      device,
      definition: definition ?? p.defineApplication({ id: 'physical-owner', version: '1', commands: {}, queries: {} }),
      genesis: genesisBytes,
      casNodes,
      epochKeys: new Map([[0, key]]),
    });
  } catch (error) { await device.close(); throw error; }
}
