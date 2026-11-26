import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationSession, createChainGenesis, describeApplication, openApplicationDevice } from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createCollaborationDefinition } from '../domain.mjs';
import { captureCollaborationReader } from '../paging.mjs';
import { memoryStore } from './physical-fixture.mjs';

function checkOwnerFrame(frame) {
  const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  if (bytes > 512 * 1024) throw Error(`OWNER_FRAME_TOO_LARGE:${bytes}`);
}

async function harness() {
  const devA = await openApplicationDevice({ store: memoryStore(), create: true });
  const devB = await openApplicationDevice({ store: memoryStore(), create: true });
  const devC = await openApplicationDevice({ store: memoryStore(), create: true });
  const A = devA.identity.publicKey, B = devB.identity.publicKey, C = devC.identity.publicKey;
  const { definition, imports, topics } = createCollaborationDefinition({ administrators: [A] });
  const created = await createChainGenesis({
    creator: { publicKey: A, reader: true, writer: true, administrator: true, publisher: true, finalizer: false },
    members: [
      { publicKey: B, reader: true, writer: true, administrator: false, publisher: false, finalizer: false },
      { publicKey: C, reader: true, writer: true, administrator: false, publisher: false, finalizer: false },
    ],
    privateChain: true,
    imports,
    topics,
  });
  const epochKeys = new Map([[0, created.epoch0Key]]);
  const sessions = {
    [A]: await createApplicationSession({ device: devA, definition, genesis: created.genesisBytes, casNodes: created.casNodes, epochKeys }),
    [B]: await createApplicationSession({ device: devB, definition, genesis: created.genesisBytes, casNodes: created.casNodes, epochKeys }),
    [C]: await createApplicationSession({ device: devC, definition, genesis: created.genesisBytes, casNodes: created.casNodes, epochKeys }),
  };

  let clock = BigInt(Date.now());
  const claimRefs = new Map();
  let defaultClaimProposalId = null;

  async function syncAll() {
    const facts = await Promise.all(Object.values(sessions).map(s => s.exportFacts()));
    for (const s of Object.values(sessions)) {
      for (const f of facts) await s.mergeFacts(f);
    }
  }

  async function execute(name, input, as = A, options = {}) {
    const s = sessions[as];
    const ts = options.authorTimestampMs ?? (clock += 10n);
    const op = await s.command(name, input, {
      ...(options.operationId ? { operationId: options.operationId } : {}),
      authorTimestampMs: ts,
    });
    const mat = await op.materialized();
    await syncAll();
    const inspected = op.inspect();
    if (mat.outcome !== 'accepted') {
      throw Object.assign(new Error(mat.rejectionCode || 'rejected'), { code: mat.rejectionCode });
    }
    const ref = { applicationId: s.applicationId, author: as, operationId: inspected.operationId, proposalId: inspected.proposalId };
    if (name === 'collab.claim') {
      claimRefs.set([input.taskId, input.slotId, as].join(':'), ref.proposalId);
      if (as === B) defaultClaimProposalId = ref.proposalId;
    }
    return ref;
  }

  return {
    A, B, C,
    appId: created.chainId,
    definition,
    sessions,
    sessionA: sessions[A],
    execute,
    syncAll,
    claimProposalId: (as, task = 'task', slot = 'main') => claimRefs.get([task, slot, as].join(':')),
    defaultClaimProposalId: () => defaultClaimProposalId,
    async query(name, input) {
      return (await sessions[A].query(name, input)).value;
    },
    async snapshot(taskId = 'task') {
      return (await sessions[A].query('collab.task', { taskId })).value;
    },
    async close() {
      await Promise.allSettled(Object.values(sessions).map(s => s.close()));
    },
  };
}

function makeRequest(h, slots, responsePolicy = 'one') {
  return h.execute('collab.request', {
    interactionId: 'task',
    kind: 'review',
    title: 'Review a shared proposal',
    input: '{"proposal":1}',
    target: '{"kind":"workerGroup","groupId":"reviewers","mode":"claimOne"}',
    source: '{}',
    context: '{}',
    slots: slots ?? [{ slotId: 'main', eligibleSigners: [h.B, h.C] }],
    responsePolicy,
  }, h.A);
}

