import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
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
  const signer = await p.createPeerIdentity(), epochKey = crypto.getRandomValues(new Uint8Array(32));
  const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
  const descriptor = await p.signApplicationDescriptor({ applicationId: '73'.repeat(32),
    historyId: 'agent-requests-test', profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    controlPublicKey: signer.publicKey, schemaAdministrator: device.identity.publicKey,
    definitionDigest: await p.applicationDefinitionDigest(definition),
    executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), schemaDigest: null }, signer);
  const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId,
    profile: descriptor.payload.profile, policy: descriptor.payload.policy, revision: 0,
    previous: null, epoch: 0, keyDigest: await p.bytesDigest(epochKey), recoveryFloor: null,
    grants: [p.participantGrant(device.identity.publicKey, { administrator: true, publisher: true })] }, signer);
  const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(),
    descriptor, controls: [control], signer });
  await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId,
    profile: descriptor.payload.profile, policy: descriptor.payload.policy, transitionId: 'initial',
    expectedGeneration: null, coordinator: device.identity.publicKey, requester: device.identity.publicKey,
    controlRevision: 0, reason: 'create', base: null }, device.identity));
  const open = async () => openNativeApplication({ device, definition,
    authority: await registry.read(), epochKeys: new Map([[0, epochKey]]) });
  session = await open();
  return { get session() { return session; },
    async reopen() { await session.close(); session = undefined;
      device = await openNativeDevice({ path }); session = await open(); },
    async command(name, input, operationId) {
      const operation = await session.command(name, input, { operationId });
      const outcome = await operation.applied({ signal: AbortSignal.timeout(5000) });
      assert.equal(outcome.outcome, 'accepted'); return operation;
    } };
}

test('public native session retains full request identity, author time, receipt, answer and heartbeat after reopen', { timeout: 20_000 }, async t => {
  const f = await fixture(t), operationId = 'namespaced-request-' + 'x'.repeat(350);
  const author = f.session.deviceId, startedAtMs = Date.now();
  await assert.rejects(f.session.command('agentRequest', {
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
    're-reading a selected prefix drops receipts and answers outside it');
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
