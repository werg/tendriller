import type { Env } from '../env';
import { readBody } from '../http';
import { sha256Hex } from '../ids';
import { serviceSession } from './auth';
import { object, oauthJson, randomToken, reject, type OAuthConfig } from './oauth-support';

export interface OAuthGrant { id: string; account_id: string; client_id: string; resource: string; scope: string; created_at: number; expires_at: number; revoked_at: number | null }
export const scopesOf = (grant: Pick<OAuthGrant, 'scope'>): string[] => grant.scope ? grant.scope.split(' ') : [];
export async function activeAccount(env: Env, subject: string): Promise<boolean> {
  return !!await env.ACCOUNTS.prepare('SELECT id FROM accounts WHERE id=? AND suspended_at IS NULL AND deleting_at IS NULL').bind(subject).first();
}
export async function activeGrant(env: Env, config: OAuthConfig, id: string, subject?: string): Promise<OAuthGrant | null> {
  const row = await env.ACCOUNTS.prepare(`SELECT g.* FROM integration_oauth_grants g JOIN accounts a ON a.id=g.account_id
    WHERE g.id=? AND g.resource=? AND g.revoked_at IS NULL AND g.expires_at>?
      AND a.suspended_at IS NULL AND a.deleting_at IS NULL`).bind(id, config.resource, Date.now()).first<OAuthGrant>();
  const client = row && config.clients.find(value => value.id === row.client_id);
  if (!row || !client || subject !== undefined && row.account_id !== subject || scopesOf(row).some(scope => !client.scopes.includes(scope))) return null;
  return row;
}
export async function revokeGrant(env: Env, id: string): Promise<void> {
  await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(), id).run();
}
export async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare('DELETE FROM integration_oauth_intents WHERE expires_at<=?').bind(now),
    env.ACCOUNTS.prepare('DELETE FROM integration_oauth_handoffs WHERE expires_at<=?').bind(now),
    env.ACCOUNTS.prepare('DELETE FROM integration_oauth_access WHERE expires_at<=?').bind(now),
    env.ACCOUNTS.prepare('DELETE FROM integration_oauth_grants WHERE expires_at<=? OR revoked_at<?').bind(now, now - 600000),
  ]);
}
export async function browserIdentity(req: Request, env: Env): Promise<{ id: string; sessionHash: string; email: string | null } | null> {
  const session = await serviceSession(req, env);
  if (!session) return null;
  const raw = /(?:^|;\s*)__Host-tendriller=([^;]+)/u.exec(req.headers.get('Cookie') ?? '')?.[1];
  if (!raw) return null;
  return { id: session.accountId, sessionHash: await sha256Hex(raw), email: session.email };
}
export type BrowserIdentity = NonNullable<Awaited<ReturnType<typeof browserIdentity>>>;
export function sameOrigin(req: Request, config: OAuthConfig): void {
  if (req.headers.get('Origin') !== config.issuer) reject('access_denied', 'A same-origin authenticated form is required', 403);
}
export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' } });
}
export function authorizationRedirect(config: OAuthConfig, uri: string, state: string, values: Record<string, string>): Response {
  const destination = new URL(uri);
  for (const [key, value] of Object.entries({ ...values, state, iss: config.issuer })) destination.searchParams.set(key, value);
  return redirect(destination.href);
}
export async function intent(env: Env, browser: BrowserIdentity, kind: 'authorize' | 'handoff' | 'revoke', payload: unknown): Promise<string> {
  await cleanup(env);
  const token = randomToken(), now = Date.now();
  const result = await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_intents(hash,kind,account_id,session_hash,payload,created_at,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id
      WHERE s.hash=? AND s.account_id=? AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL)
    AND (SELECT COUNT(*) FROM integration_oauth_intents WHERE account_id=?)<20`)
    .bind(await sha256Hex(token), kind, browser.id, browser.sessionHash, JSON.stringify(payload), now, now + 600000,
      browser.sessionHash, browser.id, now, browser.id).run();
  if (result.meta.changes !== 1) reject('access_denied', 'Browser session expired or too many authorization forms are pending', 403);
  return token;
}
export async function consumeIntent(env: Env, browser: BrowserIdentity, kind: string, token: string): Promise<Record<string, unknown>> {
  const row = await env.ACCOUNTS.prepare(`DELETE FROM integration_oauth_intents WHERE hash=? AND kind=? AND account_id=? AND session_hash=?
    AND expires_at>? AND EXISTS(SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.account_id=?
      AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL) RETURNING payload`)
    .bind(await sha256Hex(token), kind, browser.id, browser.sessionHash, Date.now(), browser.sessionHash, browser.id, Date.now()).first<{ payload: string }>();
  if (!row) reject('access_denied', 'Authorization form expired, changed browser session or was already used', 403);
  return object(JSON.parse(row!.payload));
}
export async function bodyObject(req: Request, allowed: string[], required = allowed): Promise<Record<string, unknown>> {
  if (req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') reject('invalid_request', 'Use application/json', 415);
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readBody(req, 8192, 10000)))); }
  catch { return reject('invalid_request', 'Invalid bounded JSON request'); }
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) reject('invalid_request', 'Missing or unknown request fields');
  return value;
}
export function postOnly(req: Request): Response | null {
  return req.method === 'POST' ? null : oauthJson({ error: 'invalid_request', error_description: 'Use POST' }, 405, { Allow: 'POST' });
}
