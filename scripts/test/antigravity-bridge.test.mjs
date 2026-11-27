import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  checkAntigravitySupport,
  consumeAntigravityBroadcasts,
  consumeAntigravityRequests,
  createAntigravityConversationLiveness,
  createHeadlessStreamDriver,
  inspectPageRequestSupport,
  readAntigravityConversationMetadata,
  readAntigravityConversationState,
  resolveAgentApiBinary,
  resolveAgyBinary,
  runAntigravityBridge,
  runAntigravityDoctor,
} from '../../docs/tutorial/consumers/antigravity-bridge.mjs';
import { openConsumerCheckpoint } from '../../docs/tutorial/shared/helpers/agent-consumer.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const AGENT_KEY = 'a'.repeat(64);
const USER_KEY = 'b'.repeat(64);
const CONV_ID = '9e40855f-fb38-41db-b7c8-90512ee1320e';
const CREATED_CONV_ID = '11111111-2222-3333-4444-555555555555';

function makeFakeSession({ events = [], feed = { messages: [], activity: [], receipts: {} }, supported = true } = {}) {
  let revision = 1;
  let currentEvents = [...events];
  let currentFeed = structuredClone(feed);
  const listeners = new Set();
  const signalFrames = [];
  const statusListeners = new Set();
  const stop = new AbortController();

  const notify = () => {
    revision += 1;
    for (const fn of [...listeners]) fn();
  };

  const session = {
    identity: { publicKey: AGENT_KEY },
    signal: stop.signal,
    status: { connectedPeers: 1, connectionRevision: 1 },
    describe() {
      return supported
        ? { queries: ['agentFeed'], commands: ['agentMessage', 'agentReceipt'] }
        : { queries: ['notes'], commands: ['putNote'] };
    },
    async query(name) {
      if (!supported || name !== 'agentFeed') {
        throw Object.assign(Error('APPLICATION_QUERY_UNKNOWN'), { code: 'APPLICATION_QUERY_UNKNOWN' });
      }
      return { value: structuredClone(currentFeed) };
    },
    async readView() {
      const snapRev = revision;
      const snapEvents = [...currentEvents];
      return {
        async readEvents({ topics, cursor }) {
          if (cursor !== undefined && cursor !== `rev:${snapRev}:${snapEvents.length}`) {
            if (!String(cursor).startsWith(`rev:${snapRev}:`)) {
              throw Object.assign(Error('EVENT_CURSOR_STALE'), { code: 'EVENT_CURSOR_STALE' });
            }
          }
          const filtered = snapEvents.filter(e => topics.includes(e.topic));
          const offset = cursor && String(cursor).startsWith(`rev:${snapRev}:`)
            ? Number(String(cursor).split(':')[2])
            : 0;
          const slice = filtered.slice(offset);
          return {
            events: slice,
            cursor: `rev:${snapRev}:${filtered.length}`,
            hasMore: false,
          };
        },
        async release() {},
      };
    },
    changes({ signal } = {}) {
      return {
        [Symbol.asyncIterator]() {
          const queue = [];
          let wake = null;
          const onChange = () => {
            if (wake) { const fn = wake; wake = null; fn({ value: revision, done: false }); }
            else queue.push(revision);
          };
          listeners.add(onChange);
          const onAbort = () => {
            listeners.delete(onChange);
            if (wake) { const fn = wake; wake = null; fn({ value: undefined, done: true }); }
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          return {
            next() {
              if (signal?.aborted) return Promise.resolve({ value: undefined, done: true });
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
              return new Promise(resolve => { wake = resolve; });
            },
            return() {
              listeners.delete(onChange);
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    signals: {
      async send(topic, payload, opts) {
        signalFrames.push({ topic, payload: structuredClone(payload), opts });
      },
      subscribe({ signal } = {}) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (signal?.aborted) return Promise.resolve({ value: undefined, done: true });
                return new Promise(resolve => {
                  signal?.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true });
                });
              },
              return() { return Promise.resolve({ value: undefined, done: true }); },
            };
          },
        };
      },
    },
  };

  return {
    session,
    signalFrames,
    pushEvent(event) {
      currentEvents.push(event);
      currentFeed.messages.push({
        author: event.author,
        operationId: event.operationId,
        channel: event.payload?.channel ?? 'chat',
        to: event.payload?.to ?? [],
        text: event.payload?.text ?? '',
      });
      notify();
    },
    markAnswered(author, operationId) {
      currentFeed.messages.push({
        author: AGENT_KEY,
        operationId: `reply-${operationId}`,
        channel: 'chat',
        inReplyTo: { author, operationId },
        text: 'Done',
      });
      notify();
    },
    close() { stop.abort(); },
  };
}

