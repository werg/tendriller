import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { authorityForDevices } from '../../collaboration/test/physical-fixture.mjs';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { agentRequestCommands, agentRequestQueries, consumerPresence, readAgentInbox,
  requestDelivery } from '../../docs/tutorial/shared/helpers/agent-requests.mjs';

const definition = p.defineApplication({ id: 'agent-requests-test', version: '1',
  commands: agentRequestCommands, queries: agentRequestQueries });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-requests-'));
  const path = join(directory, 'device.sqlite');
  let device = await openNativeDevice({ path, create: true }), session;
  t.after(async () => { try { if (session) await session.close(); else await device.close(); }
    finally { await rm(directory, { recursive: true, force: true }); } });
  const { authority, key: epochKey } = await authorityForDevices([device], { applicationId: '73'.repeat(32) });
  const open = async () => p.createApplicationSession({ device, definition, authority, epochKeys: new Map([[0, epochKey]]) });
  session = await open();
  return { get session() { return session; },
    async reopen() { await session.close(); session = undefined;
      device = await openNativeDevice({ path }); session = await open(); },
    async command(name, input, operationId) {
      const operation = await session.command(name, input, { operationId });
      const outcome = await operation.materialized({ signal: AbortSignal.timeout(5000) });
      assert.equal(outcome.outcome, 'accepted'); return operation;
    } };
}

test('public native session retains full request identity, author time, receipt, answer and heartbeat after reopen', { timeout: 20_000 }, async t => {
  const f = await fixture(t), operationId = 'namespaced-request-' + 'x'.repeat(350);
  const author = f.session.identity.publicKey, startedAtMs = Date.now();
  await assert.rejects(async () => f.session.command('agentRequest', {
    recipient: 'z'.repeat(64), topic: 'analysis', text: 'Invalid address',
  }, { operationId: 'invalid-address' }), /AGENT_REQUEST_IDENTITY_INVALID/);
  await f.command('agentRequest', { recipient: author, topic: 'analysis', text: 'What changed?' }, operationId);
  let inbox = (await f.session.query('agentInbox', null)).value;
  assert.equal(inbox.requests[0].requestOperationId, operationId);
  assert.equal(requestDelivery(inbox.requests[0]), 'awaiting-receipt');
  assert.ok(inbox.requests[0].sentAtMs >= startedAtMs);
  const reference = { requestAuthor: author, requestOperationId: operationId, consumerId: 'worker', runId: 'run-1' };
  await f.command('agentReceipt', reference, 'receipt-1');
  inbox = (await f.session.query('agentInbox', null)).value;
  assert.equal(requestDelivery(inbox.requests[0]), 'seen');
  await f.command('agentAnswer', { ...reference, text: 'Here is the result.' }, 'answer-1');
  // Exact retry cannot append another answer.
  await f.command('agentAnswer', { ...reference, text: 'Here is the result.' }, 'answer-1');
  await f.command('agentHeartbeat', { consumerId: 'worker', runId: 'run-1', role: 'analyst',
    topics: ['analysis'], startedAtMs, state: 'listening' }, 'heartbeat-1');
  await f.reopen();
  inbox = (await f.session.query('agentInbox', null)).value;
  assert.equal(requestDelivery(inbox.requests[0]), 'answered');
  assert.equal(inbox.requests[0].answers.length, 1);
  assert.equal(inbox.requests[0].receipts[0].author, author);
  assert.equal(inbox.requests[0].answers[0].text, 'Here is the result.');
  assert.equal(inbox.consumers[0].runId, 'run-1');
  assert.equal(consumerPresence(inbox.consumers[0], { observationCurrent: true }).status, 'available');
});

const event = (topic, author, operationId, payload, at = 1000) => ({
  topic: 'agent/' + topic, author, operationId, payload,
  authorTimestampMs: String(at), id: author + ':' + operationId,
});
function read(events, pageSize = 2) {
  return readAgentInbox({ readEvents({ cursor }) {
    const start = cursor === undefined ? 0 : Number(cursor), end = Math.min(start + pageSize, events.length);
    return { events: events.slice(start, end), cursor: String(end), hasMore: end < events.length };
  } });
}

