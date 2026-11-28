import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { genesisForDevices } from '../../collaboration/test/physical-fixture.mjs';
import { openNativeDevice } from '@chronolog/peer-session/native';
import {
  agentRequestCommands,
  agentRequestQueries,
  evaluateFailover,
  messageDelivery,
  normalizePublicKeyHex,
  parseAddressing,
  readAgentFeed,
  shouldAgentRespond,
} from '../../docs/tutorial/shared/helpers/agent-requests.mjs';

const AGENT_MESSAGE_REDUCER = `
export default {
  reduce(state, tx) {
    return { ok: true, state: { count: ((state && state.count) || 0) + 1 }, events: [{ topic: 'agent/message', payload: tx.payload }] };
  },
};
`;
const AGENT_RECEIPT_REDUCER = `
export default {
  reduce(state, tx) {
    return { ok: true, state: { count: ((state && state.count) || 0) + 1 }, events: [{ topic: 'agent/receipt', payload: tx.payload }] };
  },
};
`;
const agentBusGenesisOptions = {
  imports: { 'app/agent-message': AGENT_MESSAGE_REDUCER, 'app/agent-receipt': AGENT_RECEIPT_REDUCER },
  topics: {
    'agent/message': { module: 'app/agent-message' },
    'agent/receipt': { module: 'app/agent-receipt' },
  },
};

const definition = p.defineApplication({
  id: 'agent-bus-test',
  version: '1',
  commands: agentRequestCommands,
  queries: agentRequestQueries,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bus-'));
  const path = join(directory, 'device.sqlite');
  let device = await openNativeDevice({ path, create: true }), session;
  t.after(async () => {
    try { if (session) await session.close(); else await device.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const { genesisBytes, casNodes, key: epoch0Key } = await genesisForDevices([device], agentBusGenesisOptions);
  const open = async () => p.createApplicationSession({ device, definition, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, epoch0Key]]) });
  session = await open();
  return {
    get session() { return session; },
    async reopen() {
      await session.close();
      session = undefined;
      device = await openNativeDevice({ path });
      session = await open();
    },
    async command(name, input, operationId) {
      const operation = await session.command(name, input, { operationId });
      const outcome = await operation.materialized({ signal: AbortSignal.timeout(5000) });
      assert.equal(outcome.outcome, 'accepted');
      return operation;
    },
  };
}

test('multi-agent bus retains chat messages, backchannel activity and receipts across reopen', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const author = f.session.identity.publicKey;
  const opId = 'msg-' + 'x'.repeat(100);
  await assert.rejects(
    async () => f.session.command('agentMessage', { channel: 'chat', to: ['invalid-key'], text: 'Bad' }, { operationId: 'bad-1' }),
    /AGENT_MESSAGE_RECIPIENT_INVALID/,
  );

  await f.command('agentMessage', { channel: 'chat', to: [], text: 'Summarize the budget' }, opId);
  let feed = (await f.session.query('agentFeed', null)).value;
  assert.equal(feed.messages.length, 1);
  assert.equal(feed.messages[0].author, author);
  assert.equal(feed.messages[0].operationId, opId);
  assert.equal(messageDelivery(feed.messages[0], feed), 'delivered');

  await f.command('agentReceipt', { messageAuthor: author, messageOperationId: opId, runId: 'run-1', state: 'seen' }, 'rcpt-1');
  feed = (await f.session.query('agentFeed', null)).value;
  assert.equal(feed.receipts[`${author}:${opId}`].length, 1, 'the receipt is retained');
  assert.equal(messageDelivery(feed.messages[0], feed), 'delivered', 'a signer cannot acknowledge its own message');

  await f.command('agentMessage', {
    channel: 'agents',
    to: [author],
    text: 'Check row 4 totals',
    inReplyTo: { author, operationId: opId },
    hopCount: 1,
    expectReply: true,
  }, 'delegation-1');

  await f.command('agentMessage', {
    channel: 'chat',
    to: [],
    text: 'Budget summary: on track.',
    inReplyTo: { author, operationId: opId },
    expectReply: false,
  }, 'reply-1');

  await f.reopen();
  feed = (await f.session.query('agentFeed', null)).value;
  assert.equal(feed.messages.length, 2);
  assert.equal(feed.activity.length, 1);
  assert.equal(feed.activity[0].hopCount, 1);
  assert.equal(feed.messages[1].inReplyTo.operationId, opId);
  assert.equal(messageDelivery(feed.messages[0], feed), 'delivered', 'nor answer it on another agent\'s behalf');
});

