// Offline Agent Allowances helper over chronolog/ledger (Escrow CRDT quotas).
// Lets a human grant an agent (or offline kiosk) a hard local budget that can be spent
// autonomously offline with mathematical no-overspend safety and zero consensus per spend.

/**
 * Grant a spending/stock allowance from a treasury account to an agent or device key.
 */
export async function grantAgentAllowance(session, {
  ledgerTopic = 'ledger',
  allowanceId = crypto.randomUUID(),
  fromAccount,
  grantee,
  amount,
  expiresAtMs = null,
}) {
  const op = await session.command(`${ledgerTopic}:grantAllowance`, {
    allowanceId,
    fromAccount,
    grantee,
    amount,
    expiresAtMs,
  });
  const mat = await op.materialized();
  return { ok: mat.outcome === 'accepted', allowanceId, reason: mat.rejectionCode, opId: op.id };
}

/**
 * Spend offline from a granted allowance. Never exceeds the reserved local quota.
 */
export async function spendAgentAllowance(session, {
  ledgerTopic = 'ledger',
  allowanceId,
  toAccount,
  amount,
  memo = '',
}) {
  const op = await session.command(`${ledgerTopic}:spendFromAllowance`, {
    allowanceId,
    toAccount,
    amount,
    memo,
  });
  const mat = await op.materialized();
  return { ok: mat.outcome === 'accepted', reason: mat.rejectionCode, opId: op.id };
}

/** List active allowances (optionally filtered to one grantee publicKey). */
export async function listAgentAllowances(session, { ledgerTopic = 'ledger', grantee } = {}) {
  const res = await session.query(ledgerTopic, { kind: 'allowances', ...(grantee ? { grantee } : {}) });
  return Array.isArray(res?.value?.allowances) ? res.value.allowances : [];
}

/** Reclaim any unspent remainder of an allowance back to the source account. */
export async function reclaimAgentAllowance(session, { ledgerTopic = 'ledger', allowanceId }) {
  const op = await session.command(`${ledgerTopic}:reclaimAllowance`, { allowanceId });
  const mat = await op.materialized();
  return { ok: mat.outcome === 'accepted', reason: mat.rejectionCode };
}