test('pagination binds receipt/answer to both request author and full ID, rejects impersonation and never downgrades answered', () => {
  const reference = { requestAuthor: 'page-a', requestOperationId: 'same-id', consumerId: 'worker', runId: 'one' };
  const rows = [
    event('request', 'page-a', 'same-id', { recipient: 'native', topic: 'ask', text: 'A' }),
    event('request', 'page-b', 'same-id', { recipient: 'native', topic: 'ask', text: 'B' }),
    event('receipt', 'impostor', 'fake-receipt', reference),
    event('answer', 'impostor', 'fake-answer', { ...reference, text: 'Forged' }),
    event('answer', 'native', 'answer', { ...reference, text: 'Actual' }),
    event('receipt', 'native', 'late-receipt', reference),
    event('receipt', 'native', 'duplicate-receipt', reference),
  ];
  const result = read(rows).requests;
  assert.equal(requestDelivery(result[0]), 'answered');
  assert.equal(result[0].answers[0].text, 'Actual');
  assert.equal(result[0].answers.length, 1);
  assert.equal(result[0].receipts.length, 1);
  assert.equal(requestDelivery(result[1]), 'awaiting-receipt');
  assert.equal(read(rows.slice(2)).requests.length, 0, 'excluded/orphan facts cannot resurrect a request');
  assert.equal(requestDelivery(read(rows.slice(0, 2)).requests[0]), 'awaiting-receipt',
    're-deriving the coherent snapshot removes receipts and answers absent from it');
});

test('late readers see announcements, stale age changes without an event, restart replaces run and disconnected observations stay unknown', () => {
  const announce = { consumerId: 'worker', runId: 'one', role: 'analyst',
    topics: ['analysis'], startedAtMs: 900, state: 'listening' };
  const first = event('heartbeat', 'native', 'pulse-1', announce);
  const consumer = read([first]).consumers[0];
  assert.equal(consumerPresence(consumer, { now: 1000 }).status, 'unknown');
  assert.equal(consumerPresence(consumer, { now: 1000, observationCurrent: true }).status, 'available');
  assert.equal(consumerPresence(consumer, { now: 91_000, observationCurrent: true }).status, 'stale');
  assert.equal(consumerPresence(consumer, { now: 999, observationCurrent: true }).status, 'clock-skew');
  const restart = event('heartbeat', 'native', 'pulse-2', { ...announce, runId: 'two', startedAtMs: 95_000 }, 100_000);
  const next = read([first, restart]).consumers;
  assert.equal(next.length, 1); assert.equal(next[0].runId, 'two');
  assert.equal(next[0].startedAtMs, 95_000);
  const stopped = { ...next[0], state: 'stopped' };
  assert.equal(consumerPresence(stopped, { now: 101_000, observationCurrent: true }).status, 'stopped');
  assert.equal(consumerPresence(next[0], { now: 101_000, observationCurrent: false }).status, 'unknown');
  assert.equal(consumerPresence({ ...consumer, lastSeenAtMs: null }, { observationCurrent: true }).status, 'clock-skew');
});

test('a stalled retained-event cursor fails rather than spinning forever', () => {
  assert.throws(() => readAgentInbox({ readEvents: () => ({ events: [], hasMore: true, cursor: 'same' }) }),
    /AGENT_INBOX_CURSOR_STALLED/);
});

import { readFile, stat } from 'node:fs/promises';
import { runRequestWorker } from '../../docs/tutorial/consumers/request-worker.mjs';
import { openConsumerCheckpoint } from '../../docs/tutorial/shared/helpers/agent-consumer.mjs';

