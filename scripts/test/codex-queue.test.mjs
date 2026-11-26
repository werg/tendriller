import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { openCodexRpc } from '../../docs/tutorial/shared/helpers/codex-rpc.mjs';
import { checkCodexQueueSupport, consumeCodexRequests, runCodexQueueBridge } from '../../docs/tutorial/consumers/codex-queue.mjs';
import { openConsumerCheckpoint } from '../../docs/tutorial/shared/helpers/agent-consumer.mjs';

const threadId = '01234567-89ab-4cde-8fab-0123456789ab';
const deviceId = '11'.repeat(32), author = '22'.repeat(32);
const roster = async () => ({ primary_agent_id: null, is_primary: false, agents: [] });
const options = { threadId, cwd: '/workspace/project', requestTopics: ['chat'], remote: 'unix://',
  connect: async () => rpcFor().client };
const page = { id: 'page-one', slug: 'notes', roster };
// A request is a chat agentMessage addressed to this agent's signing key.
const request = (id, overrides = {}) => ({ id, author, operationId: id, topic: 'agent/message',
  payload: { channel: 'chat', to: [deviceId], text: 'Private authored request text.' }, ...overrides });
// This agent's durable reply naming the full original message identity.
const replied = (operationId, messageAuthor = author) => ({ author: deviceId, operationId: 'reply-' + operationId,
  inReplyTo: { author: messageAuthor, operationId } });
const ack = id => ({ stdout: `Queued message ${id} for thread ${threadId}.\n`, stderr: '' });

const rpcError = (message, extra = {}) => Object.assign(Error('Rejected'), {
  code: 'CODEX_RPC_REJECTED', rpcCode: -32600, rpcMessage: message, ...extra,
});
function rpcFor({ snapshots = [{ runtime: 'idle', status: 'completed', id: 'turn-old' }],
  steer = async params => ({ turnId: params.expectedTurnId }), cwd = options.cwd } = {}) {
  const calls = []; let read = -1, closed = 0;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      assert.equal(params.threadId, threadId);
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false); read++;
        const snapshot = snapshots[Math.min(read, snapshots.length - 1)];
        return { thread: { id: threadId, cwd, status: { type: snapshot.runtime }, canAcceptDirectInput: true } };
      }
      if (method === 'thread/turns/list') {
        assert.deepEqual(params, { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const snapshot = snapshots[Math.min(read, snapshots.length - 1)];
        return { data: snapshot.id ? [{ id: snapshot.id, status: snapshot.status, items: [], itemsView: 'notLoaded' }] : [] };
      }
      if (method === 'turn/steer') return steer(params);
      throw Error('Unexpected RPC method');
    },
    async close() { closed++; },
  };
  return { client, calls, get closed() { return closed; } };
}