function makeRoster() {
  return async () => ({
    primary_agent_id: 'ag_1',
    is_primary: true,
    agents: [{ id: 'ag_1', handle: 'atlas', public_key: AGENT_KEY, is_primary: true }],
  });
}

function makeMessageEvent(opId, text = 'Hello agent', extra = {}) {
  return {
    id: `ev-${opId}`,
    author: USER_KEY,
    operationId: opId,
    topic: 'agent/message',
    payload: { channel: 'chat', to: [], text, ...extra },
  };
}

test('resolveAgentApiBinary honors explicit agentapi path and ignores agy binary path', () => {
  assert.equal(resolveAgentApiBinary({ ANTIGRAVITY_AGENTAPI_EXE: '/home/u/.local/bin/agy' }), 'agentapi');
  assert.equal(resolveAgentApiBinary({ ANTIGRAVITY_AGENTAPI_EXE: '/opt/bin/agentapi' }), '/opt/bin/agentapi');
  assert.equal(resolveAgentApiBinary({}), 'agentapi');
});

test('checkAntigravitySupport and readAntigravityConversationMetadata verify workspace binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-meta-'));
  try {
    const calls = [];
    const execute = async (bin, argv) => {
      calls.push([bin, argv]);
      if (argv[0] === 'send-message' && argv[1] === '--help') {
        return { stdout: 'Usage: agentapi send-message [--title=<title>] <recipient_id> <content>', stderr: '' };
      }
      if (argv[0] === 'get-conversation-metadata') {
        return {
          stdout: JSON.stringify({
            response: {
              conversationMetadata: {
                metadata: {
                  projectId: 'default-cli-project',
                  rootConversationId: CONV_ID,
                  workspaceUris: [pathToFileURL(dir).href],
                },
              },
            },
          }),
          stderr: '',
        };
      }
      throw Error(`unexpected command: ${argv.join(' ')}`);
    };

    const support = await checkAntigravitySupport({ mode: 'agentapi', conversationId: CONV_ID, cwd: dir, execute });
    assert.equal(support.supported, true);

    const meta = await readAntigravityConversationMetadata({ mode: 'agentapi', conversationId: CONV_ID, cwd: dir, execute });
    assert.equal(meta.conversationId, CONV_ID);
    assert.equal(meta.projectId, 'default-cli-project');
    assert.deepEqual(meta.workspacePaths, [dir]);

    // Subdirectory app workspace under parent --conversation-cwd succeeds.
    const sub = join(dir, 'apps', 'notes');
    const metaSub = await readAntigravityConversationMetadata({
      mode: 'agentapi',
      conversationId: CONV_ID,
      cwd: sub,
      conversationCwd: dir,
      execute,
    });
    assert.equal(metaSub.conversationId, CONV_ID);

    // Mismatched conversation workspace fails closed.
    await assert.rejects(
      () => readAntigravityConversationMetadata({
        mode: 'agentapi',
        conversationId: CONV_ID,
        cwd: '/tmp/unrelated-workspace',
        execute,
      }),
      error => error.code === 'ANTIGRAVITY_CONVERSATION_UNAVAILABLE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readAntigravityConversationState and liveness probe map live runState and stop on LS loss', async () => {
  let runState = 'RUN_STATE_IDLE';
  let alive = true;
  let seenHeaders = null;
  const server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    if (!alive) {
      res.writeHead(503);
      res.end('down');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: CONV_ID,
      metadata: { projectId: 'default-cli-project' },
      state: { runState },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = `127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'agy-live-'));
  try {
    const state = await readAntigravityConversationState({
      mode: 'agentapi',
      conversationId: CONV_ID,
      cwd: dir,
      lsAddress: addr,
      csrfToken: 'tok-123',
    });
    assert.equal(state.runState, 'RUN_STATE_IDLE');
    assert.equal(seenHeaders['connect-protocol-version'], '1');
    assert.equal(seenHeaders['x-antigravity-csrf-token'], 'tok-123');

    const fake = makeFakeSession();
    const events = [];
    const liveness = createAntigravityConversationLiveness({
      mode: 'agentapi',
      conversationId: CONV_ID,
      cwd: dir,
      lsAddress: addr,
      csrfToken: 'tok-123',
      sessions: [{ page: { id: 'p1', slug: 'notes' }, session: fake.session }],
      probeIntervalMs: 60_000,
      onState: e => events.push(e),
    });
    try {
      await liveness.probe();
      assert.equal(liveness.snapshot().state, 'listening');
      assert.equal(liveness.snapshot().idleWakeReachable, true);

      runState = 'RUN_STATE_RUNNING';
      await liveness.probe();
      assert.equal(liveness.snapshot().state, 'busy');

      runState = 'RUN_STATE_CANCELLING';
      await liveness.probe();
      assert.equal(liveness.snapshot().state, 'stopped');
      assert.equal(liveness.snapshot().idleWakeReachable, false);

      alive = false;
      await liveness.probe();
      assert.equal(liveness.snapshot().state, 'unavailable');
      assert.ok(events.some(e => e.state === 'conversation_liveness_lost'));
      assert.ok(fake.signalFrames.some(f => f.payload.state === 'stopped'));
    } finally {
      await liveness.close();
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('agentapi mode delivers safe references, skips answered/duplicate messages, and stops on uncertain outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-send-'));
  try {
    const sent = [];
    let failNext = false;
    const execute = async (_bin, argv) => {
      if (argv[0] === 'send-message') {
        if (failNext) throw Error('transport timeout');
        sent.push(argv);
        return {
          stdout: JSON.stringify({ response: { sendMessage: { recipientId: CONV_ID, content: argv.at(-1) } } }),
          stderr: '',
        };
      }
      throw Error(`unexpected: ${argv.join(' ')}`);
    };

    const ev1 = makeMessageEvent('op-1', 'SENSITIVE_USER_TEXT_MUST_NOT_LEAK');
    const fake = makeFakeSession({ events: [ev1], feed: { messages: [{ author: USER_KEY, operationId: 'op-1', text: 'SENSITIVE_USER_TEXT_MUST_NOT_LEAK' }], activity: [], receipts: {} } });
    const cp = await openConsumerCheckpoint(join(dir, 'page.json'), { scope: 'test-agentapi' });
    const states = [];
    const ac = new AbortController();

    try {
      const task = consumeAntigravityRequests({
        mode: 'agentapi',
        conversationId: CONV_ID,
        cwd: dir,
        requestTopics: ['chat'],
        execute,
        page: { id: 'p1', slug: 'notes' },
        session: fake.session,
        checkpoint: cp,
        roster: makeRoster(),
        signal: ac.signal,
        onState: s => {
          states.push(s);
          if (s.state === 'sent') ac.abort();
        },
      });
      await assert.rejects(() => task);
    } finally {
      await cp.close();
    }

    assert.equal(sent.length, 1);
    const notice = sent[0].at(-1);
    assert.ok(notice.includes('op-1'));
    assert.ok(notice.includes(USER_KEY));
    assert.ok(!notice.includes('SENSITIVE_USER_TEXT_MUST_NOT_LEAK'), 'Raw user message text must never be copied into wake notice');
    assert.equal(states[0].source, 'agentapi/send-message');
    assert.equal(states[0].workerReceipt, false);
    assert.equal(states[0].wakeVerified, false);

    // Re-running after a stale cursor must not re-deliver already-delivered op-1;
    // failing on op-2 must retain `uncertain` and refuse blind retry on next run.
    failNext = true;
    fake.pushEvent(makeMessageEvent('op-2', 'Second message'));
    const cp2 = await openConsumerCheckpoint(join(dir, 'page.json'), { scope: 'test-agentapi' });
    try {
      await assert.rejects(
        () => consumeAntigravityRequests({
          mode: 'agentapi',
          conversationId: CONV_ID,
          cwd: dir,
          requestTopics: ['chat'],
          execute,
          page: { id: 'p1', slug: 'notes' },
          session: fake.session,
          checkpoint: cp2,
          roster: makeRoster(),
        }),
        error => error.code === 'ANTIGRAVITY_DELIVERY_UNCERTAIN',
      );
      assert.equal(sent.length, 1, 'op-1 was already delivered and op-2 failed before confirmation');

      // Re-opening with uncertain pending row stops for review instead of blindly resending.
      failNext = false;
      await assert.rejects(
        () => consumeAntigravityRequests({
          mode: 'agentapi',
          conversationId: CONV_ID,
          cwd: dir,
          requestTopics: ['chat'],
          execute,
          page: { id: 'p1', slug: 'notes' },
          session: fake.session,
          checkpoint: cp2,
          roster: makeRoster(),
        }),
        error => error.code === 'ANTIGRAVITY_REVIEW_REQUIRED',
      );
      assert.equal(sent.length, 1);
    } finally {
      await cp2.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wait mode returns immediately on pending work, persists delivered set, and wakes on new events when re-armed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-wait-'));
  try {
    const fake = makeFakeSession();
    const page = {
      id: 'p-wait',
      slug: 'tracker',
      attach: async () => ({ session: fake.session, detach: async () => {} }),
      roster: makeRoster(),
    };

    // Push event while waiter is armed.
    const states1 = [];
    const waitPromise = runAntigravityBridge({
      mode: 'wait',
      cwd: dir,
      requestTopics: ['chat'],
      pages: [page],
      stateDirectory: join(dir, 'state'),
      announceLiveness: true,
      onState: s => states1.push(s),
    });
    setTimeout(() => fake.pushEvent(makeMessageEvent('op-wait-1', 'Update chart')), 40);
    const res1 = await waitPromise;
    assert.equal(res1.matched.length, 1);
    assert.equal(res1.matched[0].request.messageOperationId, 'op-wait-1');
    assert.equal(res1.notice.kind, 'antigravity_wake_notice');
    assert.ok(fake.signalFrames.some(f => f.payload.state === 'stopped'), 'Presence closes on waiter exit');

    // Re-arming before op-wait-1 is answered must NOT re-trigger op-wait-1; it waits for op-wait-2.
    const waitPromise2 = runAntigravityBridge({
      mode: 'wait',
      cwd: dir,
      requestTopics: ['chat'],
      pages: [page],
      stateDirectory: join(dir, 'state'),
      onState: () => {},
    });
    setTimeout(() => fake.pushEvent(makeMessageEvent('op-wait-2', 'Second request')), 40);
    const res2 = await waitPromise2;
    assert.equal(res2.matched.length, 1);
    assert.equal(res2.matched[0].request.messageOperationId, 'op-wait-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('new-conversation mode dispatches via agentapi new-conversation with model/profile flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-spawn-'));
  try {
    const calls = [];
    const execute = async (_bin, argv) => {
      calls.push(argv);
      if (argv[0] === 'new-conversation' && argv[1] === '--help') {
        return { stdout: 'Usage: agentapi new-conversation [--model=...] [--title=...] <prompt>', stderr: '' };
      }
      if (argv[0] === 'new-conversation') {
        return { stdout: JSON.stringify({ response: { conversationId: CREATED_CONV_ID } }), stderr: '' };
      }
      throw Error(`unexpected: ${argv.join(' ')}`);
    };

    const fake = makeFakeSession({ events: [makeMessageEvent('op-spawn-1', 'Triage')], feed: { messages: [{ author: USER_KEY, operationId: 'op-spawn-1', text: 'Triage' }], activity: [], receipts: {} } });
    const ac = new AbortController();
    const states = [];
    const page = {
      id: 'p-spawn',
      slug: 'triage',
      attach: async () => ({ session: fake.session, detach: async () => {} }),
      roster: makeRoster(),
    };
    await assert.rejects(() => runAntigravityBridge({
      mode: 'new-conversation',
      cwd: dir,
      requestTopics: ['chat'],
      model: 'pro',
      profile: 'reviewer',
      execute,
      pages: [page],
      stateDirectory: join(dir, 'state'),
      signal: ac.signal,
      onState: s => {
        states.push(s);
        if (s.state === 'spawned') ac.abort();
      },
    }));

    const spawnCall = calls.find(c => c[0] === 'new-conversation' && c[1] !== '--help');
    assert.ok(spawnCall);
    assert.ok(spawnCall.includes('--model=pro'));
    assert.ok(spawnCall.includes('--profile=reviewer'));
    assert.ok(spawnCall.includes('--'));
    const spawnedState = states.find(s => s.state === 'spawned');
    assert.equal(spawnedState.createdConversationId, CREATED_CONV_ID);
    assert.equal(spawnedState.source, 'agentapi/new-conversation');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('consumeAntigravityBroadcasts verifies signatures, deduplicates, and never auto-acknowledges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-bc-'));
  try {
    const sent = [];
    const execute = async (_bin, argv) => {
      sent.push(argv);
      return { stdout: JSON.stringify({ response: { sendMessage: { recipientId: CONV_ID } } }), stderr: '' };
    };
    const cp = await openConsumerCheckpoint(join(dir, 'broadcasts.json'), { scope: 'bc' });
    const states = [];
    try {
      const source = {
        async read() {
          return {
            issuer: 'https://tendriller.dev',
            keys: [{ id: 'k1' }],
            versions: {},
            acknowledged: [],
            broadcasts: [
              { id: 'bc_aaaaaaaaaaaaaaaaaaaaaaaaaa', signed: { payload: { id: 'bc_aaaaaaaaaaaaaaaaaaaaaaaaaa', seq: 1, kind: 'security', severity: 'urgent', title: 'Patch now', summary: 'Upgrade' }, signature: 'valid' } },
              { id: 'bc_bbbbbbbbbbbbbbbbbbbbbbbbbb', signed: { payload: { id: 'bc_bbbbbbbbbbbbbbbbbbbbbbbbbb', seq: 2, kind: 'info', severity: 'info', title: 'Forged', summary: 'Bad' }, signature: 'forged' } },
            ],
          };
        },
      };
      await consumeAntigravityBroadcasts({
        mode: 'agentapi',
        conversationId: CONV_ID,
        cwd: dir,
        execute,
        broadcastSource: source,
        checkpoint: cp,
        verifySignature: async signed => ({ valid: signed.signature === 'valid', reason: signed.signature === 'valid' ? null : 'bad_sig' }),
        evaluateMatch: () => ({ matched: true }),
        onState: s => states.push(s),
      });
      // Second pass must deduplicate already-delivered broadcast.
      await consumeAntigravityBroadcasts({
        mode: 'agentapi',
        conversationId: CONV_ID,
        cwd: dir,
        execute,
        broadcastSource: source,
        checkpoint: cp,
        verifySignature: async signed => ({ valid: signed.signature === 'valid' }),
        evaluateMatch: () => ({ matched: true }),
        onState: s => states.push(s),
      });
    } finally {
      await cp.close();
    }
    assert.equal(sent.length, 1);
    assert.ok(states.some(s => s.state === 'sent' && s.broadcastAcknowledged === false));
    assert.ok(states.some(s => s.state === 'broadcast_rejected' && s.reason === 'bad_sig'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('inspectPageRequestSupport reports missing request-feed interface cleanly', async () => {
  const unsupported = makeFakeSession({ supported: false });
  const result = await inspectPageRequestSupport({ id: 'p-plain', slug: 'plain' }, unsupported.session);
  assert.equal(result.supported, false);
  assert.ok(result.missing.includes('query:agentFeed'));
});

test('agentapi mode defers while RUN_STATE_CANCELLING and delivers once IDLE', async () => {
  let polls = 0;
  const server = http.createServer((_req, res) => {
    polls += 1;
    const runState = polls < 2 ? 'RUN_STATE_CANCELLING' : 'RUN_STATE_IDLE';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: CONV_ID, metadata: { projectId: 'p' }, state: { runState } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const addr = `127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'agy-cancel-'));
  try {
    const sent = [];
    const execute = async (_bin, argv) => {
      if (argv[0] === 'send-message') {
        sent.push(argv);
        return { stdout: JSON.stringify({ response: { sendMessage: { recipientId: CONV_ID } } }), stderr: '' };
      }
      throw Error(`unexpected: ${argv.join(' ')}`);
    };
    const ev = makeMessageEvent('op-cancel-1', 'After cancel');
    const fake = makeFakeSession({ events: [ev], feed: { messages: [{ author: USER_KEY, operationId: 'op-cancel-1', text: 'After cancel' }], activity: [], receipts: {} } });
    const cp = await openConsumerCheckpoint(join(dir, 'page.json'), { scope: 'cancel-test' });
    const states = [];
    const ac = new AbortController();
    try {
      await assert.rejects(() => consumeAntigravityRequests({
        mode: 'agentapi',
        conversationId: CONV_ID,
        cwd: dir,
        lsAddress: addr,
        csrfToken: 'tok',
        cancellingPollMs: 15,
        cancellingWaitMs: 2000,
        execute,
        page: { id: 'p1', slug: 'notes' },
        session: fake.session,
        checkpoint: cp,
        roster: makeRoster(),
        signal: ac.signal,
        onState: s => {
          states.push(s);
          if (s.state === 'sent') ac.abort();
        },
      }));
    } finally {
      await cp.close();
    }
    assert.ok(polls >= 2);
    assert.ok(states.some(s => s.state === 'deferred_cancelling'));
    assert.equal(sent.length, 1);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('coalesceMs batches multiple rapid unhandled requests into one agentapi send-message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-coalesce-'));
  try {
    const sent = [];
    const execute = async (_bin, argv) => {
      if (argv[0] === 'send-message') {
        sent.push(argv);
        return { stdout: JSON.stringify({ response: { sendMessage: { recipientId: CONV_ID } } }), stderr: '' };
      }
      throw Error(`unexpected: ${argv.join(' ')}`);
    };
    const ev1 = makeMessageEvent('op-c1', 'First');
    const ev2 = makeMessageEvent('op-c2', 'Second');
    const fake = makeFakeSession({
      events: [ev1, ev2],
      feed: {
        messages: [
          { author: USER_KEY, operationId: 'op-c1', text: 'First' },
          { author: USER_KEY, operationId: 'op-c2', text: 'Second' },
        ],
        activity: [],
        receipts: {},
      },
    });
    const cp = await openConsumerCheckpoint(join(dir, 'page.json'), { scope: 'coalesce-test' });
    const states = [];
    const ac = new AbortController();
    try {
      await assert.rejects(() => consumeAntigravityRequests({
        mode: 'agentapi',
        conversationId: CONV_ID,
        cwd: dir,
        coalesceMs: 20,
        execute,
        page: { id: 'p1', slug: 'notes' },
        session: fake.session,
        checkpoint: cp,
        roster: makeRoster(),
        signal: ac.signal,
        onState: s => {
          states.push(s);
          if (states.filter(x => x.state === 'sent').length === 2) ac.abort();
        },
      }));
    } finally {
      await cp.close();
    }
    assert.equal(sent.length, 1, 'Expected one coalesced send-message call for two rapid requests');
    assert.ok(sent[0].at(-1).includes('op-c1') && sent[0].at(-1).includes('op-c2'));
    assert.ok(states.every(s => s.coalescedCount === 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('liveness triggers ANTIGRAVITY_LS_GONE after lsLossThreshold consecutive failures to release lock cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-ls-gone-'));
  try {
    let permanentErr = null;
    const events = [];
    const fake = makeFakeSession();
    const liveness = createAntigravityConversationLiveness({
      mode: 'agentapi',
      conversationId: CONV_ID,
      cwd: dir,
      lsAddress: '127.0.0.1:1',
      csrfToken: 'tok',
      lsLossThreshold: 2,
      probeIntervalMs: 60_000,
      sessions: [{ page: { id: 'p1', slug: 'notes' }, session: fake.session }],
      onState: e => events.push(e),
      onPermanentLoss: err => { permanentErr = err; },
    });
    try {
      await liveness.probe(); // failure 1 (initial constructor probe)
      await liveness.probe(); // failure 2 -> triggers permanent loss
      assert.equal(permanentErr?.code, 'ANTIGRAVITY_LS_GONE');
      assert.ok(events.some(e => e.state === 'antigravity_ls_gone'));
    } finally {
      await liveness.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('headless-stream driver streams deltas to streamAgentReply, detects soft-denies, and rejects interactive conversation ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-headless-'));
  try {
    assert.equal(resolveAgyBinary({ ANTIGRAVITY_AGENTAPI_EXE: '/home/u/.local/bin/agy' }), '/home/u/.local/bin/agy');
    // Refuse concurrent attachment to currently open interactive conversation.
    assert.throws(
      () => createHeadlessStreamDriver({
        cwd: dir,
        conversationId: CONV_ID,
        interactiveConversationId: CONV_ID,
      }),
      err => err.code === 'ANTIGRAVITY_HEADLESS_CONCURRENT_CONVERSATION',
    );

    const fakeProc = new EventEmitter();
    fakeProc.stdin = new PassThrough();
    fakeProc.stdout = new PassThrough();
    fakeProc.stderr = new PassThrough();
    fakeProc.exitCode = null;
    fakeProc.kill = () => { fakeProc.exitCode = 0; fakeProc.emit('exit', 0); };

    const written = [];
    fakeProc.stdin.on('data', chunk => {
      const line = chunk.toString('utf8').trim();
      if (!line) return;
      written.push(JSON.parse(line));
      setTimeout(() => {
        fakeProc.stdout.write(JSON.stringify({ event: 'init', conversation_id: CREATED_CONV_ID, init: { permission_mode: 'auto' } }) + '\n');
        fakeProc.stderr.write('Notice: tool run_command was soft-denied in headless mode\n');
        fakeProc.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: CREATED_CONV_ID, step_type: 'agent_response', text_delta: 'Working on it...' } }) + '\n');
        fakeProc.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: CREATED_CONV_ID, status: 'SUCCESS', response: 'Working on it...', num_turns: 1 } }) + '\n');
      }, 10);
    });

    const states = [];
    const driver = createHeadlessStreamDriver({
      cwd: dir,
      spawnProcess: () => fakeProc,
    }, { onState: s => states.push(s) });

    const ev = makeMessageEvent('op-hs-1', 'Run check');
    const fake = makeFakeSession({ events: [ev], feed: { messages: [{ author: USER_KEY, operationId: 'op-hs-1', text: 'Run check' }], activity: [], receipts: {} } });
    const cp = await openConsumerCheckpoint(join(dir, 'page.json'), { scope: 'hs-test' });
    const ac = new AbortController();
    try {
      await assert.rejects(() => consumeAntigravityRequests({
        mode: 'headless-stream',
        cwd: dir,
        headlessDriver: driver,
        handle: 'atlas',
        page: { id: 'p1', slug: 'notes' },
        session: fake.session,
        checkpoint: cp,
        roster: makeRoster(),
        signal: ac.signal,
        onState: s => {
          states.push(s);
          if (s.state === 'headless-done') ac.abort();
        },
      }));
    } finally {
      await driver.close();
      await cp.close();
    }

    assert.equal(written.length, 1);
    assert.equal(written[0].event, 'user');
    assert.ok(fake.signalFrames.some(f => f.topic === 'agent/stream' && f.payload.text === 'Working on it...'));
    assert.ok(fake.signalFrames.some(f => f.topic === 'agent/stream' && f.payload.done === true));
    const doneState = states.find(s => s.state === 'headless-done');
    assert.equal(doneState.source, 'agy/headless-stream');
    assert.equal(doneState.durableReplyVerified, false);
    assert.ok(doneState.softDenials.length >= 1);
    assert.ok(states.some(s => s.state === 'headless_soft_deny_detected'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAntigravityDoctor detects sandbox network block and outputs exact permissions.allow snippet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-doctor-'));
  try {
    await writeFile(join(dir, 'tendriller.json'), JSON.stringify({ service: 'https://tendriller.dev' }));
    const report = await runAntigravityDoctor({
      cwd: dir,
      conversationId: CONV_ID,
      execute: async (_bin, argv) => {
        if (argv[0] === 'send-message') return { stdout: 'Usage: agentapi send-message --title', stderr: '' };
        if (argv[0] === '--version') return { stdout: 'agy 1.5.18', stderr: '' };
        if (argv[0] === 'get-conversation-metadata') {
          return { stdout: JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: 'p', workspaceUris: [pathToFileURL(dir).href] } } } }), stderr: '' };
        }
        throw Error('unexpected');
      },
      fetchImpl: async () => { throw Error('connect EACCES sandbox'); },
    });
    assert.equal(report.ok, false);
    assert.equal(report.recommendedMode, 'agentapi');
    assert.ok(report.checks.some(c => c.name === 'service_readiness' && c.sandboxLikelyBlocked === true));
    assert.deepEqual(report.sandboxPermissionsSnippet, {
      permissions: {
        allow: [
          'command(npx tendril)',
          'command(node consumers/antigravity-bridge.mjs)',
          'read_url(tendriller.dev)',
        ],
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native Antigravity plugin hooks (SessionStart & Stop) inspect bridge status cleanly and never loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-hooks-'));
  try {
    await writeFile(join(dir, 'tendriller.json'), JSON.stringify({ service: 'https://tendriller.dev' }));
    const statusDir = join(dir, '.tendriller', 'consumers', 'antigravity', CONV_ID);
    await mkdir(statusDir, { recursive: true });
    await writeFile(join(statusDir, 'bridge-status.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      mode: 'agentapi',
      state: 'running',
      conversationId: CONV_ID,
      lsAddress: 'localhost:11111',
      pages: ['notes'],
      pendingByPage: { notes: 2 },
      pendingCount: 2,
    }));

    const runHook = (script, stdinObj, extraEnv = {}) => new Promise((resolvePromise, rejectPromise) => {
      const child = execFile(process.execPath, [join(REPO_ROOT, 'plugin/antigravity/hooks', script)], {
        env: { ...process.env, ...extraEnv },
      }, (err, stdout) => {
        if (err) rejectPromise(err);
        else resolvePromise(JSON.parse(stdout.trim()));
      });
      child.stdin.end(JSON.stringify(stdinObj));
    });

    // SessionStart detects LS address mismatch on resume and injects guidance.
    const startOut = await runHook('session-start.mjs', {
      conversationId: CONV_ID,
      cwd: dir,
      workspacePaths: [dir],
    }, { ANTIGRAVITY_LS_ADDRESS: 'localhost:22222' });
    assert.ok(startOut.injectSteps?.[0]?.systemMessage?.systemMessage.includes('earlier CLI Language Server'));

    // Stop hook requests continuation when pendingCount > 0 and continuationActive is false.
    const stopContinue = await runHook('stop-check.mjs', {
      conversationId: CONV_ID,
      cwd: dir,
      workspacePaths: [dir],
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      continuationActive: false,
    });
    assert.equal(stopContinue.decision, 'continue');
    assert.ok(stopContinue.reason.includes('notes (2)'));

    // Stop hook stays silent when continuationActive is already true (no loop!).
    const stopOnce = await runHook('stop-check.mjs', {
      conversationId: CONV_ID,
      cwd: dir,
      workspacePaths: [dir],
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      continuationActive: true,
    });
    assert.deepEqual(stopOnce, {});

    // Stop hook respects USER_CANCELED.
    const stopCanceled = await runHook('stop-check.mjs', {
      conversationId: CONV_ID,
      cwd: dir,
      workspacePaths: [dir],
      terminationReason: 'USER_CANCELED',
      fullyIdle: true,
      continuationActive: false,
    });
    assert.deepEqual(stopCanceled, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