test('messageDelivery counts only receipts and replies from other signers', () => {
  const user = 'a'.repeat(64), agent = 'b'.repeat(64);
  const message = { author: user, operationId: 'm1' };
  const feed = (receipts, messages = [message]) => ({ messages, activity: [], receipts: { [`${user}:m1`]: receipts } });
  assert.equal(messageDelivery(message, feed([])), 'delivered');
  assert.equal(messageDelivery(message, feed([{ author: user, state: 'done' }])), 'delivered');
  assert.equal(messageDelivery(message, feed([{ author: agent, state: 'seen' }])), 'seen');
  assert.equal(messageDelivery(message, feed([{ author: agent, state: 'thinking' }])), 'thinking');
  assert.equal(messageDelivery(message, feed([{ author: agent, state: 'done' }])), 'answered');
  assert.equal(messageDelivery(message, { messages: [message], receipts: {},
    activity: [{ author: agent, inReplyTo: { author: user, operationId: 'm1' } }] }), 'answered', 'a backchannel reply answers too');
  assert.equal(messageDelivery(message, feed([], [message, { author: user, inReplyTo: { author: user, operationId: 'm1' } }])), 'delivered');
});

test('parseAddressing resolves @handles, @all and voice prefixes against the roster', () => {
  const roster = {
    primary_agent_id: 'ag_1',
    agents: [
      { id: 'ag_1', handle: 'atlas', public_key: 'a'.repeat(64), is_primary: true },
      { id: 'ag_2', handle: 'reviewer', public_key: 'b'.repeat(64), is_primary: false },
    ],
  };
  assert.deepEqual(parseAddressing('General question', roster), { to: [], handles: [], explicit: false, broadcast: false });
  assert.deepEqual(parseAddressing('@reviewer check this diff', roster), { to: ['b'.repeat(64)], handles: ['reviewer'], explicit: true, broadcast: false });
  assert.deepEqual(parseAddressing('Hey reviewer, check this', roster), { to: ['b'.repeat(64)], handles: ['reviewer'], explicit: true, broadcast: false });
  assert.deepEqual(parseAddressing('@all please weigh in', roster), { to: ['*'], handles: ['*'], explicit: true, broadcast: true });
});

test('shouldAgentRespond enforces primary step-back, secondary silence, @all, expectReply and hopCount guardrails', () => {
  const userKey = '0'.repeat(64), atlasKey = 'a'.repeat(64), reviewerKey = 'b'.repeat(64);
  const roster = {
    primary_agent_id: 'ag_1',
    agents: [
      { id: 'ag_1', handle: 'atlas', public_key: atlasKey, is_primary: true },
      { id: 'ag_2', handle: 'reviewer', public_key: reviewerKey, is_primary: false },
    ],
  };
  const general = { author: userKey, channel: 'chat', to: [], text: 'Hello' };
  assert.equal(shouldAgentRespond(general, { selfPublicKey: atlasKey, roster }), true);
  assert.equal(shouldAgentRespond(general, { selfPublicKey: reviewerKey, roster }), false);

  const directSecondary = { author: userKey, channel: 'chat', to: [reviewerKey], text: '@reviewer help' };
  assert.equal(shouldAgentRespond(directSecondary, { selfPublicKey: atlasKey, roster }), false, 'primary steps back on direct secondary mention');
  assert.equal(shouldAgentRespond(directSecondary, { selfPublicKey: reviewerKey, roster }), true);

  const broadcast = { author: userKey, channel: 'chat', to: ['*'], text: '@all chime in' };
  assert.equal(shouldAgentRespond(broadcast, { selfPublicKey: atlasKey, roster }), true);
  assert.equal(shouldAgentRespond(broadcast, { selfPublicKey: reviewerKey, roster }), true);

  // Loop guardrails: own message, expectReply: false, hopCount >= 5.
  assert.equal(shouldAgentRespond({ ...general, author: atlasKey }, { selfPublicKey: atlasKey, roster }), false);
  assert.equal(shouldAgentRespond({ ...directSecondary, expectReply: false }, { selfPublicKey: reviewerKey, roster }), false);
  assert.equal(shouldAgentRespond({ ...directSecondary, hopCount: 5 }, { selfPublicKey: reviewerKey, roster }), false);

  // Backchannel delegation to secondary works when addressed, ignores unaddressed notes.
  assert.equal(shouldAgentRespond({ author: atlasKey, channel: 'agents', to: [reviewerKey], hopCount: 1, text: 'audit' }, { selfPublicKey: reviewerKey, roster }), true);
  assert.equal(shouldAgentRespond({ author: atlasKey, channel: 'agents', to: [], hopCount: 1, text: 'log' }, { selfPublicKey: reviewerKey, roster }), false);
});