function sessionFor(events, { answers = [], wait = false, stale = false } = {}) {
  const owner = new AbortController();
  let releases = 0, detach = 0;
  // `changes()` sends no initial notification; the consumer performs its first coherent read.
  const session = { identity: { publicKey: deviceId }, signal: owner.signal,
    async *changes({ signal }) {
      if (wait) await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    async readView() { return {
      async readEvents({ cursor, topics }) {
        assert.deepEqual(topics, ['agent/message']);
        // A cursor from an earlier materialized revision fails; no cursor reads the current snapshot.
        if (cursor && stale) throw Object.assign(Error('EVENT_CURSOR_STALE'), { code: 'EVENT_CURSOR_STALE' });
        return { events: cursor ? [] : events, cursor: 'next-cursor', hasMore: false };
      },
      async release() { releases++; },
    }; },
    async query(name) { assert.equal(name, 'agentFeed'); return { value: { messages: answers, activity: [], receipts: {} } }; },
    command() { throw Error('A bridge must never acknowledge or answer for the worker.'); },
  };
  return { session, owner, get releases() { return releases; },
    attach: async () => ({ session, async detach() { detach++; } }), get detaches() { return detach; } };
}

async function durable(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-queue-'));
  const path = join(directory, 'checkpoint.json'), scope = { threadId, cwd: options.cwd, page: page.id };
  let current = await openConsumerCheckpoint(path, { scope });
  t.after(async () => { await current.close(); await rm(directory, { recursive: true, force: true }); });
  return { get checkpoint() { return current; }, directory,
    async reopen() { await current.close(); current = await openConsumerCheckpoint(path, { scope }); return current; } };
}

const consume = (session, checkpoint, extra = {}) => consumeCodexRequests({ ...options, page, session, checkpoint, roster, ...extra });

test('bridge sends only addressed selected requests to one exact UUID without shell evaluation, receipt or presence', async t => {
  const state = await durable(t), calls = [], notices = [];
  const dangerousId = '$(touch /tmp/never) `echo never`';
  const events = [request(dangerousId), request('other-author', { author: '33'.repeat(32), operationId: dangerousId }),
    request('foreign-recipient', { payload: { channel: 'chat', to: ['44'.repeat(32)], text: 'x' } }),
    request('own-message', { author: deviceId }),
    request('other-channel', { payload: { channel: 'agents', to: [deviceId], text: 'x' } }), request('answered')];
  const f = sessionFor(events, { answers: [replied('answered')] });
  await assert.rejects(consume(f.session, state.checkpoint, {
    execute: async (binary, argv, execution) => { calls.push({ binary, argv, execution }); return ack(`queue-${calls.length}`); },
    onState: value => notices.push(value),
  }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.binary, 'codex'); assert.equal(call.argv[0], 'queue');
    assert.equal(call.argv[call.argv.indexOf('--thread') + 1], threadId);
    assert.equal(call.argv[call.argv.indexOf('--remote') + 1], 'unix://');
    assert.ok(call.argv.includes('--resume')); assert.equal(call.execution.shell, false);
    assert.equal(call.execution.cwd, '/workspace/project');
    assert.ok(call.argv[call.argv.indexOf('--message') + 1].includes(dangerousId));
    assert.ok(!call.argv.join(' ').includes('Private authored request text.'));
  }
  assert.notEqual(notices[0].requestKey, notices[1].requestKey, 'same operation id from distinct authors is distinct work');
  assert.ok(notices.every(value => value.workerReceipt === false && value.wakeVerified === false));
  assert.equal(state.checkpoint.read().cursor, 'next-cursor'); assert.equal(state.checkpoint.read().pending, null);
  assert.equal(f.releases, 1); assert.equal(f.owner.signal.aborted, false);
});

test('exit zero with resume warning persists queued state and never blindly enqueues again after restart', async t => {
  const state = await durable(t), f = sessionFor([request('wake')]);
  let calls = 0;
  const execute = async () => { calls++; return { ...ack('retained-queue-id'),
    stderr: `Warning: message was queued, but could not resume thread ${threadId}: active writer\n` }; };
  await assert.rejects(consume(f.session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_RESUME_UNCONFIRMED' });
  assert.equal(state.checkpoint.read().cursor, null);
  assert.equal(state.checkpoint.read().pending.requests[0].status, 'resume-unconfirmed');
  assert.equal(state.checkpoint.read().pending.requests[0].queuedSubmissionId, 'retained-queue-id');
  await state.reopen();
  await assert.rejects(consume(sessionFor([request('wake')]).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
  assert.equal(calls, 1);
});

test('uncertain subprocess completion retains original work and blocks automatic resend across reopen', async t => {
  const state = await durable(t); let calls = 0;
  const execute = async () => { calls++; throw Object.assign(Error('deadline'), { killed: true }); };
  await assert.rejects(consume(sessionFor([request('uncertain')]).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(state.checkpoint.read().pending.requests[0].status, 'uncertain');
  await state.reopen();
  await assert.rejects(consume(sessionFor([request('uncertain')]).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
  assert.equal(calls, 1); assert.equal(state.checkpoint.read().cursor, null);
});

test('acknowledged outbox survives a failed cursor commit and skips delivered requests while retaining a new batch tail', async t => {
  const state = await durable(t); let calls = 0;
  const execute = async () => ack(`queue-${++calls}`);
  const failedCommit = { read: () => state.checkpoint.read(), async save(value) {
    if (value.pending === null) throw Error('simulated final checkpoint failure');
    await state.checkpoint.save(value);
  } };
  await assert.rejects(consume(sessionFor([request('first')]).session, failedCommit, { execute }), /simulated final checkpoint failure/);
  assert.equal(state.checkpoint.read().pending.requests[0].status, 'queued');
  await state.reopen();
  await assert.rejects(consume(sessionFor([request('first'), request('second')]).session, state.checkpoint, { execute }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(calls, 2, 'first request was not sent again');
  assert.equal(state.checkpoint.read().pending, null); assert.equal(state.checkpoint.read().cursor, 'next-cursor');
});

test('a stale cursor derives events again without notifying the conversation twice', async t => {
  const state = await durable(t), sent = [];
  const execute = async (_binary, argv) => { sent.push(argv[argv.indexOf('--message') + 1]); return ack(`queue-${sent.length}`); };
  await assert.rejects(consume(sessionFor([request('first')]).session, state.checkpoint, { execute }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.length, 1);
  assert.equal(state.checkpoint.read().cursor, 'next-cursor');
  assert.equal(state.checkpoint.read().delivered.length, 1, 'delivered but unanswered work is retained');
  // A later materialized revision makes the saved cursor stale: the same events plus a new one are re-derived.
  await state.reopen();
  await assert.rejects(consume(sessionFor([request('first'), request('second')], { stale: true }).session,
    state.checkpoint, { execute }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.length, 2, 'only the new request was sent');
  assert.ok(sent[1].includes('second'));
  assert.equal(state.checkpoint.read().delivered.length, 2);
  // Once the application records an answer, the delivered marker is dropped.
  await state.reopen();
  const answered = [replied('first')];
  await assert.rejects(consume(sessionFor([request('first'), request('second')], { stale: true, answers: answered }).session,
    state.checkpoint, { execute }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.length, 2);
  assert.equal(state.checkpoint.read().delivered.length, 1);
});

test('an uncertain notice survives stale-snapshot rescans with its full request reference and sends nothing new', async t => {
  const state = await durable(t), sent = [];
  const ok = async (_binary, argv) => { sent.push(argv); return ack(`queue-${sent.length}`); };
  await assert.rejects(consume(sessionFor([request('first')]).session, state.checkpoint, { execute: ok }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.length, 1);
  await state.reopen();
  // A later revision makes the saved cursor stale; delivering the new request is uncertain.
  await assert.rejects(consume(sessionFor([request('first'), request('second')], { stale: true }).session, state.checkpoint,
    { execute: async () => { throw Error('outcome unknown'); } }), { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
  const retained = state.checkpoint.read().pending.requests.find(row => row.status === 'uncertain');
  assert.equal(retained.request.messageOperationId, 'second');
  assert.equal(retained.request.messageAuthor, author, 'the full original message reference is retained');
  assert.equal(state.checkpoint.read().delivered.length, 1, 'the earlier delivery stays recorded');
  for (const stale of [true, false]) {
    await state.reopen();
    await assert.rejects(consume(sessionFor([request('first'), request('second'), request('third')], { stale }).session, state.checkpoint,
      { execute: ok }), { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
    assert.equal(sent.length, 1, 'no new notice is sent while an uncertain admission is retained');
    assert.deepEqual(state.checkpoint.read().pending.requests.find(row => row.status === 'uncertain').request, retained.request);
  }
});

test('outbox checkpoint failure prevents enqueue and a changed projection cannot authorize pending delivery', async t => {
  const state = await durable(t); let calls = 0;
  const execute = async () => { calls++; return ack('unexpected'); };
  await assert.rejects(consume(sessionFor([request('first')]).session,
    { read: () => null, save: async () => { throw Error('disk full'); } }, { execute }), /disk full/);
  assert.equal(calls, 0);
  await assert.rejects(consume(sessionFor([request('first')]).session, state.checkpoint,
    { execute: async () => { throw Error('uncertain'); } }), { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
  await assert.rejects(consume(sessionFor([request('replacement')]).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_REVIEW_HISTORY' });
  assert.equal(calls, 0);
});

test('capability preflight is read-only and refuses older or ambiguously targeted clients', async () => {
  const calls = [];
  const execute = async (binary, args) => { calls.push([binary, args]); return { stdout: '--thread --message --resume --remote', stderr: '' }; };
  await checkCodexQueueSupport({ ...options, execute });
  assert.deepEqual(calls, [['codex', ['queue', '--help']]]);
  await assert.rejects(checkCodexQueueSupport({ ...options, execute: async () => ({ stdout: '--thread --message', stderr: '' }) }), { code: 'CODEX_QUEUE_UNSUPPORTED' });
  await assert.rejects(checkCodexQueueSupport({ ...options, threadId: '--last', execute }), { code: 'CODEX_QUEUE_OPTIONS_INVALID' });
  await assert.rejects(checkCodexQueueSupport({ ...options, remote: 'wss://user:secret@example.com', execute }), { code: 'CODEX_QUEUE_REMOTE_INVALID' });
});

test('one bridge routes multiple pages to the same thread and detaches every owner after cancellation', async t => {
  const state = await durable(t), cancellation = new AbortController();
  const one = sessionFor([request('one')], { wait: true }), two = sessionFor([request('two')], { wait: true });
  const sent = []; let closed = false;
  const run = runCodexQueueBridge({ ...options, signal: cancellation.signal, stateDirectory: join(state.directory, 'multi'),
    pages: [{ ...page, attach: one.attach }, { id: 'page-two', slug: 'other', attach: two.attach, roster }],
    execute: async (_binary, argv) => {
      if (argv.includes('--help')) return { stdout: '--thread --message --resume --remote', stderr: '' };
      sent.push(argv); return ack(`queue-${sent.length}`);
    },
    onState: value => { if (value.state === 'queued' && sent.length === 2) cancellation.abort(Error('test stopped')); },
    onClosed: () => { closed = true; },
  });
  await assert.rejects(run, /test stopped/);
  assert.equal(sent.length, 2); assert.ok(sent.every(argv => argv[argv.indexOf('--thread') + 1] === threadId));
  assert.equal(one.detaches, 1); assert.equal(two.detaches, 1); assert.equal(closed, true);
  assert.equal(one.owner.signal.aborted, false); assert.equal(two.owner.signal.aborted, false);
});

test('malformed outbox and altered request references stop before any delivery on reopen', async t => {
  const state = await durable(t), events = [request('retained')];
  await assert.rejects(consume(sessionFor(events).session, state.checkpoint,
    { execute: async () => { throw Error('uncertain'); } }), { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
  const original = state.checkpoint.read();
  let calls = 0;
  const execute = async () => { calls++; return ack('unexpected'); };
  for (const change of [
    row => { row.status = 'unknown'; },
    row => { row.status = 'queued'; },
    row => { row.key = 'different'; },
  ]) {
    const corrupt = structuredClone(original); change(corrupt.pending.requests[0]);
    await state.checkpoint.save(corrupt); await state.reopen();
    await assert.rejects(consume(sessionFor(events).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_CHECKPOINT_INVALID' });
  }
  const altered = structuredClone(original);
  altered.pending.requests[0].request.channel = 'agents';
  await state.checkpoint.save(altered); await state.reopen();
  await assert.rejects(consume(sessionFor(events).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_REVIEW_HISTORY' });
  assert.equal(calls, 0);
});

test('active input is steered into the observed current turn with persisted identity and no queue invocation', async t => {
  const state = await durable(t), notices = [];
  let sent, queued = 0;
  const f = rpcFor({ snapshots: [{ runtime: 'active', status: 'inProgress', id: 'turn-active' }],
    steer: async params => {
      sent = params;
      const row = state.checkpoint.read().pending.requests[0];
      assert.equal(row.status, 'invoking'); assert.equal(row.source, 'turn/steer');
      assert.equal(row.expectedTurnId, 'turn-active'); assert.equal(row.clientUserMessageId, params.clientUserMessageId);
      assert.deepEqual(row.input, params.input);
      return { turnId: params.expectedTurnId };
    } });
  await assert.rejects(consume(sessionFor([request('during-turn')]).session, state.checkpoint, {
    connect: async () => f.client, execute: async () => { queued++; return ack('unexpected'); },
    onState: value => notices.push(value),
  }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.threadId, threadId); assert.equal(sent.expectedTurnId, 'turn-active');
  assert.equal(queued, 0); assert.equal(f.closed, 1);
  assert.equal(notices[0].state, 'steered'); assert.equal(notices[0].source, 'turn/steer');
  assert.equal(notices[0].workerReceipt, false); assert.equal(notices[0].wakeVerified, false);
});

test('known turn completion before steer re-reads metadata and queues only the original retained notice', async t => {
  const state = await durable(t), f = rpcFor({
    snapshots: [{ runtime: 'active', status: 'inProgress', id: 'turn-a' }, { runtime: 'idle', status: 'completed', id: 'turn-a' }],
    steer: async () => { throw rpcError('no active turn to steer'); },
  });
  let queued = 0, notice;
  await assert.rejects(consume(sessionFor([request('race')]).session, state.checkpoint, {
    connect: async () => f.client, execute: async (_binary, argv) => {
      queued++; assert.ok(argv.includes('--resume'));
      assert.equal(argv[argv.indexOf('--message') + 1], state.checkpoint.read().pending.requests[0].input[0].text);
      return ack('race-queue');
    }, onState: value => { notice = value; },
  }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(queued, 1); assert.equal(notice.state, 'queued'); assert.equal(notice.source, 'thread/queue/add');
  assert.equal(f.calls.filter(call => call.method === 'thread/read').length, 2);
});

test('changed active turn gets one freshly observed steering attempt with the same admission identity', async t => {
  const state = await durable(t), steers = [];
  const f = rpcFor({
    snapshots: [{ runtime: 'active', status: 'inProgress', id: 'turn-a' }, { runtime: 'active', status: 'inProgress', id: 'turn-b' }],
    steer: async params => {
      steers.push(params);
      if (steers.length === 1) throw rpcError('expected active turn id `turn-a` but found `turn-b`');
      return { turnId: params.expectedTurnId };
    },
  });
  await assert.rejects(consume(sessionFor([request('new-turn')]).session, state.checkpoint, {
    connect: async () => f.client, execute: async () => { assert.fail('A fresh active turn must be steered, not queued.'); },
  }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.deepEqual(steers.map(params => params.expectedTurnId), ['turn-a', 'turn-b']);
  assert.equal(steers[0].clientUserMessageId, steers[1].clientUserMessageId);
  assert.deepEqual(steers[0].input, steers[1].input);
});

test('interrupted threads and pending stop races remain queued without resume', async t => {
  for (const scenario of [
    { snapshots: [{ runtime: 'notLoaded', status: 'interrupted', id: 'stopped' }] },
    { snapshots: [{ runtime: 'active', status: 'inProgress', id: 'stopping' }],
      steer: async () => { throw rpcError('no active turn to steer'); } },
  ]) {
    const state = await durable(t), f = rpcFor(scenario); let queued = 0;
    await assert.rejects(consume(sessionFor([request('preserve-stop')]).session, state.checkpoint, {
      connect: async () => f.client, execute: async (_binary, argv) => {
        queued++; assert.ok(!argv.includes('--resume')); return ack('paused');
      },
    }), /AGENT_CONSUMER_STREAM_ENDED/);
    assert.equal(queued, 1);
  }
});

test('uncertain or unqualified steering never falls back to queue, including after restart', async t => {
  for (const outcome of [
    async () => { throw Object.assign(Error('deadline'), { code: 'CODEX_RPC_TIMEOUT' }); },
    async () => { throw rpcError('direct app-server input is not allowed for multi-agent v2 sub-agents'); },
    async () => { throw rpcError('no active turn to steer', { rpcData: { unknown: true } }); },
    async () => ({ turnId: 'unexpected-other-turn' }),
  ]) {
    const state = await durable(t); let steers = 0, queued = 0;
    const f = rpcFor({ snapshots: [{ runtime: 'active', status: 'inProgress', id: 'turn-a' }],
      steer: async params => { steers++; return outcome(params); } });
    const selected = { connect: async () => f.client, execute: async () => { queued++; return ack('unexpected'); } };
    await assert.rejects(consume(sessionFor([request('uncertain-steer')]).session, state.checkpoint, selected),
      { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
    const retained = state.checkpoint.read().pending.requests[0];
    assert.equal(retained.status, 'uncertain'); assert.equal(retained.source, 'turn/steer');
    assert.ok(retained.clientUserMessageId); assert.ok(retained.input[0].text);
    await state.reopen();
    await assert.rejects(consume(sessionFor([request('uncertain-steer')]).session, state.checkpoint, selected),
      { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
    assert.equal(steers, 1); assert.equal(queued, 0);
  }
});

test('bounded active-turn churn stops with retained known rejection instead of steering stale input', async t => {
  const state = await durable(t); let steers = 0;
  const f = rpcFor({
    snapshots: ['a', 'b', 'c'].map(id => ({ runtime: 'active', status: 'inProgress', id: 'turn-' + id })),
    steer: async params => {
      const next = ['turn-b', 'turn-c'][steers++];
      throw rpcError('expected active turn id `' + params.expectedTurnId + '` but found `' + next + '`');
    },
  });
  await assert.rejects(consume(sessionFor([request('churn')]).session, state.checkpoint, {
    connect: async () => f.client, execute: async () => assert.fail('Churn is not permission to enqueue.'),
  }), { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
  assert.equal(steers, 2); assert.equal(state.checkpoint.read().pending.requests[0].status, 'steer-rejected');
});

test('selected workspace mismatch stops before any mutation and keeps prepared input', async t => {
  const state = await durable(t), f = rpcFor({ cwd: '/another/workspace' });
  await assert.rejects(consume(sessionFor([request('wrong-workspace')]).session, state.checkpoint, {
    connect: async () => f.client, execute: async () => assert.fail('Wrong workspace must not queue.'),
  }), { code: 'CODEX_QUEUE_THREAD_UNAVAILABLE' });
  assert.equal(state.checkpoint.read().pending.requests[0].status, 'prepared');
  assert.ok(!f.calls.some(call => call.method === 'turn/steer'));
});

test('Unix RPC performs a real WebSocket handshake on the selected socket with read-only daemon discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-rpc-'));
  // Keep the Unix socket under this scratch directory without exceeding sockaddr_un.
  const directoryHandle = process.platform === 'linux' ? await open(directory, 'r') : undefined;
  const socketDirectory = directoryHandle ? `/proc/${process.pid}/fd/${directoryHandle.fd}` : directory;
  const socketPath = join(socketDirectory, 'a socket.sock'), server = createServer();
  const websocket = new WebSocketServer({ server });
  const methods = [], discovery = [];
  websocket.on('connection', (socket, request) => {
    assert.equal(request.url, '/rpc'); assert.equal(request.headers.authorization, undefined);
    socket.on('message', data => {
      const message = JSON.parse(data); methods.push(message.method);
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id,
        result: message.method === 'initialize' ? {} : { turnId: 'synthetic-turn' } }));
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise(resolve => websocket.close(resolve));
    await new Promise(resolve => server.close(resolve));
    try { await directoryHandle?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const execute = async (binary, argv, settings) => {
    discovery.push({ binary, argv, settings });
    return { stdout: JSON.stringify({ status: 'running', socketPath }), stderr: '' };
  };
  for (const remote of ['unix://' + socketPath, 'unix://']) {
    const rpc = await openCodexRpc({ cwd: process.cwd(), remote, timeoutMs: 2000, execute });
    try { assert.deepEqual(await rpc.request('turn/steer', { synthetic: true }), { turnId: 'synthetic-turn' }); }
    finally { await rpc.close(); }
  }
  assert.equal(discovery.length, 1); assert.equal(discovery[0].binary, 'codex');
  assert.deepEqual(discovery[0].argv, ['app-server', 'daemon', 'version']);
  assert.equal(discovery[0].settings.shell, false); assert.equal(discovery[0].settings.maxBuffer, 64 * 1024);
  assert.deepEqual(methods, ['initialize', 'initialized', 'turn/steer', 'initialize', 'initialized', 'turn/steer']);
  await assert.rejects(openCodexRpc({ remote: 'unix://', cwd: process.cwd(),
    execute: async () => ({ stdout: JSON.stringify({ status: 'running', socketPath: 'relative.sock' }) }) }),
    { code: 'CODEX_RPC_SOCKET_INVALID' });
  await assert.rejects(openCodexRpc({ remote: 'unix://', cwd: process.cwd(), remoteAuthTokenEnv: 'TOKEN' }),
    { code: 'CODEX_RPC_AUTH_UNSUPPORTED' });
});

test('WebSocket RPC retains remote bearer routing and rejects server-initiated interactions', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const messages = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    socket.on('message', data => {
      const message = JSON.parse(data); messages.push(message);
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === 'thread/read') socket.send(JSON.stringify({ id: 991, method: 'item/commandExecution/requestApproval', params: {} }));
    });
  });
  const previous = process.env.TENDRILLER_CODEX_TEST_TOKEN;
  process.env.TENDRILLER_CODEX_TEST_TOKEN = 'synthetic-token';
  t.after(async () => {
    if (previous === undefined) delete process.env.TENDRILLER_CODEX_TEST_TOKEN;
    else process.env.TENDRILLER_CODEX_TEST_TOKEN = previous;
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const rpc = await openCodexRpc({ cwd: process.cwd(), remote: 'ws://127.0.0.1:' + server.address().port,
    remoteAuthTokenEnv: 'TENDRILLER_CODEX_TEST_TOKEN', timeoutMs: 2000 });
  try { await assert.rejects(rpc.request('thread/read', { synthetic: true }), { code: 'CODEX_RPC_INTERACTION_REQUIRED' }); }
  finally { await rpc.close(); }
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'thread/read']);
  await assert.rejects(openCodexRpc({ cwd: process.cwd(), remote: 'ws://example.com',
    remoteAuthTokenEnv: 'TENDRILLER_CODEX_TEST_TOKEN' }), { code: 'CODEX_RPC_AUTH_INSECURE' });
});

test('one bridge serializes all page admissions through connection close', async t => {
  const state = await durable(t), cancellation = new AbortController();
  let active = 0, maximum = 0, queued = 0;
  const pages = ['one', 'two'].map(slug => ({ id: slug, slug, attach: sessionFor([request(slug)], { wait: true }).attach, roster }));
  const connect = async () => {
    active++; maximum = Math.max(maximum, active);
    const rpc = rpcFor().client;
    return { request: rpc.request, async close() { await rpc.close(); active--; } };
  };
  await assert.rejects(runCodexQueueBridge({ ...options, connect, pages,
    stateDirectory: join(state.directory, 'serialized'), signal: cancellation.signal,
    execute: async (_binary, argv) => {
      if (argv.includes('--help')) return { stdout: '--thread --message --resume --remote', stderr: '' };
      queued++; await new Promise(resolve => setTimeout(resolve, 15)); return ack('serialized-' + queued);
    },
    onState: value => { if (value.state === 'queued' && queued === 2) cancellation.abort(Error('serialized done')); },
  }), /serialized done/);
  assert.equal(queued, 2); assert.equal(maximum, 1); assert.equal(active, 0);
});

test('general chat message routes to primary agent when host roster uses base64url public keys and avoids duplicate delivery on revision rescan', async t => {
  const state = await durable(t);
  const deviceB64Url = Buffer.from(deviceId, 'hex').toString('base64url');
  const hostRoster = async () => ({
    primary_agent_id: 'ag_primary',
    is_primary: true,
    agents: [{ id: 'ag_primary', handle: 'atlas', public_key: deviceB64Url, is_primary: true }],
  });
  const generalMsg = request('general-1', { payload: { channel: 'chat', to: [], text: 'Hello general chat' } });
  const sent = [];
  const execute = async (_binary, argv) => { sent.push(argv[argv.indexOf('--message') + 1]); return ack(`queue-${sent.length}`); };
  await assert.rejects(consume(sessionFor([generalMsg]).session, state.checkpoint, { roster: hostRoster, execute }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('general-1'));
  // Revision rescan with stale cursor must not deliver a duplicate copy.
  await state.reopen();
  await assert.rejects(consume(sessionFor([generalMsg], { stale: true }).session, state.checkpoint, { roster: hostRoster, execute }), /AGENT_CONSUMER_STREAM_ENDED/);
  assert.equal(sent.length, 1);
});

test('multi-page bridge preflights request-feed capabilities, names unsupported pages, and isolates supported pages under skip vs fail policy', async t => {
  const state = await durable(t);
  const supported = sessionFor([request('ok-msg')], { wait: true });
  const unsupportedSession = {
    ...sessionFor([], { wait: true }).session,
    async query(name) {
      throw Object.assign(Error(`APPLICATION_QUERY_UNKNOWN: ${name}`), { code: 'APPLICATION_QUERY_UNKNOWN' });
    },
  };
  let unsupportedDetaches = 0;
  const unsupportedPage = {
    id: 'page-recovery',
    slug: 'recovery',
    roster,
    attach: async () => ({ session: unsupportedSession, async detach() { unsupportedDetaches++; } }),
  };

  // 1) All selected pages unsupported -> fails cleanly up front with page-specific guidance + docs link.
  const allBadStates = [];
  await assert.rejects(runCodexQueueBridge({
    ...options,
    stateDirectory: join(state.directory, 'all-bad'),
    pages: [unsupportedPage],
    execute: async () => ({ stdout: '--thread --message --resume --remote', stderr: '' }),
    onState: s => allBadStates.push(s),
  }), err => {
    assert.equal(err.code, 'CODEX_QUEUE_REQUEST_FEED_MISSING');
    assert.match(err.message, /recovery/);
    assert.match(err.message, /agentFeed/);
    assert.match(err.message, /docs\/AGENT_REQUESTS\.md/);
    return true;
  });
  assert.equal(unsupportedDetaches, 1);
  assert.ok(allBadStates.some(s => s.page === 'recovery' && s.state === 'request_protocol_missing'));

  // 2) Mixed pages with explicit fail policy -> fails up front before opening checkpoints.
  await assert.rejects(runCodexQueueBridge({
    ...options,
    unsupportedPages: 'fail',
    stateDirectory: join(state.directory, 'mixed-fail'),
    pages: [{ ...page, attach: supported.attach }, unsupportedPage],
    execute: async () => ({ stdout: '--thread --message --resume --remote', stderr: '' }),
  }), { code: 'CODEX_QUEUE_REQUEST_FEED_MISSING' });

  // 3) Mixed pages with default skip policy -> skips unsupported page with diagnostic and still delivers supported page's requests.
  const cancellation = new AbortController();
  const mixedStates = [];
  const sent = [];
  const supported2 = sessionFor([request('ok-msg')], { wait: true });
  await assert.rejects(runCodexQueueBridge({
    ...options,
    signal: cancellation.signal,
    stateDirectory: join(state.directory, 'mixed-skip'),
    pages: [{ ...page, attach: supported2.attach }, unsupportedPage],
    execute: async (_binary, argv) => {
      if (argv.includes('--help')) return { stdout: '--thread --message --resume --remote', stderr: '' };
      sent.push(argv);
      return ack(`queue-${sent.length}`);
    },
    onState: s => {
      mixedStates.push(s);
      if (s.state === 'queued') cancellation.abort(Error('delivered supported'));
    },
  }), /delivered supported/);
  assert.equal(sent.length, 1);
  assert.ok(mixedStates.some(s => s.page === 'recovery' && s.state === 'skipped_unsupported' && s.docs === 'docs/AGENT_REQUESTS.md'));
  assert.ok(mixedStates.some(s => s.page === 'notes' && s.state === 'queued'));
});