const eventually = async (check, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw Error('Consumer condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function workerFiles(t) {
  const directory = await mkdtemp(join(tmpdir(), 'request-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'checkpoint.json');
}
const checkpoint = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')).value; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const waitForCheckpoint = path => eventually(async () => {
  const value = await checkpoint(path);
  return Boolean(value?.cursor && value.pending === null);
});

test('runnable worker answers a second request after restart while the same native owner remains alive', { timeout: 25000 }, async t => {
  const f = await fixture(t), checkpointPath = await workerFiles(t);
  const answers = [];
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page',
    async handleRequest(request) { answers.push(request.requestOperationId); return 'Answer: ' + request.text; } };
  for (const id of ['first-worker-request', 'second-worker-request']) {
    await f.command('agentRequest', { recipient: f.session.identity.publicKey, topic: 'chat', text: id }, id);
    const stopped = new AbortController();
    const run = runRequestWorker(f.session, { ...options, signal: stopped.signal });
    const ended = assert.rejects(run, error => error === stopped.signal.reason);
    try {
      await eventually(async () => (await f.session.query('agentInbox', null)).value.requests
        .some(request => request.requestOperationId === id && requestDelivery(request) === 'answered'));
      await waitForCheckpoint(checkpointPath);
    } finally { stopped.abort(Error('Worker stopped')); await ended; }
    assert.equal(f.session.signal.aborted, false, 'worker cleanup must not close its owner');
    const inbox = (await f.session.query('agentInbox', null)).value;
    const request = inbox.requests.find(request => request.requestOperationId === id);
    assert.equal(request.receipts.length, 1);
    assert.equal(request.answers.length, 1);
    assert.equal(inbox.consumers.length, 0, 'ephemeral presence never adds durable heartbeat records');
  }
  assert.deepEqual(answers, ['first-worker-request', 'second-worker-request']);
});

test('lost answer acknowledgement retries the exact saved result without re-running the handler', { timeout: 25000 }, async t => {
  const f = await fixture(t), checkpointPath = await workerFiles(t);
  await f.command('agentRequest', { recipient: f.session.identity.publicKey, topic: 'chat', text: 'Retain result' }, 'uncertain-answer');
  let calls = 0, loseReply = true, views = 0;
  const session = {
    identity: f.session.identity, signal: f.session.signal, signals: f.session.signals,
    get status() { return f.session.status; }, onStatus: f.session.onStatus.bind(f.session),
    changes: f.session.changes.bind(f.session),
    query: f.session.query.bind(f.session),
    async readView() {
      const view = await f.session.readView(); views++;
      return { readEvents: view.readEvents.bind(view), async release() { await view.release(); views--; } };
    },
    async command(name, input, options) {
      const attempt = await f.session.command(name, input, options);
      if (name !== 'agentAnswer' || !loseReply) return attempt;
      loseReply = false;
      return { async materialized(options) { await attempt.materialized(options); throw Error('Lost answer acknowledgement'); } };
    },
  };
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page',
    async handleRequest() { assert.equal(views, 0, 'no captured read view spans handler work'); calls++; return 'Retained answer'; } };
  await assert.rejects(runRequestWorker(session, options), /Lost answer acknowledgement/);
  assert.equal((await checkpoint(checkpointPath)).pending.rows[0].phase, 'result');
  assert.equal(f.session.signal.aborted, false);
  const stopped = new AbortController();
  const run = runRequestWorker(session, { ...options, signal: stopped.signal });
  const ended = assert.rejects(run, error => error === stopped.signal.reason);
  try { await waitForCheckpoint(checkpointPath); }
  finally { stopped.abort(Error('Done')); await ended; }
  assert.equal(calls, 1);
  const request = (await f.session.query('agentInbox', null)).value.requests[0];
  assert.equal(request.receipts.length, 1);
  assert.equal(request.answers.length, 1);
  assert.equal(request.answers[0].text, 'Retained answer');
});

