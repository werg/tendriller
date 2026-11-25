import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCodexQueueSupport, consumeCodexRequests, runCodexQueueBridge } from '../../docs/tutorial/consumers/codex-queue.mjs';
import { openConsumerCheckpoint } from '../../docs/tutorial/shared/helpers/agent-consumer.mjs';

const threadId = '01234567-89ab-4cde-8fab-0123456789ab';
const deviceId = '11'.repeat(32), author = '22'.repeat(32);
const options = { threadId, cwd: '/workspace/project', requestTopics: ['chat'], remote: 'unix://' };
const page = { id: 'page-one', slug: 'notes' };
const request = (id, overrides = {}) => ({ id, author, operationId: id, topic: 'agent/request',
  payload: { recipient: deviceId, topic: 'chat', text: 'Private authored request text.' }, ...overrides });
const ack = id => ({ stdout: `Queued message ${id} for thread ${threadId}.\n`, stderr: '' });

function sessionFor(events, { answers = [], wait = false } = {}) {
  const owner = new AbortController();
  let releases = 0, listener, detach = 0;
  const session = { deviceId, signal: owner.signal,
    onRecovery(fn) { listener = fn; return () => { listener = undefined; }; },
    async *changes({ signal }) {
      yield { kind: 'applied' };
      if (wait) await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    async readView() { return {
      async readEvents({ cursor, topics }) {
        assert.deepEqual(topics, ['agent/request']);
        return { events: cursor ? [] : events, cursor: 'next-cursor', hasMore: false };
      },
      async release() { releases++; },
    }; },
    async query(name) { assert.equal(name, 'agentInbox'); return { value: { requests: answers } }; },
    command() { throw Error('A bridge must never acknowledge or answer for the worker.'); },
  };
  return { session, owner, get releases() { return releases; }, get listening() { return Boolean(listener); },
    attach: async () => ({ session, async detach() { detach++; } }), get detaches() { return detach; } };
}

async function durable(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-queue-'));
  const path = join(directory, 'checkpoint.json'), scope = { ...options, page: page.id };
  let current = await openConsumerCheckpoint(path, { scope });
  t.after(async () => { await current.close(); await rm(directory, { recursive: true, force: true }); });
  return { get checkpoint() { return current; }, directory,
    async reopen() { await current.close(); current = await openConsumerCheckpoint(path, { scope }); return current; } };
}

const consume = (session, checkpoint, extra = {}) => consumeCodexRequests({ ...options, page, session, checkpoint, ...extra });

test('bridge sends only addressed selected requests to one exact UUID without shell evaluation, receipt or presence', async t => {
  const state = await durable(t), calls = [], notices = [];
  const dangerousId = '$(touch /tmp/never) `echo never`';
  const events = [request(dangerousId), request('other-author', { author: '33'.repeat(32), operationId: dangerousId }),
    request('foreign-recipient', { payload: { recipient: '44'.repeat(32), topic: 'chat' } }),
    request('other-topic', { payload: { recipient: deviceId, topic: 'fetch' } }), request('answered')];
  const f = sessionFor(events, { answers: [{ requestAuthor: author, requestOperationId: 'answered', answers: [{}] }] });
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
  assert.equal(f.releases, 1); assert.equal(f.listening, false); assert.equal(f.owner.signal.aborted, false);
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

test('outbox checkpoint failure prevents enqueue and changed selected history cannot authorize pending delivery', async t => {
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
    pages: [{ ...page, attach: one.attach }, { id: 'page-two', slug: 'other', attach: two.attach }],
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
  altered.pending.requests[0].request.topic = 'another-topic';
  await state.checkpoint.save(altered); await state.reopen();
  await assert.rejects(consume(sessionFor(events).session, state.checkpoint, { execute }), { code: 'CODEX_QUEUE_REVIEW_HISTORY' });
  assert.equal(calls, 0);
});
