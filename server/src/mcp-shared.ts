import type { Env } from './env';
import { oauthConfig } from './accounts/oauth-support';
import { HttpError, isPlainObject } from './http';

export const APP_ID = /^[a-f0-9]{64}$/u;
export const REQUEST_LIMIT = 64 * 1024;
export const CONNECTED_PAGE_LIMIT = 100;

export type Rpc = { id: string | number | null; method: string; params: Record<string, unknown> };
export type McpPrincipal = {
  account: string;
  grant: string;
  client: string;
  scopes: string[];
  expires: number;
  wrapPublicKey: string;
  wrapPrivateKey: Uint8Array | null;
};

export type ConnectedApp = {
  applicationId: string;
  pageId: string;
  grantId: string;
  handle: string;
  publicKey: string;
  label: string;
};

export async function mcpOAuth(env: Env) {
  const oauth = await oauthConfig(env);
  return oauth?.resource === oauth?.issuer + '/mcp' ? oauth : null;
}

export function fields(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!isPlainObject(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw new HttpError(400, 'invalid_arguments');
  return value;
}

export function string(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || (pattern && !pattern.test(value)))
    throw new HttpError(400, 'invalid_arguments');
  return value;
}

export function requireScope(principal: McpPrincipal, scope: string) {
  if (!principal.scopes.includes(scope)) throw new HttpError(403, 'insufficient_scope');
}

type IndexRow = { application_id: string; page_id: string; grant_id: string; handle: string; public_key: string; label: string };
const fromRow = (row: IndexRow): ConnectedApp => ({
  applicationId: row.application_id,
  pageId: row.page_id,
  grantId: row.grant_id,
  handle: row.handle,
  publicKey: row.public_key,
  label: row.label,
});

/** One indexed query for a specific OAuth grant. Discovery never wakes dormant pages. */
export async function listConnected(env: Env, account: string, grantId: string, cursor: string | null = null): Promise<{ applications: ConnectedApp[]; nextCursor: string | null }> {
  const rows = await env.ACCOUNTS.prepare(`SELECT c.application_id,c.page_id,c.grant_id,c.handle,c.public_key,c.label
    FROM mcp_connections c JOIN tendrils t ON t.id=c.page_id
    WHERE c.account_id=? AND c.grant_id=? AND t.owner_account=c.account_id AND t.state='active' AND c.page_id>?
    ORDER BY c.page_id LIMIT ?`).bind(account, grantId, cursor ?? '', CONNECTED_PAGE_LIMIT + 1).all<IndexRow>();
  const visible = rows.results.slice(0, CONNECTED_PAGE_LIMIT);
  return { applications: visible.map(fromRow), nextCursor: rows.results.length > CONNECTED_PAGE_LIMIT ? visible[visible.length - 1].page_id : null };
}

export async function resolveConnection(env: Env, account: string, grantId: string, applicationId: string): Promise<ConnectedApp> {
  const row = await env.ACCOUNTS.prepare(`SELECT c.application_id,c.page_id,c.grant_id,c.handle,c.public_key,c.label
    FROM mcp_connections c JOIN tendrils t ON t.id=c.page_id
    WHERE c.application_id=? AND c.account_id=? AND c.grant_id=? AND t.owner_account=c.account_id AND t.state='active'`)
    .bind(applicationId, account, grantId).first<IndexRow>();
  if (!row) throw new HttpError(404, 'application_not_connected', 'This application is not opted into hosted MCP for this OAuth grant. Open /connections to connect it.');
  return fromRow(row);
}
