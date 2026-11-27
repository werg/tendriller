import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApplicationSession,
  createLogGenesis,
  openApplicationDevice,
} from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import {
  approveSqlProposal,
  listPendingProposals,
  proposeSqlBranch,
} from '../../docs/tutorial/shared/helpers/proposals.mjs';
import {
  describeOpSettlement,
  listUnresolvedConflicts,
  resolveConflictEntry,
} from '../../docs/tutorial/shared/helpers/finality-ux.mjs';
import {
  approveContactRecovery,
  finishDeviceRecovery,
  inspectRecoveryState,
  setupTrustedContacts,
  startDeviceRecovery,
} from '../../docs/tutorial/shared/helpers/social-recovery.mjs';
import {
  grantAgentAllowance,
  listAgentAllowances,
  reclaimAgentAllowance,
  spendAgentAllowance,
} from '../../docs/tutorial/shared/helpers/allowances.mjs';

test('Human + Agent Data PRs (proposals.mjs), conflict inbox (finality-ux.mjs), and offline allowances (allowances.mjs)', async () => {
  const adminDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const agentDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const created = await createLogGenesis({
    creator: {
      publicKey: adminDev.identity.publicKey,
      reader: true,
      writer: true,
      administrator: true,
      publisher: true,
      finalizer: true,
    },
    privateLog: false,
    topics: {
      $permissions: {
        module: 'chronolog/permissions',
        export: 'openMembers',
        initialState: { admins: [adminDev.identity.publicKey], members: [], openRead: true, openWrite: true, admission: null },
      },
      db: { module: 'chronolog/sql' },
      proposals: { module: 'chronolog/workflow', export: 'stateMachine' },
      ledger: { module: 'chronolog/ledger', export: 'doubleEntryLedger' },
    },
  });

  const sAdmin = await createApplicationSession({ device: adminDev, genesis: created.genesisBytes, casNodes: created.casNodes });
  const sAgent = await createApplicationSession({ device: agentDev, genesis: created.genesisBytes, casNodes: created.casNodes });
  try {
    // Set up SQL table with _last_op_id stamping + audit log
    const mig = await sAdmin.command('db:migrate', {
      statements: ['CREATE TABLE inventory (id TEXT PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL, _last_op_id TEXT)'],
      stampTables: ['inventory'],
      auditTables: ['inventory'],
    });
    assert.equal((await mig.materialized()).outcome, 'accepted');
    await (await sAdmin.command('db:exec', {
      sql: 'INSERT INTO inventory (id, name, qty) VALUES (?, ?, ?)',
      params: ['sku-1', 'Beans', 10],
    })).materialized();

    // Agent forks DB in O(1), proposes edits, human lists & approves
    await sAgent.mergeFacts(await sAdmin.exportFacts());
    const pr = await proposeSqlBranch(sAgent, {
      sqlTopic: 'db',
      workflowTopic: 'proposals',
      title: 'Restock espresso beans and add oat milk',
      mutate(branch) {
        branch.exec('UPDATE inventory SET qty = ? WHERE id = ?', [30, 'sku-1']);
        branch.exec('INSERT INTO inventory (id, name, qty) VALUES (?, ?, ?)', ['sku-2', 'Oat Milk', 12]);
      },
    });
    assert.equal(pr.empty, false);
    assert.equal(pr.outcome, 'accepted');

    await sAdmin.mergeFacts(await sAgent.exportFacts());
    const pending = await listPendingProposals(sAdmin, 'proposals');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.summary.totalChanges, 2);

    const approved = await approveSqlProposal(sAdmin, { id: pr.id, workflowTopic: 'proposals' });
    assert.equal(approved.approved, true);
    assert.equal(approved.applied, true);

    const settlement = describeOpSettlement(sAdmin, approved.applyOpId);
    assert.equal(settlement.status, 'local');
    assert.equal(settlement.label, 'Saved locally');

    // Race test: propose another change, human edits same row first -> conflict recorded cleanly in _chronolog_conflicts!
    await sAgent.mergeFacts(await sAdmin.exportFacts());
    const pr2 = await proposeSqlBranch(sAgent, {
      sqlTopic: 'db',
      workflowTopic: 'proposals',
      title: 'Adjust beans to 28',
      mutate(branch) {
        branch.exec('UPDATE inventory SET qty = ? WHERE id = ?', [28, 'sku-1']);
      },
    });
    await (await sAdmin.command('db:exec', {
      sql: 'UPDATE inventory SET qty = ? WHERE id = ?',
      params: [50, 'sku-1'],
    })).materialized();
    await sAdmin.mergeFacts(await sAgent.exportFacts());
    await approveSqlProposal(sAdmin, { id: pr2.id, workflowTopic: 'proposals', recordConflictOnRace: true });

    const conflicts = await listUnresolvedConflicts(sAdmin, 'db');
    assert.equal(conflicts.length, 1);
    const resolved = await resolveConflictEntry(sAdmin, { sqlTopic: 'db', opId: conflicts[0].opId, resolution: 'kept-50' });
    assert.equal(resolved.ok, true);
    assert.equal((await listUnresolvedConflicts(sAdmin, 'db')).length, 0);

    // Offline Agent Allowances (Escrow CRDT)
    await (await sAdmin.command('ledger:createAccount', { id: 'equity', allowNegative: true })).materialized();
    await (await sAdmin.command('ledger:createAccount', { id: 'budget' })).materialized();
    await (await sAdmin.command('ledger:createAccount', { id: 'tools' })).materialized();
    await (await sAdmin.command('ledger:post', {
      postings: [{ account: 'equity', delta: -5000 }, { account: 'budget', delta: 5000 }],
    })).materialized();

    const grant = await grantAgentAllowance(sAdmin, {
      fromAccount: 'budget',
      grantee: agentDev.identity.publicKey,
      amount: 2000,
    });
    assert.equal(grant.ok, true);

    await sAgent.mergeFacts(await sAdmin.exportFacts());
    const spendOk = await spendAgentAllowance(sAgent, {
      allowanceId: grant.allowanceId,
      toAccount: 'tools',
      amount: 800,
      memo: 'API credits',
    });
    assert.equal(spendOk.ok, true);
    const spendOver = await spendAgentAllowance(sAgent, {
      allowanceId: grant.allowanceId,
      toAccount: 'tools',
      amount: 1500,
    });
    assert.equal(spendOver.ok, false);
    assert.equal(spendOver.reason, 'ledger:allowance_exceeded');

    await sAdmin.mergeFacts(await sAgent.exportFacts());
    const allowances = await listAgentAllowances(sAdmin, { grantee: agentDev.identity.publicKey });
    assert.equal(allowances[0].remaining, 1200);
    const reclaimed = await reclaimAgentAllowance(sAdmin, { allowanceId: grant.allowanceId });
    assert.equal(reclaimed.ok, true);
  } finally {
    await sAdmin.close();
    await sAgent.close();
  }
});