test('evaluateFailover suppresses offline/no-backup cases and triggers on stopped, offline threshold, or unacknowledged message', () => {
  const atlasKey = 'a'.repeat(64), reviewerKey = 'b'.repeat(64);
  const roster = {
    primary_agent_id: 'ag_1',
    agents: [
      { id: 'ag_1', handle: 'atlas', public_key: atlasKey, kind: 'workspace', is_primary: true },
      { id: 'ag_2', handle: 'reviewer', public_key: reviewerKey, kind: 'workspace', is_primary: false },
    ],
  };
  const backupOnline = { [atlasKey]: { state: 'offline' }, [reviewerKey]: { state: 'online' } };
  // Suppressed while browser is offline.
  assert.equal(evaluateFailover({ roster, liveMap: backupOnline, online: false, primaryOfflineSinceMs: 0, now: 60_000 }), null);
  // Suppressed when no backup is online.
  assert.equal(evaluateFailover({ roster, liveMap: { [atlasKey]: { state: 'stopped' }, [reviewerKey]: { state: 'offline' } }, online: true }), null);
  // Fires immediately when primary explicitly stopped and backup is online.
  const stopped = evaluateFailover({ roster, liveMap: { [atlasKey]: { state: 'stopped' }, [reviewerKey]: { state: 'online' } }, online: true });
  assert.equal(stopped?.reason, 'stopped');
  assert.equal(stopped?.backup.handle, 'reviewer');
  // Fires on 12s unacknowledged message even before 30s offline threshold.
  const unack = evaluateFailover({ roster, liveMap: backupOnline, online: true, lastPendingUserMessage: { text: 'hi', sentAtMs: 1000 }, primaryOfflineSinceMs: 10_000, now: 15_000 });
  assert.equal(unack?.reason, 'unacknowledged');
  // Fires after 30s offline.
  const offline = evaluateFailover({ roster, liveMap: backupOnline, online: true, primaryOfflineSinceMs: 1000, now: 35_000 });
  assert.equal(offline?.reason, 'offline');
});

test('a stalled retained-event cursor fails rather than spinning forever', async () => {
  // Browser views read asynchronously; the helper awaits both sync and async readers.
  await assert.rejects(readAgentFeed({ readEvents: async () => ({ events: [], hasMore: true, cursor: 'same' }) }),
    /AGENT_FEED_CURSOR_STALLED/);
  await assert.rejects(readAgentFeed({ readEvents: () => ({ events: [], hasMore: true, cursor: 'same' }) }),
    /AGENT_FEED_CURSOR_STALLED/);
});

import { readFile, stat } from 'node:fs/promises';
import { runRequestWorker } from '../../docs/tutorial/consumers/request-worker.mjs';
import { openConsumerCheckpoint } from '../../docs/tutorial/shared/helpers/agent-consumer.mjs';
import { createTestConnection } from '../observation-fixture/connection.mjs';