const makeClaim = (claimId = 'claim-b', expectedEpoch = 0) => ({
  taskId: 'task', slotId: 'main', claimId, runId: 'run-b', endpointIncarnation: 'view-b', expectedEpoch, taskVersion: 1,
});
const makeResult = (h, resultId = 'result-b', claimEpoch = 1, claimProposalId = h.defaultClaimProposalId()) => ({
  taskId: 'task', slotId: 'main', resultId, claimEpoch, taskVersion: 1, claimProposalId,
  runId: 'run-b', endpointIncarnation: 'view-b', outcome: 'succeeded', content: '{"answer":42}',
});

test('message tuple identities keep colon-containing threads independent and retain exact original records', async t => {
  const h = await harness(); t.after(() => h.close());
  const left = { threadId: 'a:b', messageId: 'c', text: 'First thread message', source: '{}' };
  const right = { threadId: 'a', messageId: 'b:c', text: 'Second thread message', source: '{}' };
  const first = await h.execute('collab.message', left, h.A);
  const second = await h.execute('collab.message', right, h.A);
  // Idempotent duplicate of same message content succeeds without creating a duplicate row.
  await h.execute('collab.message', left, h.A);
  await h.execute('collab.message', right, h.A);
  for (const [input, operation] of [[left, first], [right, second]]) {
    const page = await h.query('collab.thread', { threadId: input.threadId });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].messageId, input.messageId);
    assert.equal(page.messages[0].text, input.text);
    assert.deepEqual(page.messages[0].operation, operation);
    await assert.rejects(h.execute('collab.message', { ...input, text: 'Changed content' }, h.A), /collab_identity_conflict/);
  }
});

test('result tuple identities keep colon-containing tasks independent and preserve exact retry lineage', async t => {
  const h = await harness(); t.after(() => h.close());
  const pairs = [
    { taskId: 'a:b', resultId: 'c', content: '{"answer":"first"}' },
    { taskId: 'a', resultId: 'b:c', content: '{"answer":"second"}' },
  ];
  const originals = [];
  for (const [index, value] of pairs.entries()) {
    await h.execute('collab.request', {
      interactionId: value.taskId, kind: 'review', title: 'Req', input: 'null',
      target: JSON.stringify({ kind: 'signer', deviceId: h.B }), source: '{}', context: '{}',
      slots: [{ slotId: 'main', eligibleSigners: [h.B] }], responsePolicy: 'one',
    }, h.A);
    await h.execute('collab.claim', { ...makeClaim(`claim-${index}`), taskId: value.taskId }, h.B);
    originals.push(await h.execute('collab.result', { ...makeResult(h), ...value, claimProposalId: h.claimProposalId(h.B, value.taskId) }, h.B));
  }
  for (const [index, value] of pairs.entries()) {
    await h.execute('collab.result', { ...makeResult(h), ...value, claimProposalId: h.claimProposalId(h.B, value.taskId) }, h.B);
    const current = await h.snapshot(value.taskId);
    assert.equal(current.results.length, 1);
    assert.equal(current.results[0].resultId, value.resultId);
    assert.equal(current.results[0].disposition, 'accepted');
    assert.deepEqual(current.results[0].content, JSON.parse(value.content));
    assert.deepEqual(current.results[0].operation, originals[index]);
    assert.equal(current.task.version, 3);
    await assert.rejects(
      h.execute('collab.result', { ...makeResult(h), ...value, content: '{"answer":"changed"}', claimProposalId: h.claimProposalId(h.B, value.taskId) }, h.B),
      /collab_identity_conflict/,
    );
  }
});

