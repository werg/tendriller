import { applicationSelection, type ApplicationSelection } from '../../contract/application.mjs';
import { currentPrincipal, type Principal } from './access';
import { HttpError, json, readJson } from './http';
import { applicationMetadata, prepareApplication, freshAuthorityAccess } from './authority';
import type { Tendril } from './tendril';

/** Page storage holds identity only. Application state belongs to the owned session. */
export function selectedApplication(t: Tendril): ApplicationSelection {
  const value = t.db.get('application', null);
  if (value === null) throw new HttpError(503, 'application_identity_missing');
  return applicationSelection(value);
}
export async function handleApplication(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'page' && current.role === 'display') throw new HttpError(403, 'forbidden');
  if (req.method === 'POST') return json(await prepareApplication(t, principal, await readJson(req, 256 * 1024)));
  if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
  // Page routes were just admitted by one page-policy read; only host credentials need a fresh check here.
  if (principal.kind === 'agent') await freshAuthorityAccess(t, principal);
  return json(await applicationMetadata(t));
}
