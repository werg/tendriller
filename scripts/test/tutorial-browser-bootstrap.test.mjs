import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as peer from '@chronolog/peer-session';
import { createAdmissionHost } from './helpers/admission-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({
  entryPoints: [root + 'docs/tutorial/shared/helpers/browser-bootstrap.mjs'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  external: ['@chronolog/peer-session'],
  plugins: [{
    name: 'public-core',
    setup(builder) {
      builder.onResolve({ filter: /^@tendriller\/core\/peers$/ }, () => ({ path: root + 'contract/peers.mjs' }));
      builder.onResolve({ filter: /^@tendriller\/core\/admission$/ }, () => ({ path: root + 'session/admission.mjs' }));
      builder.onResolve({ filter: /^@tendriller\/core\/authority$/ }, () => ({ path: root + 'contract/authority.mjs' }));
    },
  }],
});
const { bootstrapBrowser, admitBrowserSession } = await import(
  'data:text/javascript;base64,' + Buffer.from(
    built.outputFiles[0].text.replaceAll('"@chronolog/peer-session"', JSON.stringify(import.meta.resolve('@chronolog/peer-session'))),
  ).toString('base64'),
);

const pageUrl = 'https://aaaaaaaaaaaa.pages.example/s/test/';
const MSG_REDUCER = `
export default {
  reduce(state, tx) {
    return { ok: true, state: { count: ((state && state.count) || 0) + 1 }, events: [{ topic: 'message', payload: tx.payload }] };
  },
};
`;
const definition = peer.defineApplication({
  id: 'bootstrap-test',
  version: '1',
  commands: { say: peer.defineCommand({ description: 'Say', input: { type: 'string' }, prepare: text => [{ topic: 'messages', input: { text } }] }) },
  queries: {},
});
const memoryStore = () => {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key)?.slice() ?? null; },
    async put(key, value) { values.set(key, value.slice()); },
    async delete(key) { values.delete(key); },
    async entries() { return [...values.entries()].map(([key, value]) => ({ key, value: value.slice() })); },
  };
};

function fetchFor(client, { loseInitializeReplies = 0, log = [] } = {}) {
  let lost = loseInitializeReplies;
  return async (url, init) => {
    const path = new URL(url).pathname.replace(/^.*\/_tendril\//, '');
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    log.push(path + (body?.action ? ':' + body.action : ''));
    try {
      if (path === 'application') return Response.json(await client.application());
      if (path !== 'peers/enrollment') throw Object.assign(Error('unexpected ' + path), { status: 404, code: 'unexpected' });
      const handlers = {
        challenge: () => client.challenge(body.publicKey),
        enroll: () => client.enroll(body.proof, body.invite),
        initialize: () => client.initialize({ genesis: body.genesis, casNodes: body.casNodes }),
        sync: () => client.syncControl(body),
        admissions: () => client.admissions(),
      };
      const value = await handlers[body.action]();
      if (body.action === 'initialize' && lost-- > 0) throw new TypeError('network reply lost');
      return Response.json(value);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 });
    }
  };
}

async function withBrowser(fetcher, work) {
  const originalFetch = globalThis.fetch;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.fetch = fetcher;
  Object.defineProperty(globalThis, 'location', { value: { origin: new URL(pageUrl).origin }, configurable: true });
  try { return await work(); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globalThis.location;
  }
}

async function setup() {
  const host = await createAdmissionHost();
  return {
    host,
    configuration: {
      page_url: pageUrl,
      imports: { 'app/messages': MSG_REDUCER },
      topics: { messages: { module: 'app/messages', initialState: { count: 0 } } },
    },
  };
}
const owner = { account: { accountId: 'acct_owner', email: 'owner@example.test' } };

test('a browser on an uninitialized page creates v2 genesis: durable before sending, and a lost reply recovers that exact genesis', async () => {
  const { host, configuration } = await setup();
  const store = memoryStore();
  const device = await peer.openApplicationDevice({ store, create: true });
  const log = [];
  const opened = await withBrowser(fetchFor(host.client(owner), { loseInitializeReplies: 1, log }), async () => {
    await assert.rejects(bootstrapBrowser({ configuration, device, signal: new AbortController().signal }), /network reply lost/);
    const intent = [...store.values.keys()].find(key => key.startsWith('tendriller/admission/genesis/'));
    assert.ok(intent, 'the exact genesis intent survived the lost reply');
    return bootstrapBrowser({ configuration, device, signal: new AbortController().signal });
  });
  assert.equal(opened.logId, host.state.applicationId);
  assert.ok(opened.epoch0Key instanceof Uint8Array && opened.epoch0Key.length === 32, 'the retained epoch 0 key is recovered');
  assert.equal(log.filter(entry => entry.endsWith(':initialize')).length, 1);
  // Reopening offline uses the retained local genesis.
  const offline = await withBrowser(async () => { throw new TypeError('offline'); }, () =>
    bootstrapBrowser({ configuration: { ...configuration, applicationId: opened.logId }, device, signal: new AbortController().signal }));
  assert.equal(offline.logId, opened.logId);
  await device.close();
});

test('a second browser of the owner pins the page, waits, and is admitted by the first one with HPKE key unlock', async () => {
  const { host, configuration } = await setup();
  const sessions = [];
  try {
    for (const label of ['first', 'second']) {
      const store = memoryStore();
      const device = await peer.openApplicationDevice({ store, create: true });
      await withBrowser(fetchFor(host.client(owner)), async () => {
        const opened = await bootstrapBrowser({ configuration, device, signal: new AbortController().signal });
        const session = await peer.createApplicationSession({
          device,
          definition,
          genesis: opened.genesisBytes,
          casNodes: opened.casNodes,
          ...(opened.epoch0Key ? { epochKeys: new Map([[0, opened.epoch0Key]]) } : {}),
        });
        sessions.push({ label, session, admission: admitBrowserSession(session, { peers: opened.peers, wrapKey: opened.wrapKey, store: device.store }) });
      });
    }
    const [first, second] = sessions;
    assert.equal(second.session.status.canAuthor, false);
    await withBrowser(fetchFor(host.client(owner)), async () => {
      const deadline = Date.now() + 10_000;
      while (second.admission.state.phase !== 'admitted') {
        if (Date.now() > deadline) throw Error(`second stayed ${second.admission.state.phase}: ${second.admission.state.error}`);
        await first.admission.refresh();
        await second.admission.refresh();
      }
    });
    assert.equal(second.session.status.canAuthor, true);
  } finally {
    for (const value of sessions) { value.admission.close(); await value.session.close(); }
  }
});

test('bootstrap refuses another origin', async () => {
  const { host, configuration } = await setup();
  const device = await peer.openApplicationDevice({ store: memoryStore(), create: true });
  await assert.rejects(
    withBrowser(fetchFor(host.client(owner)), () =>
      bootstrapBrowser({ configuration: { ...configuration, page_url: 'https://other.example/s/x/' }, device, signal: new AbortController().signal })),
    /own authorized origin/,
  );
  await device.close();
});