test('guarded claims, handoff fencing, cancellation, fan-in, and verified provenance work end-to-end over chronolog:sqlite', async t => {
  const h = await harness(); t.after(() => h.close());
  const requested = await makeRequest(h);
  const claimed = await h.execute('collab.claim', makeClaim(), h.B);
  await assert.rejects(h.execute('collab.claim', { ...makeClaim('claim-c'), runId: 'run-c' }, h.C), /collab_claim_conflict/);

  let snap = await h.snapshot();
  assert.deepEqual(snap.task.operation, requested);
  assert.deepEqual(snap.claims[0].operation, claimed);
  assert.equal(snap.claims[0].claimant, h.B);

  // Forged claim proposal cannot submit result.
  await assert.rejects(h.execute('collab.result', makeResult(h, 'forged', 1, 'f'.repeat(64)), h.B), /collab_result_author/);

  // Handoff fences old claimant and retains late evidence as superseded.
  await h.execute('collab.handoff', { taskId: 'task', slotId: 'main', actionId: 'handoff-1', expectedEpoch: 1, assignee: h.C, reason: 'Reassigned' }, h.A);
  const claimC = await h.execute('collab.claim', { ...makeClaim('claim-c', 2), runId: 'run-c', endpointIncarnation: 'view-c' }, h.C);
  await h.execute('collab.result', makeResult(h, 'late-b', 1, claimed.proposalId), h.B);
  snap = await h.snapshot();
  assert.equal(snap.results[0].disposition, 'superseded');
  assert.equal(snap.claims[0].claimEpoch, 3);
  assert.equal(snap.claims[0].claimant, h.C);

  // Active claimant produces accepted result; creator finalizes.
  await h.execute('collab.result', { ...makeResult(h, 'result-c', 3, claimC.proposalId), runId: 'run-c', endpointIncarnation: 'view-c' }, h.C);
  snap = await h.snapshot();
  assert.equal(snap.acceptedResults.length, 1);
  assert.equal(snap.acceptedResults[0].resultId, 'result-c');
  await h.execute('collab.finalize', {
    taskId: 'task', actionId: 'done', expectedVersion: snap.task.version,
    resultIds: ['result-c'], content: '{"summary":"ok"}', allowPartial: false,
  }, h.A);
  assert.equal((await h.snapshot()).task.status, 'completed');
});

test('cancellation request, late result, and acknowledgement are distinct durable facts', async t => {
  const h = await harness(); t.after(() => h.close());
  await makeRequest(h);
  await h.execute('collab.claim', makeClaim(), h.B);
  await h.execute('collab.cancel', { taskId: 'task', actionId: 'cancel', expectedVersion: 2, reason: 'User stopped task' }, h.A);
  assert.equal((await h.snapshot()).task.status, 'cancelRequested');
  await h.execute('collab.result', makeResult(h), h.B);
  assert.equal((await h.snapshot()).results[0].disposition, 'cancelled');
  await h.execute('collab.acknowledgeCancel', {
    taskId: 'task', slotId: 'main', actionId: 'ack', claimEpoch: 1,
    claimProposalId: h.defaultClaimProposalId(), runId: 'run-b', endpointIncarnation: 'view-b',
  }, h.B);
  assert.equal((await h.snapshot()).task.status, 'cancelled');
});

