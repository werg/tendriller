import type { Tendril } from './tendril';
import { readSetupRow, type SetupRow } from './account-setup';
import { setupCredentialActive } from './setup-credential';
import { setupRequestDigest } from '../../contract/setup.mjs';
import { applicationSelection } from '../../contract/application.mjs';
import { addActivity } from './activity';
import { HttpError, json, readJson } from './http';
import { newPageKey, sha256Hex } from './ids';
import { requireCreationOpen } from './service-state';
import { publicBase } from './urls';
import type { AgentScope } from './access';

const SETUP_SCOPES: AgentScope[] = ['host:read','participants:connect','control:write','publication:write','assistant:manage'];
export interface SetupBinding {
  digest: string; page: string; commitment: string; account_id: string; client_id: string; grant_id: string; service_origin: string; expires_at: number;
}
interface SetupReservation extends SetupBinding { state: 'pending' | 'expired' | 'retired' }
const reservation = (t: Tendril) => t.db.get<SetupReservation | null>('account_setup_reservation', null);
const bindingFor = (row: SetupRow): SetupBinding => ({ digest: row.request_digest, page: row.page_id, commitment: row.credential_commitment,
  account_id: row.account_id, client_id: row.client_id, grant_id: row.grant_id, service_origin: row.service_origin, expires_at: row.expires_at });
