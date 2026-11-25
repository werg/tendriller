import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { authorityForDevices } from '../../collaboration/test/physical-fixture.mjs';
import { openNativeDevice } from '@chronolog/peer-session/native';
import {
  agentRequestCommands,
  agentRequestQueries,
  evaluateFailover,
  messageDelivery,
  parseAddressing,
  readAgentFeed,
  shouldAgentRespond,
} from '../../docs/tutorial/shared/helpers/agent-requests.mjs';

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
  const { authority, key: epochKey } = await authorityForDevices([device], { applicationId: '73'.repeat(32) });
  const open = async () => p.createApplicationSession({ device, definition, authority, epochKeys: new Map([[0, epochKey]]) });
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
  assert.equal(messageDelivery(feed.messages[0], feed), 'seen');

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
  assert.equal(messageDelivery(feed.messages[0], feed), 'answered');
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

test('a stalled retained-event cursor fails rather than spinning forever', () => {
  assert.throws(() => readAgentFeed({ readEvents: () => ({ events: [], hasMore: true, cursor: 'same' }) }),
    /AGENT_FEED_CURSOR_STALLED/);
});
