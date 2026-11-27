import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import {
  createApplicationBackend,
  createApplicationSession,
  createLogGenesis,
  defineApplication,
  defineCommand,
  defineQuery,
  openApplicationDevice,
} from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { agentRequestCommands, agentRequestQueries } from '../../docs/tutorial/shared/helpers/agent-requests.mjs';

const built = await build({
  entryPoints: [new URL('../src/utility/chat-modal.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'ChatModal',
  platform: 'browser',
  write: false,
});

const flush = async (ticks = 12) => {
  for (let i = 0; i < ticks; i++) await new Promise(r => setImmediate(r));
};

function createFakeDom() {
  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.listeners = new Map();
      this.style = { setProperty(k, v) { this[k] = v; } };
      this.className = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.tabIndex = 0;
      this.scrollHeight = 42;
      this.scrollTop = 0;
      this.clientHeight = 42;
      this._text = '';
    }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('');
    }
    set textContent(v) {
      this._text = String(v ?? '');
      this.children = [];
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === 'object') n.parentNode = this;
        this.children.push(n);
      }
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        if (child && typeof child === 'object') child.parentNode = null;
      }
    }
    get firstChild() { return this.children[0] ?? null; }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type, event = {}) {
      const e = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
      for (const fn of this.listeners.get(type) ?? []) fn(e);
    }
    focus() {}
    setSelectionRange() {}
    findAll(predicate, out = []) {
      if (predicate(this)) out.push(this);
      for (const c of this.children) {
        if (c instanceof FakeElement) c.findAll(predicate, out);
      }
      return out;
    }
  }
  const document = {
    visibilityState: 'visible',
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: text => ({
      textContent: String(text),
      parentNode: null,
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  return { document, FakeElement };
}

function mountModal({ backend, roster, sessionStorageMap = new Map() }) {
  const { document } = createFakeDom();
  const localMap = new Map();
  const agentListeners = new Set();
  let currentRoster = {
    primary_agent_id: null,
    agents: [],
    live: {},
    viewer: { role: 'owner', handle: 'owner' },
    ...roster,
  };
  const dockStates = [];
  let openedCount = 0;

  const api = {
    identity: { page: 'page-v2-test', base: '/p/' },
    assetUrl: p => `https://test.example/runtime/${p}`,
    application: {
      available: true,
      backend,
    },
    agents: {
      snapshot: () => currentRoster,
      refresh: async () => currentRoster,
      setPrimary: async id => { currentRoster = { ...currentRoster, primary_agent_id: id }; return currentRoster; },
      onChange: fn => { agentListeners.add(fn); return () => agentListeners.delete(fn); },
    },
    chat: null,
    signals: { available: false },
  };

  const context = {
    document,
    window: { addEventListener() {}, removeEventListener() {}, speechSynthesis: null },
    navigator: { language: 'en-US' },
    sessionStorage: {
      getItem: k => sessionStorageMap.get(k) ?? null,
      setItem: (k, v) => sessionStorageMap.set(k, String(v)),
      removeItem: k => sessionStorageMap.delete(k),
    },
    localStorage: {
      getItem: k => localMap.get(k) ?? null,
      setItem: (k, v) => localMap.set(k, String(v)),
      removeItem: k => localMap.delete(k),
    },
    crypto,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    Date,
    atob,
  };
  runInNewContext(built.outputFiles[0].text, context);
  const controller = context.ChatModal.createChatModal(api, {
    onDockStateChange: st => dockStates.push(st),
    onOpenAgentsModal() {},
    onOpenVoiceModal() {},
    onRequestOpen() { openedCount++; },
  });
  const textarea = controller.body.findAll(el => el.tagName === 'TEXTAREA')[0];
  const sendBtn = controller.body.findAll(el => el.className === 'send-btn')[0];
  const statusStrip = controller.body.findAll(el => el.className.startsWith('chat-status'))[0];
  const feed = controller.body.findAll(el => el.className === 'chat-feed')[0];
  const updateRoster = next => {
    currentRoster = { ...currentRoster, ...next };
    for (const fn of agentListeners) fn(currentRoster);
  };
  return { controller, textarea, sendBtn, statusStrip, feed, dockStates, sessionStorageMap, updateRoster, get openedCount() { return openedCount; } };
}

const eventReducerSource = topic => `
export default {
  reduce(state, tx) {
    return {
      ok: true,
      state: { count: ((state && state.count) || 0) + 1 },
      events: [{ topic: ${JSON.stringify(topic)}, payload: tx.payload }],
    };
  },
  query(state) { return state || { count: 0 }; },
};
`.trimStart();

async function createRealV2Session(definition, topicNames = ['agent/message', 'agent/receipt']) {
  const device = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const imports = Object.fromEntries(topicNames.map((name, i) => [`app/events_${i}`, eventReducerSource(name)]));
  const topics = Object.fromEntries(topicNames.map((name, i) => [name, { module: `app/events_${i}`, initialState: { count: 0 } }]));
  const created = await createLogGenesis({
    creator: {
      publicKey: device.identity.publicKey,
      wrapKey: device.wrapKey.publicKey,
      reader: true,
      writer: true,
      administrator: true,
      publisher: true,
      finalizer: true,
    },
    privateLog: false,
    imports,
    topics,
  });
  const session = await createApplicationSession({
    device,
    applicationId: created.logId,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
    definition,
  });
  return { session, device, identity: device.identity, created };
}

test('built-in chat routes through real Chronolog v2 agentMessage command, reads replies, and distinguishes saved/seen/answered', async t => {
  const definition = defineApplication({
    id: 'v2-chat-standard',
    version: '1',
    commands: { ...agentRequestCommands },
    queries: { ...agentRequestQueries },
  });
  const { session, identity } = await createRealV2Session(definition);
  t.after(() => session.close());

  const agentDevice = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const agentIdentity = agentDevice.identity;
  const backend = {
    ...createApplicationBackend(session),
    // Normalize VM-realm objects/arrays across Node's vm.runInNewContext boundary.
    command: (name, input, opts) => session.command(name, JSON.parse(JSON.stringify(input)), opts ? JSON.parse(JSON.stringify(opts)) : undefined),
  };
  const mounted = mountModal({
    backend,
    roster: {
      primary_agent_id: 'ag_1',
      agents: [{ id: 'ag_1', handle: 'atlas', bio: 'Helper', public_key: agentIdentity.publicKey, kind: 'workspace', is_primary: true }],
      live: {},
    },
  });
  t.after(() => mounted.controller.dispose());
  mounted.controller.onOpen();
  await flush();

  // Absent worker presence must report "Status unknown", never falsely "Offline".
  assert.equal(mounted.controller.getDockState().presenceStatus, 'unknown');
  assert.match(mounted.controller.headerSub.textContent, /Status unknown/);
  assert.doesNotMatch(mounted.controller.headerSub.textContent, /Offline/);

  // Send a typed message through the built-in chat modal.
  mounted.textarea.value = 'Hello from v2 chat';
  mounted.textarea.dispatch('input');
  mounted.sendBtn.dispatch('click');
  await flush(25);

  assert.equal(mounted.statusStrip.hidden, true, `must not fail with OPERATION_UPDATES_REQUIRED (got: ${mounted.statusStrip.textContent})`);
  assert.equal(mounted.textarea.value, '', 'draft clears once stored locally');
  const feedAfterSend = (await session.query('agentFeed', null)).value;
  assert.equal(feedAfterSend.messages.length, 1);
  assert.equal(feedAfterSend.messages[0].text, 'Hello from v2 chat');
  assert.equal(feedAfterSend.messages[0].author, identity.publicKey);
  assert.match(mounted.feed.textContent, /Saved locally/, 'local storage is distinct from receipt/answer');
  assert.doesNotMatch(mounted.feed.textContent, /Seen by agent|Answered/);

  // Agent records a durable seen receipt, then replies (simulated via second admitted session on same log).
  const msg = feedAfterSend.messages[0];
  await session.command('agentReceipt', {
    messageAuthor: msg.author,
    messageOperationId: msg.operationId,
    runId: 'run-1',
    state: 'seen',
  });
  // Note: self-authored receipt is ignored by messageDelivery/chat-modal; simulate distinct agent peer reply via second session.
  const agentSession = await createApplicationSession({
    device: agentDevice,
    applicationId: session.applicationId,
    genesis: session.genesisBytes,
    definition,
  });
  t.after(() => agentSession.close());
  await session.admitMember({ publicKey: agentIdentity.publicKey, reader: true, writer: true, administrator: false });
  await agentSession.mergeFacts(await session.exportFacts());
  await agentSession.command('agentReceipt', {
    messageAuthor: msg.author,
    messageOperationId: msg.operationId,
    runId: 'agent-run-1',
    state: 'seen',
  });
  await session.mergeFacts(await agentSession.exportFacts());
  await flush(25);
  assert.match(mounted.feed.textContent, /Seen by agent/);

  await agentSession.command('agentMessage', {
    channel: 'chat',
    to: [],
    text: 'Here is the real v2 reply!',
    inReplyTo: { author: msg.author, operationId: msg.operationId },
    replyToUser: true,
  });
  await session.mergeFacts(await agentSession.exportFacts());
  await flush(25);
  assert.match(mounted.feed.textContent, /Here is the real v2 reply!/);
  assert.match(mounted.feed.textContent, /Answered/);
});

test('built-in chat respects custom reducer topic mapping declared via agentMessage/agentFeed', async t => {
  // Application binds agentMessage to a custom topic `custom_chat_log`, NOT `agent/message`.
  const definition = defineApplication({
    id: 'v2-custom-chat-topic',
    version: '1',
    commands: {
      agentMessage: defineCommand({
        description: 'Custom-topic chat message',
        input: {
          type: 'object',
          properties: {
            channel: { type: 'string', enum: ['chat', 'agents'] },
            to: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 32 },
            text: { type: 'string', minLength: 1, maxLength: 8000 },
          },
          required: ['channel', 'to', 'text'],
          additionalProperties: false,
        },
        prepare(input) { return [{ topic: 'custom_chat_log', input }]; },
      }),
    },
    queries: {
      agentFeed: defineQuery({
        description: 'Custom-topic chat feed',
        input: { type: 'null' },
        async read(view) {
          const batch = await view.readEvents({ topics: ['custom_chat_log'], limit: 128 });
          return {
            messages: batch.events.map(ev => ({
              author: ev.author,
              operationId: ev.operationId,
              eventId: ev.id,
              atMs: Number(ev.authorTimestampMs),
              channel: ev.payload?.channel ?? 'chat',
              to: ev.payload?.to ?? [],
              text: String(ev.payload?.text ?? ''),
            })),
            activity: [],
            receipts: {},
          };
        },
      }),
    },
  });
  const { session } = await createRealV2Session(definition, ['custom_chat_log']);
  t.after(() => session.close());

  const backend = {
    ...createApplicationBackend(session),
    // Normalize VM-realm objects/arrays across Node's vm.runInNewContext boundary.
    command: (name, input, opts) => session.command(name, JSON.parse(JSON.stringify(input)), opts ? JSON.parse(JSON.stringify(opts)) : undefined),
  };
  const mounted = mountModal({ backend });
  t.after(() => mounted.controller.dispose());
  mounted.controller.onOpen();
  await flush();

  mounted.textarea.value = 'Message on custom reducer topic';
  mounted.textarea.dispatch('input');
  mounted.sendBtn.dispatch('click');
  await flush(25);

  assert.equal(mounted.statusStrip.hidden, true);
  assert.match(mounted.feed.textContent, /Message on custom reducer topic/);
  const feed = (await session.query('agentFeed', null)).value;
  assert.equal(feed.messages.length, 1);
  assert.equal(feed.messages[0].text, 'Message on custom reducer topic');
});

test('built-in chat preserves exact operationId across failures and reload, keeps drafts, and never duplicates stored writes', async t => {
  const seenCalls = [];
  let shouldFail = true;
  const storedOps = new Map();
  const backend = {
    applicationId: 'a'.repeat(64),
    identity: { publicKey: '1'.repeat(64) },
    status: { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null },
    onStatus: () => () => {},
    describe: () => ({ commands: [{ name: 'agentMessage' }], queries: [{ name: 'agentFeed' }] }),
    async command(name, input, options) {
      seenCalls.push({ name, input, operationId: options?.operationId });
      if (shouldFail) throw Object.assign(new Error('ENDPOINT_CLOSED'), { code: 'ENDPOINT_CLOSED' });
      storedOps.set(options.operationId, { input, operationId: options.operationId });
      return { id: options.operationId, operationId: options.operationId, stored: true };
    },
    async query(name) {
      assert.equal(name, 'agentFeed');
      return {
        value: {
          messages: [...storedOps.values()].map(entry => ({
            author: '1'.repeat(64),
            operationId: entry.operationId,
            channel: entry.input.channel,
            to: entry.input.to,
            text: entry.input.text,
          })),
          activity: [],
          receipts: {},
        },
      };
    },
    operations: {
      get: id => storedOps.has(id) ? { id, operationId: id, stored: true, inspect: () => ({ stored: true }) } : null,
      retry: async id => storedOps.get(id),
      async *subscribe() {},
    },
    async *changes() {},
    async readView() { return { async readEvents() { return { events: [], cursor: '', hasMore: false }; }, async release() {} }; },
    submit() { throw new Error('Must route through declared agentMessage command, not legacy submit'); },
  };

  const sessionStorageMap = new Map();
  const first = mountModal({ backend, sessionStorageMap });
  first.controller.onOpen();
  await flush();

  first.textarea.value = 'Retry with exact operation id';
  first.textarea.dispatch('input');
  first.sendBtn.dispatch('click');
  await flush(20);

  assert.equal(seenCalls.length, 1);
  assert.equal(seenCalls[0].name, 'agentMessage');
  assert.equal(first.textarea.value, 'Retry with exact operation id', 'draft preserved after send error');
  assert.equal(first.statusStrip.hidden, false);
  const retainedOpId = seenCalls[0].operationId;
  first.controller.dispose();

  // Simulate reload with retained pending send in sessionStorage; retry must reuse exact operationId.
  shouldFail = false;
  const reloaded = mountModal({ backend, sessionStorageMap });
  t.after(() => reloaded.controller.dispose());
  reloaded.controller.onOpen();
  await flush(20);
  assert.equal(reloaded.textarea.value, 'Retry with exact operation id', 'draft restored after reload');

  reloaded.sendBtn.dispatch('click');
  await flush(20);
  assert.equal(seenCalls.length, 2);
  assert.equal(seenCalls[1].operationId, retainedOpId, 'exact operationId preserved across reload and retry');
  assert.equal(JSON.stringify(seenCalls[1].input), JSON.stringify(seenCalls[0].input), 'exact payload preserved across reload and retry');
  assert.equal(reloaded.textarea.value, '');
  assert.match(reloaded.feed.textContent, /Retry with exact operation id/);
});

test('chat presence distinguishes online, busy, stopped, offline, and unknown honestly', async t => {
  const agentKey = 'a'.repeat(64);
  const backend = {
    applicationId: 'b'.repeat(64),
    status: { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 1, pendingOperations: 0, materializationError: null },
    onStatus: () => () => {},
    async *changes() {},
    async readView() { return { async readEvents() { return { events: [], cursor: '', hasMore: false }; }, async release() {} }; },
    operations: { get: () => null, retry: async () => null, async *subscribe() {} },
    submit: async () => ({ id: '1', operationId: '1', stored: true }),
  };
  const mounted = mountModal({
    backend,
    roster: {
      primary_agent_id: 'ag_1',
      agents: [{ id: 'ag_1', handle: 'atlas', bio: '', public_key: agentKey, kind: 'workspace', is_primary: true }],
      live: {},
    },
  });
  t.after(() => mounted.controller.dispose());

  // No live signal -> unknown (not offline)
  assert.equal(mounted.controller.getDockState().presenceStatus, 'unknown');
  assert.match(mounted.controller.headerSub.textContent, /Status unknown/);

  // Confirmed online
  mounted.updateRoster({ live: { [agentKey]: { state: 'online', route: 'same-conversation', idleWakeReachable: true } } });
  assert.equal(mounted.controller.getDockState().presenceStatus, 'online');
  assert.match(mounted.controller.headerSub.textContent, /Online/);

  // Confirmed busy
  mounted.updateRoster({ live: { [agentKey]: { state: 'busy', route: 'same-conversation' } } });
  assert.equal(mounted.controller.getDockState().presenceStatus, 'busy');
  assert.match(mounted.controller.headerSub.textContent, /Thinking…/);

  // Confirmed stopped
  mounted.updateRoster({ live: { [agentKey]: { state: 'stopped' } } });
  assert.equal(mounted.controller.getDockState().presenceStatus, 'stopped');
  assert.match(mounted.controller.headerSub.textContent, /Stopped/);

  // Confirmed expired/offline
  mounted.updateRoster({ live: { [agentKey]: { state: 'offline' } } });
  assert.equal(mounted.controller.getDockState().presenceStatus, 'offline');
  assert.match(mounted.controller.headerSub.textContent, /Offline/);
});