const eventually = async (check, timeoutMs = 15000) => {
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
const noRoster = async () => ({ primary_agent_id: null, is_primary: false, agents: [] });

/** A page user and a separate agent signer, replicating over an authenticated test link. */
async function pair(t, applicationId = '74'.repeat(32)) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-worker-pair-')), cleanup = [];
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const devices = [];
  for (const name of ['user', 'agent']) {
    const device = await openNativeDevice({ path: join(directory, name + '.sqlite'), create: true });
    devices.push(device); cleanup.push(() => device.close());
  }
  const { genesisBytes, casNodes, key: epochKey } = await genesisForDevices(devices, agentBusGenesisOptions);
  const sessions = [];
  for (const device of devices) {
    const session = await p.createApplicationSession({ device, definition, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, epochKey]]) });
    sessions.push(session); cleanup.push(() => session.close());
  }
  const [user, agent] = sessions;
  let left, right;
  left = createTestConnection((lane, bytes) => right.accept(lane, bytes));
  right = createTestConnection((lane, bytes) => left.accept(lane, bytes));
  const links = await Promise.all([
    user.connectPeer({ connection: left.connection, peerIdentity: agent.identity.publicKey }),
    agent.connectPeer({ connection: right.connection, peerIdentity: user.identity.publicKey }),
  ]);
  cleanup.push(async () => { await Promise.all(links.map(link => link.close())); });
  const submit = async (session, name, input, operationId) => {
    const operation = await session.command(name, input, { operationId });
    assert.equal((await operation.materialized({ signal: AbortSignal.timeout(5000) })).outcome, 'accepted');
  };
  const feed = async (session = agent) => (await session.query('agentFeed', null)).value;
  return {
    user, agent, feed,
    /** The user asks the agent directly (`@handle` resolves to its signing key). */
    ask: (text, operationId) => submit(user, 'agentMessage', { channel: 'chat', to: [agent.identity.publicKey], text }, operationId),
    reply: (input, operationId) => submit(agent, 'agentMessage', input, operationId),
    async message(operationId, session = agent) {
      const value = await feed(session);
      const message = value.messages.find(item => item.author === user.identity.publicKey && item.operationId === operationId);
      return message && { message, delivery: messageDelivery(message, value),
        receipts: value.receipts[`${message.author}:${message.operationId}`] ?? [],
        replies: value.messages.filter(item => item.inReplyTo?.author === message.author && item.inReplyTo?.operationId === operationId) };
    },
    /** Wait until the agent's replica has materialized the user's message. */
    arrived: operationId => eventually(async () => Boolean((await feed()).messages.some(item => item.operationId === operationId))),
  };
}

test('runnable worker answers a second message after restart while the same native owner remains alive', { timeout: 25000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t);
  const answers = [];
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page', roster: noRoster,
    async handleRequest(request) { answers.push(request.operationId); return 'Answer: ' + request.text; } };
  for (const id of ['first-worker-request', 'second-worker-request']) {
    await f.ask(id, id);
    await f.arrived(id);
    const stopped = new AbortController();
    const run = runRequestWorker(f.agent, { ...options, signal: stopped.signal });
    const ended = assert.rejects(run, error => error === stopped.signal.reason);
    try {
      await eventually(async () => (await f.message(id))?.delivery === 'answered');
      await waitForCheckpoint(checkpointPath);
    } finally { stopped.abort(Error('Worker stopped')); await ended; }
    assert.equal(f.agent.signal.aborted, false, 'worker cleanup must not close its owner');
    const { receipts, replies } = await f.message(id);
    assert.equal(receipts.length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].author, f.agent.identity.publicKey);
    assert.deepEqual(replies[0].to, [f.user.identity.publicKey]);
    // The reply reaches the user's replica as an ordinary authored message.
    await eventually(async () => (await f.message(id, f.user))?.delivery === 'answered');
  }
  assert.deepEqual(answers, ['first-worker-request', 'second-worker-request']);
});