const matches = (known: SetupBinding, row: SetupRow) => (Object.entries(bindingFor(row)) as [keyof SetupBinding, unknown][]).every(([key, value]) => known[key] === value);
function requireReservation(t: Tendril, row: SetupRow): SetupReservation {
  const known = reservation(t);
  if (!known || !matches(known, row)) throw new HttpError(409, 'reconciliation_required', 'The page reservation journal is missing or does not match this allocation.');
  if (known.state !== 'pending' || known.expires_at <= t.now()) throw new HttpError(410, 'setup_expired');
  return known;
}
/** Empty setup objects retain a deadline before they can consume global admission. */
export function nextSetupDeadline(t: Tendril): number | null {
  const known = reservation(t);
  return !t.exists() && known && known.state !== 'retired' ? known.expires_at : null;
}
/** Fence initialization before releasing an unoccupied reservation; failures retry by alarm. */
export async function expireSetupReservation(t: Tendril): Promise<void> {
  const known = reservation(t);
  if (t.exists() || !known || known.state === 'retired' || known.expires_at > t.now()) return;
  t.transaction(() => {
    if (t.exists()) throw new HttpError(409, 'reconciliation_required');
    t.db.set('account_setup_reservation', { ...known, state: 'expired' } satisfies SetupReservation);
  });
  await t.env.ACCOUNTS.batch([
    t.env.ACCOUNTS.prepare("UPDATE account_setups SET state='expired',failure_code='setup_expired',updated_at=? WHERE page_id=? AND request_digest=?")
      .bind(t.now(), known.page, known.digest),
    t.env.ACCOUNTS.prepare(`DELETE FROM tendrils WHERE id=? AND owner_account IS NULL AND EXISTS(
      SELECT 1 FROM account_setup_allocations a WHERE a.page_id=tendrils.id AND a.request_digest=?)`).bind(known.page, known.digest),
  ]);
  const released = await t.env.ADMISSION.get(t.env.ADMISSION.idFromName('global')).fetch(new Request('https://admission.internal/release', {
    method: 'POST', headers: { 'x-tendril-id': known.page },
  }));
  if (!released.ok) throw new HttpError(503, 'setup_cleanup_pending');
  t.db.set('account_setup_reservation', { ...known, state: 'retired' } satisfies SetupReservation);
}
/** Exact initial provisioning only. This internal namespace never injects credentials into existing pages. */
export async function setupPage(t: Tendril, req: Request): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const action = new URL(req.url).pathname, input = await readJson(req, 1024), id = req.headers.get('x-tendril-id') ?? '';
  if (!['/setup/inspect','/setup/reserve','/setup/initialize'].includes(action) || !/^[a-z2-7]{12}$/.test(id) ||
      typeof input.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestDigest)) throw new HttpError(400, 'invalid_setup_request');
  const row = await readSetupRow(t.env, id);
  if (!row || row.request_digest !== input.requestDigest || row.service_origin !== publicBase(t.env)) throw new HttpError(409, 'reconciliation_required');
  let request;
  try { request = JSON.parse(row.request_json); }
  catch { throw new HttpError(409, 'reconciliation_required'); }
  if (request.operationId !== row.operation_id || request.applicationId !== row.application_id ||
      request.credentialCommitment !== row.credential_commitment || await setupRequestDigest(row.service_origin, request) !== row.request_digest)
    throw new HttpError(409, 'reconciliation_required');
  const metadata = (): SetupBinding | null => t.db.get<SetupBinding | null>('account_setup', null);
  const inspect = () => {
    const known = metadata();
    if (!t.exists()) {
      if (known || row.state === 'ready' || (row.indexed || row.initialization_started) && !reservation(t)) throw new HttpError(409, 'reconciliation_required');
      if (reservation(t)) requireReservation(t, row);
      return json({ missing: true });
    }
    if (!known || t.tid !== id || !matches(known, row) ||
        t.db.get<{ id: string } | null>('application', null)?.id !== row.application_id)
      throw new HttpError(409, 'reconciliation_required', 'The page does not match its retained account setup journal.');
    const { token: _secret, ...page } = t.handle('');
    const token = t.db.one<{ hash: string }>("SELECT hash FROM tokens WHERE name='setup'");
    return json({ page, credentialActive: token?.hash === row.credential_commitment });
  };
  if (t.exists() || action === '/setup/inspect') return inspect();
  if (row.expires_at <= t.now()) throw new HttpError(410, 'setup_expired');
  if (!await setupCredentialActive(t.env, row)) throw new HttpError(403, 'setup_binding_inactive');
  if (action === '/setup/reserve') {
    await requireCreationOpen(t.env);
    t.transaction(() => {
      if (t.exists()) return;
      if (!reservation(t)) {
        if (row.indexed || row.initialization_started) throw new HttpError(409, 'reconciliation_required');
        t.db.set('account_setup_reservation', { ...bindingFor(row), state: 'pending' } satisfies SetupReservation);
      }
      requireReservation(t, row);
    });
    // Await durable scheduling before the caller sends /reserve to Admission.
    await t.ensureSetupExpiry(row.expires_at);
    return t.exists() ? inspect() : json({ reserved: true });
  }
  requireReservation(t, row);
  const verified = await t.env.ACCOUNTS.prepare(`SELECT 1 FROM identities i JOIN identity_emails e ON e.provider=i.provider AND e.subject=i.subject
    WHERE i.account_id=? AND lower(e.email)=?`).bind(row.account_id, row.intended_email).first();
  if (!verified) throw new HttpError(403, 'owner_verification_required');
  const indexed = await t.env.ACCOUNTS.prepare('SELECT state,owner_account,intended_owner FROM tendrils WHERE id=?').bind(id)
    .first<{ state: string; owner_account: string | null; intended_owner: string | null }>();
  if (!row.indexed || !row.initialization_started || !indexed || indexed.state !== 'active' || indexed.owner_account !== null || indexed.intended_owner !== row.intended_email)
    throw new HttpError(409, 'reconciliation_required');
  const key = newPageKey(), keyHash = await sha256Hex(key);
  await requireCreationOpen(t.env);
  if (!await setupCredentialActive(t.env, row)) throw new HttpError(403, 'setup_binding_inactive');
  const now = t.now();
  t.transaction(() => {
    // The DO can interleave asynchronous admission, but this write set cannot.
    if (t.exists()) return;
    if (metadata()) throw new HttpError(409, 'reconciliation_required');
    requireReservation(t, row);
    t.db.set('id', id); t.db.set('name', request.name); t.db.set('mode', request.mode);
    t.db.set('intended_owner', row.intended_email); t.db.set('intended_owner_account', row.account_id);
    t.db.set('lifetime', 'ad_hoc'); t.db.set('application', applicationSelection({ id: row.application_id }));
    t.db.set('created_at', row.created_at); t.db.set('next_cleanup', row.expires_at);
    t.db.set('account_setup', bindingFor(row));
    t.db.run("INSERT INTO tokens(name,hash,created_at,last_used) VALUES('setup',?,?,NULL)", row.credential_commitment, now);
    t.db.set('agent_binding:setup', { id: crypto.randomUUID(), scopes: SETUP_SCOPES, revision: 1 });
    t.db.run("INSERT INTO links(id,key,key_hash,role,label,created_at,expires_at) VALUES('l_main',?,?,'owner','main',?,NULL)", key, keyHash, now);
    addActivity(t, { kind: 'created', summary: `Tendril "${request.name}" prepared for its linked account` });
  });
  t.scheduleAlarm();
  return inspect();
}
