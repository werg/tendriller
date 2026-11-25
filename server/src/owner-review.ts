import type { Tendril } from './tendril';
import { agentScopes, type AgentScope } from './access';
import { selectedApplication } from './application';
import { HttpError } from './http';
import { publicBase } from './urls';

export interface HostApprovalBinding {
  schemaVersion: 1;
  service_origin: string;
  page_id: string;
  application_id: string;
  owner_account: string;
  owner_claimed_at: number;
}
export interface HostApproval extends HostApprovalBinding {
  hash: string;
  expires_at: number;
  attempts: number;
  mode?: 'delegate';
  name?: string;
  scopes?: AgentScope[];
}

/** Approval records bind the reviewed ownership incarnation, not its browser session. */
export function hostApprovalBinding(t: Tendril, owner: string): HostApprovalBinding {
  const binding: HostApprovalBinding = { schemaVersion: 1, service_origin: publicBase(t.env), page_id: t.tid,
    application_id: selectedApplication(t).id, owner_account: owner, owner_claimed_at: t.db.get('claimed_at', 0) };
  requireHostApprovalBinding(t, binding);
  return binding;
}

export function requireHostApprovalBinding(t: Tendril, binding: HostApprovalBinding): void {
  // Old transient codes have no retained review identity. Never bind them to the
  // current owner/application at redemption; ask the owner for a fresh review.
  if (!binding || binding.schemaVersion !== 1 || binding.service_origin !== publicBase(t.env) ||
      binding.page_id !== t.tid || !binding.page_id || typeof binding.application_id !== 'string' || !binding.application_id ||
      typeof binding.owner_account !== 'string' || !binding.owner_account ||
      !Number.isSafeInteger(binding.owner_claimed_at) || binding.owner_claimed_at <= 0)
    throw new HttpError(409, 'adoption_review_required', 'This code has no current bound owner review. Ask the owner to issue a new code.');
  if (!t.exists() || t.db.get('disabled', false)) throw new HttpError(403, 'disabled', 'This tendril is unavailable');
  if (binding.owner_account !== t.db.get('owner_account', null) || binding.owner_claimed_at !== t.db.get('claimed_at', null))
    throw new HttpError(403, 'adoption_owner_changed', 'The reviewed owner changed. Ask the current owner to issue a new code.');
  if (binding.application_id !== selectedApplication(t).id)
    throw new HttpError(409, 'adoption_application_mismatch', 'The reviewed application changed. Ask its owner to issue a new code.');
}

export function requireHostApproval(t: Tendril, approval: HostApproval): void {
  requireHostApprovalBinding(t, approval);
  if (typeof approval.hash !== 'string' || !/^[a-f0-9]{64}$/.test(approval.hash) ||
      !Number.isSafeInteger(approval.expires_at) || !Number.isSafeInteger(approval.attempts) || approval.attempts < 0 ||
      (approval.mode !== undefined && approval.mode !== 'delegate'))
    throw new HttpError(409, 'adoption_review_required', 'The retained approval is invalid. Ask the owner to issue a new code.');
  if (approval.mode === 'delegate') {
    if (typeof approval.name !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(approval.name) || approval.name === 'setup' || !Array.isArray(approval.scopes))
      throw new HttpError(409, 'adoption_review_required', 'The retained delegation is incomplete. Ask the owner to issue a new code.');
    // In particular, absent scopes must not select addToken's full-access default.
    agentScopes(approval.scopes);
  } else if (approval.name !== undefined || approval.scopes !== undefined) {
    throw new HttpError(409, 'adoption_review_required', 'The retained recovery mode is invalid. Ask the owner to issue a new code.');
  }
}

/** One primary snapshot checks writes and the claimed page's bound active owner. */
export async function requireHostApprovalPolicy(t: Tendril, binding: HostApprovalBinding): Promise<void> {
  requireHostApprovalBinding(t, binding);
  const row = await t.env.ACCOUNTS.prepare(`SELECT s.mode, t.state, t.owner_account,
    a.id AS owner_id, a.suspended_at, a.deleting_at FROM service_state s
    LEFT JOIN tendrils t ON t.id=? LEFT JOIN accounts a ON a.id=t.owner_account WHERE s.id=1`)
    .bind(t.tid).first<{ mode: string; state: string | null; owner_account: string | null;
      owner_id: string | null; suspended_at: number | null; deleting_at: number | null }>();
  if (!row || !['open', 'creation_paused', 'read_only'].includes(row.mode))
    throw new HttpError(503, 'unavailable', 'Service state is not initialized');
  if (row.mode === 'read_only') throw new HttpError(503, 'read_only', 'Writes are temporarily paused');
  requireHostApprovalBinding(t, binding);
  if (row.state !== 'active' || row.owner_account !== binding.owner_account || row.owner_id !== binding.owner_account ||
      row.suspended_at !== null || row.deleting_at !== null)
    throw new HttpError(403, 'disabled', 'This tendril is unavailable');
}
