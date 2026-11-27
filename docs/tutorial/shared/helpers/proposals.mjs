// AI Agent "Data PRs" helper: zero-copy SQLite branching (session.forkSql) +
// row-level diffs + automatic based_on_row preconditions + chronolog/workflow approval queue.

/**
 * Run speculative SQL mutations inside an isolated zero-copy branch, compute the exact row diff
 * and automatic row-version preconditions, and submit a reviewable proposal into a workflow topic.
 *
 * @param {object} session - Open Chronolog session with both a chronolog/sql topic and a chronolog/workflow topic
 * @param {object} options
 * @param {string} options.sqlTopic - Name of the chronolog/sql topic (e.g. 'db')
 * @param {string} [options.workflowTopic='proposals'] - Name of the chronolog/workflow topic
 * @param {string} options.title - Plain-English summary shown to the human (e.g. "Reconcile Q4 inventory")
 * @param {(branch: any) => void | Promise<void>} options.mutate - Callback executing speculative SQL on the branch
 * @param {boolean} [options.withRowGuards=true] - Attach automatic based_on_row / row_matches preconditions
 */
export async function proposeSqlBranch(session, {
  sqlTopic,
  workflowTopic = 'proposals',
  title,
  mutate,
  withRowGuards = true,
}) {
  const branch = await session.forkSql(sqlTopic);
  try {
    await mutate(branch);
    const proposal = await branch.toProposal({ withRowGuards });
    if (proposal.statements.length === 0) {
      return { empty: true, proposal };
    }
    const id = crypto.randomUUID();
    const op = await session.command(`${workflowTopic}:create`, {
      id,
      title,
      payload: {
        kind: 'sql-branch-proposal',
        sqlTopic,
        statements: proposal.statements,
        preconditions: proposal.preconditions,
        summary: summarizeDiff(proposal.diff),
        diff: proposal.diff,
      },
    });
    const mat = await op.materialized();
    return { empty: false, id, proposal, outcome: mat.outcome, opId: op.id };
  } finally {
    await branch.close();
  }
}

/** Produce a compact human-friendly summary of a SqlBranchDiff for review cards. */
export function summarizeDiff(diff) {
  const tables = Array.isArray(diff?.tables) ? diff.tables : [];
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const tableSummaries = tables.map(t => {
    const ins = t.inserted?.length ?? 0;
    const upd = t.updated?.length ?? 0;
    const del = t.deleted?.length ?? 0;
    inserted += ins;
    updated += upd;
    deleted += del;
    return { table: t.table, inserted: ins, updated: upd, deleted: del };
  });
  return {
    totalChanges: inserted + updated + deleted,
    inserted,
    updated,
    deleted,
    changedPages: diff?.merkle?.totalChangedPages ?? 0,
    tables: tableSummaries,
  };
}

/** List pending AI/collaborator proposals from the workflow topic. */
export async function listPendingProposals(session, workflowTopic = 'proposals') {
  const res = await session.query(workflowTopic, { kind: 'list', state: 'proposed' });
  const items = Array.isArray(res?.value?.items) ? res.value.items : [];
  return items.filter(item => item?.payload?.kind === 'sql-branch-proposal');
}

/**
 * Human approves a pending SQL branch proposal: transitions the workflow item to 'approved'
 * and atomically applies its guarded SQL statements (failing safely into _chronolog_conflicts
 * if a human edited any of the same rows while reviewing).
 */
export async function approveSqlProposal(session, {
  id,
  workflowTopic = 'proposals',
  recordConflictOnRace = true,
  note = '',
}) {
  const itemRes = await session.query(workflowTopic, { kind: 'item', id });
  const item = itemRes?.value;
  if (!item || item.payload?.kind !== 'sql-branch-proposal') {
    throw Error(`PROPOSAL_NOT_FOUND:${id}`);
  }
  const { sqlTopic, statements, preconditions } = item.payload;
  const approveOp = await session.command(`${workflowTopic}:transition`, {
    id,
    transition: 'approve',
    ...(note ? { note } : {}),
  });
  const approveMat = await approveOp.materialized();
  if (approveMat.outcome !== 'accepted') {
    return { approved: false, applied: false, reason: approveMat.rejectionCode };
  }
  const applyOp = await session.command(`${sqlTopic}:exec`, {
    statements,
    preconditions,
    ...(recordConflictOnRace ? { onPreconditionFailed: 'record_conflict' } : {}),
  }, { afterOps: [approveOp.id] });
  const applyMat = await applyOp.materialized();
  return {
    approved: true,
    applied: applyMat.outcome === 'accepted',
    reason: applyMat.rejectionCode,
    approveOpId: approveOp.id,
    applyOpId: applyOp.id,
  };
}

/** Human dismisses/rejects a pending proposal. */
export async function dismissSqlProposal(session, { id, workflowTopic = 'proposals', note = '' }) {
  const op = await session.command(`${workflowTopic}:transition`, {
    id,
    transition: 'reject',
    ...(note ? { note } : {}),
  });
  const mat = await op.materialized();
  return { dismissed: mat.outcome === 'accepted', reason: mat.rejectionCode };
}