test('task discovery, thread paging, owner MessagePort transport, and captured snapshot isolation work end-to-end', async t => {
  const h = await harness(); t.after(() => h.close());
  for (const [taskId, eligible] of [['one', h.B], ['two', h.B], ['other', h.C]]) {
    await h.execute('collab.request', {
      interactionId: taskId, kind: 'review', title: taskId, input: 'null',
      target: JSON.stringify({ kind: 'signer', deviceId: eligible }), source: '{}', context: '{}',
      slots: [{ slotId: 'main', eligibleSigners: [eligible] }], responsePolicy: 'one',
    }, h.A);
  }
  await h.execute('collab.cancel', { taskId: 'one', actionId: 'closed', expectedVersion: 1, reason: 'Done' }, h.A);
  for (let i = 0; i < 5; i++) {
    await h.execute('collab.message', { threadId: 'selected', messageId: `message-${i}`, text: `Message ${i}`, source: '{}' }, h.A);
  }

  const open = await h.query('collab.tasks', { eligibleSigner: h.B, state: 'open' });
  assert.deepEqual(open.tasks.map(v => v.taskId), ['two']);
  assert.equal(open.page.total, 1);

  // Verify real MessagePort owner + captured reader isolation across subsequent writes.
  const description = describeApplication(h.definition);
  const ports = new MessageChannel();
  const owner = createApplicationOwner(h.sessionA);
  owner.attach(ports.port1);
  const client = await connectApplicationOwner(ports.port2, {
    applicationId: h.appId, definitionId: description.id, definitionVersion: description.version, timeoutMs: 2000,
  });
  const reader = await captureCollaborationReader(client);
  t.after(async () => { await reader.close(); await client.detach(); ports.port1.close(); ports.port2.close(); });

  const first = await reader.thread({ threadId: 'selected', limit: 2 });
  assert.equal(first.value.page.total, 5);
  assert.deepEqual(first.value.messages.map(v => v.messageId), ['message-0', 'message-1']);
  checkOwnerFrame({ id: 1, value: first, snapshot: {} });

  // Author a new message while reader is pinned to the earlier snapshot!
  await h.execute('collab.message', { threadId: 'selected', messageId: 'message-late', text: 'After capture', source: '{}' }, h.A);

  // Pinned reader continues seamlessly on its frozen snapshot, while fresh queries reject the stale cursor!
  const second = await reader.thread({ threadId: 'selected', limit: 2, cursor: first.value.page.nextCursor });
  assert.deepEqual(second.value.messages.map(v => v.messageId), ['message-2', 'message-3']);
  await assert.rejects(h.query('collab.thread', { threadId: 'selected', limit: 2, cursor: first.value.page.nextCursor }), { code: 'CURSOR_RESET_REQUIRED' });
});

test('late earlier claims revise current outcomes identically across replicas in authored-time order', async t => {
  const h = await harness(); t.after(() => h.close());
  const baseTs = BigInt(Date.now());
  await h.execute('collab.request', {
    interactionId: 'task', kind: 'review', title: 'Race', input: 'null',
    target: '{"kind":"workerGroup","groupId":"reviewers","mode":"claimOne"}', source: '{}', context: '{}',
    slots: [{ slotId: 'main', eligibleSigners: [h.B, h.C] }], responsePolicy: 'one',
  }, h.A, { authorTimestampMs: baseTs + 10n });

  // B claims at t+30 and submits a result at t+40 before C's earlier claim arrives!
  const claimB = await h.execute('collab.claim', makeClaim('claim-b'), h.B, { authorTimestampMs: baseTs + 30n });
  await h.execute('collab.result', makeResult(h, 'result-b', 1, claimB.proposalId), h.B, { authorTimestampMs: baseTs + 40n });
  assert.equal((await h.snapshot()).claims[0].claimant, h.B);
  assert.equal((await h.snapshot()).results[0].disposition, 'accepted');

  // Now C's LATE-ARRIVING earlier claim at t+20 arrives!
  const opC = await h.sessions[h.C].command('collab.claim', { ...makeClaim('earlier-c'), runId: 'run-c' }, { authorTimestampMs: baseTs + 20n });
  await opC.materialized();
  await h.syncAll();

  // Every replica deterministically converges to C as the winner and B's claim/result rejected!
  const snapA = (await h.sessions[h.A].query('collab.task', { taskId: 'task' })).value;
  const snapB = (await h.sessions[h.B].query('collab.task', { taskId: 'task' })).value;
  const snapC = (await h.sessions[h.C].query('collab.task', { taskId: 'task' })).value;
  assert.equal(snapA.claims[0].claimant, h.C);
  assert.equal(snapA.results.length, 0);
  assert.deepEqual(snapA, snapB);
  assert.deepEqual(snapA, snapC);
  assert.equal(h.sessions[h.A].revision().stateRoot, h.sessions[h.B].revision().stateRoot);
  assert.equal(h.sessions[h.A].revision().stateRoot, h.sessions[h.C].revision().stateRoot);
});