test('a worker ignores its own messages, unaddressed chat while not primary, and other channels', { timeout: 25000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t), self = f.agent.identity.publicKey;
  let calls = 0;
  await f.reply({ channel: 'chat', to: [f.user.identity.publicKey], text: 'Agent note' }, 'own-message');
  await f.user.command('agentMessage', { channel: 'chat', to: [], text: 'General' }, { operationId: 'general' });
  await f.user.command('agentMessage', { channel: 'agents', to: [self], text: 'Backchannel' }, { operationId: 'backchannel' });
  await f.arrived('general'); await eventually(async () => (await f.feed()).activity.some(item => item.operationId === 'backchannel'));
  const stopped = new AbortController();
  const run = runRequestWorker(f.agent, { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page',
    roster: async () => ({ primary_agent_id: 'other', is_primary: false, agents: [{ id: 'self', public_key: self, handle: 'helper' }] }),
    signal: stopped.signal, async handleRequest() { calls++; return 'Unexpected'; } });
  const ended = assert.rejects(run, error => error === stopped.signal.reason);
  try { await waitForCheckpoint(checkpointPath); }
  finally { stopped.abort(Error('Done')); await ended; }
  assert.equal(calls, 0);
  assert.equal((await f.message('general')).receipts.length, 0);
});

test('lost reply acknowledgement retries the exact saved result without re-running the handler', { timeout: 25000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t);
  await f.ask('Retain result', 'uncertain-answer');
  await f.arrived('uncertain-answer');
  let calls = 0, loseReply = true, views = 0;
  const session = {
    identity: f.agent.identity, signal: f.agent.signal, signals: f.agent.signals,
    get status() { return f.agent.status; }, onStatus: f.agent.onStatus.bind(f.agent),
    changes: f.agent.changes.bind(f.agent),
    query: f.agent.query.bind(f.agent),
    async readView() {
      const view = await f.agent.readView(); views++;
      return { readEvents: view.readEvents.bind(view), async release() { await view.release(); views--; } };
    },
    async command(name, input, options) {
      const attempt = await f.agent.command(name, input, options);
      if (name !== 'agentMessage' || !loseReply) return attempt;
      loseReply = false;
      return { async materialized(options) { await attempt.materialized(options); throw Error('Lost reply acknowledgement'); } };
    },
  };
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page', roster: noRoster,
    async handleRequest() { assert.equal(views, 0, 'no captured read view spans handler work'); calls++; return 'Retained answer'; } };
  await assert.rejects(runRequestWorker(session, options), /Lost reply acknowledgement/);
  assert.equal((await checkpoint(checkpointPath)).pending.rows[0].phase, 'result');
  assert.equal(f.agent.signal.aborted, false);
  const stopped = new AbortController();
  const run = runRequestWorker(session, { ...options, signal: stopped.signal });
  const ended = assert.rejects(run, error => error === stopped.signal.reason);
  try { await waitForCheckpoint(checkpointPath); }
  finally { stopped.abort(Error('Done')); await ended; }
  assert.equal(calls, 1);
  const { receipts, replies } = await f.message('uncertain-answer');
  assert.equal(receipts.length, 1);
  assert.equal(replies.length, 1, 'the exact retained reply operation is retried, not duplicated');
  assert.equal(replies[0].text, 'Retained answer');
});

