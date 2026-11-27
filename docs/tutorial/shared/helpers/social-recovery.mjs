// Zero-ceremony "Trusted Backup Contacts" (Threshold Social Recovery) helper.
// Guardians hold only encrypted recovery shares and can NEVER read private page data.

/**
 * Configure trusted backup contacts for this page.
 * Any `threshold` of the listed contacts can help you recover access if you lose all devices.
 */
export async function setupTrustedContacts(session, { contacts, threshold = 2 }) {
  const op = await session.setupSocialRecovery({
    threshold,
    guardians: contacts.map(c => ({
      publicKey: c.publicKey,
      wrapKey: c.wrapKey,
      ...(c.label ? { label: c.label } : {}),
    })),
  });
  const mat = await op.materialized();
  return { ok: mat.outcome === 'accepted', reason: mat.rejectionCode, opId: op.id };
}

/** Inspect configured trusted backup contacts and any pending recovery requests. */
export async function inspectRecoveryState(session) {
  const res = await session.query('$permissions', { guardians: true });
  const val = res?.value ?? {};
  return {
    guardians: val.guardians ?? null,
    requests: Object.values(val.recoveryRequests ?? {}),
  };
}

/** Start recovery from a brand-new device; returns a 6-digit match code to share verbally/by text. */
export async function startDeviceRecovery(session, { label = 'New device' } = {}) {
  const res = await session.requestSocialRecovery({ label });
  const mat = await res.operation.materialized();
  return {
    ok: mat.outcome === 'accepted',
    requestId: res.requestId,
    verificationCode: res.verificationCode,
    reason: mat.rejectionCode,
  };
}

/** Called by a trusted contact after verifying the 6-digit match code with the owner. */
export async function approveContactRecovery(session, requestId) {
  const op = await session.approveSocialRecovery(requestId);
  const mat = await op.materialized();
  return { ok: mat.outcome === 'accepted', reason: mat.rejectionCode, opId: op.id };
}

/** Called by the recovering device once enough trusted contacts have approved. */
export async function finishDeviceRecovery(session) {
  return session.completeSocialRecovery();
}