test('uncertain handler effects block automatic restart without advancing the handled cursor', { timeout: 20000 }, async t => {
  const f = await fixture(t), checkpointPath = await workerFiles(t);
  await f.command('agentRequest', { recipient: f.session.identity.publicKey, topic: 'chat', text: 'An external task' }, 'uncertain-handler');
  let effects = 0;
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page',
    async handleRequest() { effects++; throw Error('Provider outcome unknown'); } };
  await assert.rejects(runRequestWorker(f.session, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  const retained = await checkpoint(checkpointPath);
  assert.equal(retained.cursor, undefined);
  assert.equal(retained.pending.rows[0].phase, 'uncertain');
  await assert.rejects(runRequestWorker(f.session, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  assert.equal(effects, 1, 'supervisor restart cannot repeat an uncertain external effect');
  const request = (await f.session.query('agentInbox', null)).value.requests[0];
  assert.equal(requestDelivery(request), 'seen');
  assert.equal(f.session.signal.aborted, false);
});

test('private checkpoints reject concurrent writers and a different scope, preserving the saved cursor', async t => {
  const path = await workerFiles(t), scope = { page: 'one', topics: ['chat'] };
  const first = await openConsumerCheckpoint(path, { scope });
  scope.page = 'mutated-by-caller';
  await first.save({ cursor: 'handled', pending: null });
  await assert.rejects(openConsumerCheckpoint(path, { scope: { page: 'one', topics: ['chat'] } }), /AGENT_CONSUMER_LOCKED/);
  await first.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(openConsumerCheckpoint(path, { scope: { page: 'different', topics: ['chat'] } }), /CHECKPOINT_SCOPE_MISMATCH/);
  const next = await openConsumerCheckpoint(path, { scope: { topics: ['chat'], page: 'one' } });
  assert.deepEqual(next.read(), { cursor: 'handled', pending: null });
  await next.close();
});

test('a fresh worker checkpoint does not repeat a request already answered in retained history', { timeout: 20000 }, async t => {
  const f = await fixture(t), checkpointPath = await workerFiles(t), author = f.session.identity.publicKey;
  await f.command('agentRequest', { recipient: author, topic: 'chat', text: 'Already handled' }, 'historical-request');
  await f.command('agentAnswer', { requestAuthor: author, requestOperationId: 'historical-request',
    consumerId: 'assistant', runId: 'old-run', text: 'Previous durable result' }, 'previous-answer');
  let calls = 0;
  const stopped = new AbortController();
  const run = runRequestWorker(f.session, { consumerId: 'assistant', topics: ['chat'],
    checkpointPath, scope: 'same-page', signal: stopped.signal, async handleRequest() { calls++; return 'Duplicate'; } });
  const ended = assert.rejects(run, error => error === stopped.signal.reason);
  try { await waitForCheckpoint(checkpointPath); }
  finally { stopped.abort(Error('Done')); await ended; }
  assert.equal(calls, 0);
  const request = (await f.session.query('agentInbox', null)).value.requests[0];
  assert.equal(request.answers.length, 1);
  assert.equal(request.receipts.length, 0);
});

test('worker presence uses the pinned public session default signal TTL and stream contract', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-presence-route-')), cleanup = [];
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const devices = [];
  for (const name of ['worker', 'page']) {
    const device = await openNativeDevice({ path: join(directory, name + '.sqlite'), create: true });
    devices.push(device); cleanup.push(() => device.close());
  }
  const [workerDevice, pageDevice] = devices;
  const { authority, key: epochKey } = await authorityForDevices([workerDevice, pageDevice], { applicationId: '76'.repeat(32) });
  const sessions = [];
  for (const device of devices) {
    const session = await p.createApplicationSession({ device, definition, authority, epochKeys: new Map([[0, epochKey]]) });
    sessions.push(session); cleanup.push(() => session.close());
  }
  const [workerSession, pageSession] = sessions;
  const { createTestConnection } = await import('../observation-fixture/connection.mjs');
  let left, right;
  left = createTestConnection((lane, bytes) => right.accept(lane, bytes));
  right = createTestConnection((lane, bytes) => left.accept(lane, bytes));
  const links = await Promise.all([
    workerSession.connectPeer({ connection: left.connection, peerIdentity: pageSession.identity.publicKey }),
    pageSession.connectPeer({ connection: right.connection, peerIdentity: workerSession.identity.publicKey }),
  ]);
  cleanup.push(async () => { await Promise.all(links.map(link => link.close())); });
  const sent = [], failures = [];
  const { announceAgentPresence, watchAgentPresence } = await import('../../docs/tutorial/shared/helpers/agent-requests.mjs');
  const presence = announceAgentPresence({
    identity: workerSession.identity, signal: workerSession.signal,
    get status() { return workerSession.status; },
    onStatus: listener => workerSession.onStatus(listener),
    signals: {
      subscribe: workerSession.signals.subscribe.bind(workerSession.signals),
      async send(...args) {
        try { const frame = await workerSession.signals.send(...args); sent.push(frame); return frame; }
        catch (error) {
          // Closing the worker may cancel an in-flight response to the observer's
          // presence ping. Preserve every failure except that exact cancellation.
          if (!args[2]?.signal?.aborted || error !== args[2].signal.reason) failures.push(error);
          throw error;
        }
      },
    },
  }, { consumerId: 'assistant', topics: ['chat'] });
  cleanup.push(() => presence.close());
  const watcher = watchAgentPresence(pageSession, {
    peer: workerSession.identity.publicKey, consumerId: 'assistant', requestTopic: 'chat',
  });
  cleanup.push(() => watcher.close());
  await eventually(() => sent.length > 0 || failures.length > 0);
  assert.deepEqual(failures, [], 'default presence must not silently fail SIGNAL_TTL_INVALID');
  await eventually(() => watcher.snapshot().status === 'available');
  assert.equal(sent[0].expiresAtMs - sent[0].issuedAtMs, 30_000);
  assert.equal(sent[0].stream.streamId, 'assistant');
  assert.equal(watcher.snapshot().consumer.author, workerSession.identity.publicKey);
  await presence.close();
  await presence.done;
  await eventually(() => watcher.snapshot().status === 'stopped');
  assert.equal(sent.at(-1).payload.state, 'stopped');
  assert.deepEqual(failures, []);
  assert.equal(workerSession.signal.aborted, false);
  assert.equal(pageSession.signal.aborted, false);
  assert.deepEqual((await workerSession.query('agentInbox', null)).value.requests, [],
    'stopping worker presence leaves the native application owner usable');
});

test('a stale cursor rescans the snapshot, skips answered requests and keeps the full original request reference', { timeout: 25000 }, async t => {
  const f = await fixture(t), checkpointPath = await workerFiles(t), author = f.session.identity.publicKey;
  const longId = 'namespaced-' + 'y'.repeat(380), handled = [];
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page',
    async handleRequest(request) { handled.push(request); return 'Answer: ' + request.text; } };
  const runUntilCheckpoint = async id => {
    const stopped = new AbortController(), run = runRequestWorker(f.session, { ...options, signal: stopped.signal });
    const ended = assert.rejects(run, error => error === stopped.signal.reason);
    try {
      await eventually(async () => (await f.session.query('agentInbox', null)).value.requests
        .some(request => request.requestOperationId === id && requestDelivery(request) === 'answered'));
      await waitForCheckpoint(checkpointPath);
    } finally { stopped.abort(Error('Worker stopped')); await ended; }
  };
  await f.command('agentRequest', { recipient: author, topic: 'chat', text: 'first' }, longId);
  await runUntilCheckpoint(longId);
  const savedCursor = (await checkpoint(checkpointPath)).cursor;
  // Another operation (this worker's own answer already moved the revision; a new request moves it again).
  await f.command('agentRequest', { recipient: author, topic: 'chat', text: 'second' }, 'second-request');
  await runUntilCheckpoint('second-request');
  assert.deepEqual(handled.map(request => request.requestOperationId), [longId, 'second-request'],
    'the answered request is not handled again after the snapshot is derived again');
  assert.equal(handled[0].requestOperationId.length, longId.length, 'the full original request identity is retained');
  assert.equal(handled[0].requestAuthor, author);
  const inbox = (await f.session.query('agentInbox', null)).value;
  for (const request of inbox.requests) {
    assert.equal(request.receipts.length, 1); assert.equal(request.answers.length, 1);
  }
  assert.notEqual((await checkpoint(checkpointPath)).cursor, savedCursor, 'the handled cursor follows the new snapshot');
});

test('an in-flight uncertain handler row survives a later revision and sends no new notice or effect', { timeout: 20000 }, async t => {
  const f = await fixture(t), checkpointPath = await workerFiles(t), author = f.session.identity.publicKey;
  await f.command('agentRequest', { recipient: author, topic: 'chat', text: 'external' }, 'uncertain-rescan');
  let effects = 0;
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page',
    async handleRequest() { effects++; throw Error('Provider outcome unknown'); } };
  await assert.rejects(runRequestWorker(f.session, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  const retained = (await checkpoint(checkpointPath)).pending.rows[0];
  assert.equal(retained.phase, 'uncertain');
  // A later revision changes the snapshot; the uncertain row must still stop the worker.
  await f.command('agentRequest', { recipient: author, topic: 'chat', text: 'later' }, 'later-request');
  await assert.rejects(runRequestWorker(f.session, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  assert.equal(effects, 1, 'uncertainty never repeats the external effect');
  const after = (await checkpoint(checkpointPath)).pending.rows[0];
  assert.deepEqual(after.request, retained.request, 'the full original request reference is unchanged');
  assert.equal(after.phase, 'uncertain');
  const requests = (await f.session.query('agentInbox', null)).value.requests;
  assert.equal(requests.find(request => request.requestOperationId === 'later-request').receipts.length, 0,
    'no later request is acknowledged while an uncertain row is retained');
});