test('uncertain handler effects block automatic restart without advancing the handled cursor', { timeout: 20000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t);
  await f.ask('An external task', 'uncertain-handler');
  await f.arrived('uncertain-handler');
  let effects = 0;
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page', roster: noRoster,
    async handleRequest() { effects++; throw Error('Provider outcome unknown'); } };
  await assert.rejects(runRequestWorker(f.agent, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  const retained = await checkpoint(checkpointPath);
  assert.equal(retained.cursor, undefined);
  assert.equal(retained.pending.rows[0].phase, 'uncertain');
  await assert.rejects(runRequestWorker(f.agent, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  assert.equal(effects, 1, 'supervisor restart cannot repeat an uncertain external effect');
  assert.equal((await f.message('uncertain-handler')).delivery, 'seen');
  assert.equal(f.agent.signal.aborted, false);
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

test('a fresh worker checkpoint does not repeat a message this agent already answered', { timeout: 20000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t), user = f.user.identity.publicKey;
  await f.ask('Already handled', 'historical-request');
  await f.arrived('historical-request');
  await f.reply({ channel: 'chat', to: [user], text: 'Previous durable result',
    inReplyTo: { author: user, operationId: 'historical-request' }, hopCount: 1 }, 'previous-answer');
  let calls = 0;
  const stopped = new AbortController();
  const run = runRequestWorker(f.agent, { consumerId: 'assistant', topics: ['chat'], roster: noRoster,
    checkpointPath, scope: 'same-page', signal: stopped.signal, async handleRequest() { calls++; return 'Duplicate'; } });
  const ended = assert.rejects(run, error => error === stopped.signal.reason);
  try { await waitForCheckpoint(checkpointPath); }
  finally { stopped.abort(Error('Done')); await ended; }
  assert.equal(calls, 0);
  const { receipts, replies } = await f.message('historical-request');
  assert.equal(replies.length, 1);
  assert.equal(receipts.length, 0);
});

test('worker presence uses the pinned public session default signal TTL and stream contract', { timeout: 20000 }, async t => {
  const f = await pair(t, '76'.repeat(32));
  const workerSession = f.agent, pageSession = f.user;
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
  }, { consumerId: 'assistant', topics: ['chat'], handle: 'assistant' });
  t.after(() => presence.close());
  const watcher = watchAgentPresence(pageSession, {
    peer: workerSession.identity.publicKey, consumerId: 'assistant', requestTopic: 'chat',
  });
  t.after(() => watcher.close());
  await eventually(() => sent.length > 0 || failures.length > 0);
  assert.deepEqual(failures, [], 'default presence must not silently fail SIGNAL_TTL_INVALID');
  await eventually(() => watcher.snapshot().status === 'available');
  assert.equal(sent[0].expiresAtMs - sent[0].issuedAtMs, 30_000);
  assert.equal(sent[0].stream.streamId, 'assistant');
  assert.equal(watcher.snapshot().consumer.author, workerSession.identity.publicKey);
  assert.equal(watcher.snapshot().consumer.handle, 'assistant');
  await presence.close();
  await presence.done;
  await eventually(() => watcher.snapshot().status === 'stopped');
  assert.equal(sent.at(-1).payload.state, 'stopped');
  assert.deepEqual(failures, []);
  assert.equal(workerSession.signal.aborted, false);
  assert.equal(pageSession.signal.aborted, false);
  assert.deepEqual((await f.feed()).messages, [], 'ephemeral presence writes no durable records and leaves the owner usable');
});

test('a stale cursor rescans the snapshot, skips answered messages and keeps the full original message reference', { timeout: 25000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t), user = f.user.identity.publicKey;
  const longId = 'namespaced-' + 'y'.repeat(380), handled = [];
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page', roster: noRoster,
    async handleRequest(request) { handled.push(request); return 'Answer: ' + request.text; } };
  const runUntilCheckpoint = async id => {
    await f.arrived(id);
    const stopped = new AbortController(), run = runRequestWorker(f.agent, { ...options, signal: stopped.signal });
    const ended = assert.rejects(run, error => error === stopped.signal.reason);
    try {
      await eventually(async () => (await f.message(id))?.delivery === 'answered');
      await waitForCheckpoint(checkpointPath);
    } finally { stopped.abort(Error('Worker stopped')); await ended; }
  };
  await f.ask('first', longId);
  await runUntilCheckpoint(longId);
  const savedCursor = (await checkpoint(checkpointPath)).cursor;
  // The worker's own reply already moved the revision; a new message moves it again.
  await f.ask('second', 'second-request');
  await runUntilCheckpoint('second-request');
  assert.deepEqual(handled.map(request => request.operationId), [longId, 'second-request'],
    'the answered message is not handled again after the snapshot is derived again');
  assert.equal(handled[0].operationId.length, longId.length, 'the full original message identity is retained');
  assert.equal(handled[0].author, user);
  for (const id of [longId, 'second-request']) {
    const { receipts, replies } = await f.message(id);
    assert.equal(receipts.length, 1); assert.equal(replies.length, 1);
  }
  assert.notEqual((await checkpoint(checkpointPath)).cursor, savedCursor, 'the handled cursor follows the new snapshot');
});

