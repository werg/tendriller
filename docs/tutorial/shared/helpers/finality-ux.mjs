// Calm Pending -> Confirmed -> Needs Attention settlement & conflict inbox helpers.

const SETTLEMENT_LABELS = Object.freeze({
  local: Object.freeze({ label: 'Saved locally', tone: 'neutral', settled: false }),
  synced: Object.freeze({ label: 'Pending confirmation', tone: 'pending', settled: false }),
  finalized: Object.freeze({ label: 'Confirmed', tone: 'confirmed', settled: true }),
  excluded: Object.freeze({ label: 'Needs attention', tone: 'warning', settled: false }),
  equivocated: Object.freeze({ label: 'Witness conflict detected', tone: 'danger', settled: false }),
});

/**
 * Translate a Chronolog operation's finality status into calm, jargon-free UI copy.
 * Works identically on both Node ApplicationSession and browser WorkerApplicationSession.
 */
export async function describeOpSettlement(session, opId) {
  const status = typeof session.finalityStatus === 'function' ? await session.finalityStatus(opId) : 'local';
  const meta = SETTLEMENT_LABELS[status] ?? SETTLEMENT_LABELS.local;
  const proofs = typeof session.equivocationProofs === 'function' ? await session.equivocationProofs() : [];
  return {
    status,
    ...meta,
    equivocationCount: Array.isArray(proofs) ? proofs.length : 0,
  };
}

/**
 * List unresolved assumption/precondition conflicts recorded in a chronolog/sql topic.
 */
export async function listUnresolvedConflicts(session, sqlTopic = 'db') {
  const res = await session.query(sqlTopic, { kind: 'conflicts', unresolvedOnly: true });
  return Array.isArray(res?.value?.conflicts) ? res.value.conflicts : [];
}

/**
 * Mark a conflict entry resolved after the user or agent accepts an alternative or dismisses it.
 */
export async function resolveConflictEntry(session, { sqlTopic = 'db', opId, resolution = 'resolved' }) {
  const op = await session.command(`${sqlTopic}:resolveConflict`, { opId, resolution });
  const mat = await op.materialized();
  return { ok: mat.outcome === 'accepted', reason: mat.rejectionCode };
}
