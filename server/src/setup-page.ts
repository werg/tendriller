import type { Tendril } from './tendril';
import { readSetupRow } from './account-setup';
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
/** Exact initial provisioning only. This internal namespace never injects credentials into existing pages. */
export async function setupPage(t: Tendril, req: Request): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const action = new URL(req.url).pathname, input = await readJson(req, 1024), id = req.headers.get('x-tendril-id') ?? '';
  if (!['/setup/inspect','/setup/initialize'].includes(action) || !/^[a-z2-7]{12}$/.test(id) ||
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
      if (known || row.state === 'ready') throw new HttpError(409, 'reconciliation_required');
      return json({ missing: true });
    }
    if (!known || t.tid !== id || known.digest !== row.request_digest || known.commitment !== row.credential_commitment ||
        known.account_id !== row.account_id || known.client_id !== row.client_id || known.grant_id !== row.grant_id ||
        known.expires_at !== row.expires_at || known.service_origin !== row.service_origin ||
        t.db.get<{ id: string } | null>('application', null)?.id !== row.application_id)
      throw new HttpError(409, 'reconciliation_required', 'The page does not match its retained account setup journal.');
    const { token: _secret, ...page } = t.handle('');
    const token = t.db.one<{ hash: string }>("SELECT hash FROM tokens WHERE name='setup'");
    return json({ page, credentialActive: token?.hash === row.credential_commitment });
  };
  if (t.exists() || action === '/setup/inspect') return inspect();
  if (row.expires_at <= t.now() || !await setupCredentialActive(t.env, row)) throw new HttpError(403, 'setup_binding_inactive');
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
    t.db.set('id', id); t.db.set('name', request.name); t.db.set('mode', request.mode);
    t.db.set('intended_owner', row.intended_email); t.db.set('intended_owner_account', row.account_id);
    t.db.set('lifetime', 'ad_hoc'); t.db.set('application', applicationSelection({ id: row.application_id }));
    t.db.set('created_at', row.created_at); t.db.set('next_cleanup', row.expires_at);
    t.db.set('account_setup', { digest: row.request_digest, page: id, commitment: row.credential_commitment, account_id: row.account_id,
      client_id: row.client_id, grant_id: row.grant_id, service_origin: row.service_origin, expires_at: row.expires_at } satisfies SetupBinding);
    t.db.run("INSERT INTO tokens(name,hash,created_at,last_used) VALUES('setup',?,?,NULL)", row.credential_commitment, now);
    t.db.set('agent_binding:setup', { id: crypto.randomUUID(), scopes: SETUP_SCOPES, revision: 1 });
    t.db.run("INSERT INTO links(id,key,key_hash,role,label,created_at,expires_at) VALUES('l_main',?,?,'owner','main',?,NULL)", key, keyHash, now);
    addActivity(t, { kind: 'created', summary: `Tendril "${request.name}" prepared for its linked account` });
  });
  t.scheduleAlarm();
  return inspect();
}