test('an in-flight uncertain handler row survives a later revision and sends no new notice or effect', { timeout: 20000 }, async t => {
  const f = await pair(t), checkpointPath = await workerFiles(t);
  await f.ask('external', 'uncertain-rescan');
  await f.arrived('uncertain-rescan');
  let effects = 0;
  const options = { consumerId: 'assistant', topics: ['chat'], checkpointPath, scope: 'same-page', roster: noRoster,
    async handleRequest() { effects++; throw Error('Provider outcome unknown'); } };
  await assert.rejects(runRequestWorker(f.agent, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  const retained = (await checkpoint(checkpointPath)).pending.rows[0];
  assert.equal(retained.phase, 'uncertain');
  // A later revision changes the snapshot; the uncertain row must still stop the worker.
  await f.ask('later', 'later-request');
  await f.arrived('later-request');
  await assert.rejects(runRequestWorker(f.agent, options), /AGENT_CONSUMER_REVIEW_REQUIRED/);
  assert.equal(effects, 1, 'uncertainty never repeats the external effect');
  const after = (await checkpoint(checkpointPath)).pending.rows[0];
  assert.deepEqual(after.request, retained.request, 'the full original message reference is unchanged');
  assert.equal(after.phase, 'uncertain');
  assert.equal((await f.message('later-request')).receipts.length, 0,
    'no later message is acknowledged while an uncertain row is retained');
});

test('host base64url Ed25519 roster keys normalize to canonical 64-char hex for primary routing and @handle addressing', () => {
  const atlasHex = '11'.repeat(32);
  const reviewerHex = '22'.repeat(32);
  const userHex = '33'.repeat(32);
  const atlasB64Url = Buffer.from(atlasHex, 'hex').toString('base64url');
  const reviewerB64Url = Buffer.from(reviewerHex, 'hex').toString('base64url');
  assert.equal(atlasB64Url.length, 43);
  assert.equal(normalizePublicKeyHex(atlasB64Url), atlasHex);
  assert.equal(normalizePublicKeyHex(atlasHex.toUpperCase()), atlasHex);
  assert.equal(normalizePublicKeyHex('not-a-valid-key'), null);

  const hostRoster = {
    primary_agent_id: 'ag_atlas',
    agents: [
      { id: 'ag_atlas', handle: 'atlas', public_key: atlasB64Url, is_primary: true },
      { id: 'ag_reviewer', handle: 'reviewer', public_key: reviewerB64Url, is_primary: false },
    ],
  };

  // General unaddressed chat message matches primary agent even though roster uses base64url and session uses hex.
  const general = { author: userHex, channel: 'chat', to: [], text: 'Good morning' };
  assert.equal(shouldAgentRespond(general, { selfPublicKey: atlasHex, roster: hostRoster }), true);
  assert.equal(shouldAgentRespond(general, { selfPublicKey: reviewerHex, roster: hostRoster }), false);

  // @handle addressing emits canonical 64-char hex recipients accepted by agentMessage schema.
  const addressed = parseAddressing('@reviewer please check this', hostRoster);
  assert.deepEqual(addressed.to, [reviewerHex]);
  assert.equal(shouldAgentRespond({ author: userHex, channel: 'chat', to: addressed.to, text: '@reviewer please check this' }, { selfPublicKey: reviewerHex, roster: hostRoster }), true);
  assert.equal(shouldAgentRespond({ author: userHex, channel: 'chat', to: addressed.to, text: '@reviewer please check this' }, { selfPublicKey: atlasHex, roster: hostRoster }), false);
});