test('Trusted Backup Contacts social recovery helper (social-recovery.mjs)', async () => {
  const owner = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const c1 = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const c2 = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const replacement = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });

  const created = await createLogGenesis({
    creator: {
      publicKey: owner.identity.publicKey,
      wrapKey: owner.wrapKey.publicKey,
      reader: true,
      writer: true,
      administrator: true,
      publisher: true,
      finalizer: true,
    },
    privateLog: true,
    topics: { notes: { module: 'chronolog/crdt', export: 'lwwMap' } },
  });

  const sOwner = await createApplicationSession({
    device: owner,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
    epochKeys: new Map([[0, created.epoch0Key]]),
  });
  const sC1 = await createApplicationSession({ device: c1, genesis: created.genesisBytes, casNodes: created.casNodes });
  const sC2 = await createApplicationSession({ device: c2, genesis: created.genesisBytes, casNodes: created.casNodes });
  const sNew = await createApplicationSession({ device: replacement, genesis: created.genesisBytes, casNodes: created.casNodes });
  try {
    await (await sOwner.command('notes:set', { key: 'pin', value: 'hello-world' })).materialized();
    const setup = await setupTrustedContacts(sOwner, {
      threshold: 2,
      contacts: [
        { publicKey: c1.identity.publicKey, wrapKey: c1.wrapKey.publicKey, label: 'Friend A' },
        { publicKey: c2.identity.publicKey, wrapKey: c2.wrapKey.publicKey, label: 'Friend B' },
      ],
    });
    assert.equal(setup.ok, true);

    const f0 = await sOwner.exportFacts();
    await sC1.mergeFacts(f0);
    await sC2.mergeFacts(f0);
    await sNew.mergeFacts(f0);

    const started = await startDeviceRecovery(sNew, { label: 'Replacement Phone' });
    assert.equal(started.ok, true);
    assert.match(started.verificationCode, /^\d{6}$/);

    await sC1.mergeFacts(await sNew.exportFacts());
    assert.equal((await approveContactRecovery(sC1, started.requestId)).ok, true);
    await sC2.mergeFacts(await sC1.exportFacts());
    assert.equal((await approveContactRecovery(sC2, started.requestId)).ok, true);

    await sNew.mergeFacts(await sC2.exportFacts());
    const recState = await inspectRecoveryState(sNew);
    assert.equal(recState.requests[0].status, 'completed');
    const restored = await finishDeviceRecovery(sNew);
    assert.equal(restored.restoredEpochs, 1);

    const recovered = (await sNew.query('notes', { key: 'pin' })).value;
    assert.equal(recovered, 'hello-world');
  } finally {
    await sOwner.close();
    await sC1.close();
    await sC2.close();
    await sNew.close();
  }
});
