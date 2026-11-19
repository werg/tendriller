import type { Tendril } from '../tendril';
import { pagePolicy } from '../access';
import { selectedApplication } from '../application';
import { json } from '../http';

/** Internal Worker-to-DO lookup. Public routes cannot forward to this namespace. */
export async function integrationPageAccess(t: Tendril, req: Request): Promise<Response> {
  const subject = req.headers.get('x-account-id'), applicationId = req.headers.get('x-application-id');
  const denied = () => json({ access: false, owner: false });
  if (!subject || subject.length > 512 || !applicationId || selectedApplication(t).id !== applicationId) return denied();
  const owner = t.db.get<string | null>('owner_account', null);
  const localAccess = () => {
    if (!owner || t.db.get<string | null>('owner_account', null) !== owner || t.db.get('disabled', false) || selectedApplication(t).id !== applicationId) return false;
    if (subject === owner) return true;
    return !!t.db.one(`SELECT 1 FROM guest_accounts g JOIN links l ON l.id=g.link_id WHERE g.account_id=? AND g.approved=1
      AND l.role='guest' AND (l.expires_at IS NULL OR l.expires_at>?)`, subject, t.now());
  };
  if (!localAccess() || await pagePolicy(t, subject) !== 'active' || !localAccess()) return denied();
  return json({ access: true, owner: subject === owner });
}
