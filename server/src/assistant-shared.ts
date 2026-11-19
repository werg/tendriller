import type { Env } from './env';
import { oauthConfig } from './accounts/oauth-support';
import { HttpError, isPlainObject } from './http';

export const ASSISTANT_PROTOCOL = 'tendriller.application-mcp.v1';
export const ASSISTANT_SOCKET_TAG = 'application-mcp';
export const APP_ID = /^[a-f0-9]{64}$/u;
export const ADAPTER_KEY = /^td_a_[a-f0-9]{64}$/u;
export const APP_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;
export const REQUEST_LIMIT = 64 * 1024;
export const EVENT_LIMIT = 8 * 1024;

export type Rpc = { id: string | number | null; method: string; params: Record<string, unknown> };
export type Principal = { account: string; grant: string; scopes: string[]; expires: number };
export type Operation = { name: string; description: string; input: unknown };
export type EventDefinition = { name: string; description: string };
export type Catalogue = { applicationId: string; pageId: string; label: string };

export async function assistantOAuth(env: Env) {
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

export function requireScope(principal: Principal, scope: string) {
  if (!principal.scopes.includes(scope)) throw new HttpError(403, 'insufficient_scope');
}

export const MCP_APPLICATION_EVENT = 'application.event';
export const mcpEventDefinition = {
  name: MCP_APPLICATION_EVENT, description: 'An approved event from one connected application. Use describe_application to find its event names.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { application_id: { type: 'string', pattern: APP_ID.source },
    event: { type: 'string', pattern: APP_NAME.source } }, required: ['application_id', 'event'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: { applicationId: { type: 'string' }, event: { type: 'string' },
    sourceEventId: { type: 'string' }, generation: { type: 'string' }, payload: {} },
    required: ['applicationId', 'event', 'sourceEventId', 'generation', 'payload'], additionalProperties: false },
};
type IndexRow = { application_id: string; page_id: string; label: string };
const fromRow = (row: IndexRow): Catalogue => ({
  applicationId: row.application_id, pageId: row.page_id, label: row.label,
});

/** One indexed query. Discovery never fans out to dormant pages. */
export async function listConnected(env: Env, account: string): Promise<Catalogue[]> {
  const rows = await env.ACCOUNTS.prepare(`SELECT c.application_id,c.page_id,c.label
    FROM assistant_connections c JOIN tendrils t ON t.id=c.page_id
    WHERE c.owner_account=? AND c.enabled=1 AND t.owner_account=c.owner_account AND t.state='active'
    ORDER BY c.page_id LIMIT 20`).bind(account).all<IndexRow>();
  return rows.results.map(fromRow);
}

export async function resolveConnection(env: Env, account: string, applicationId: string): Promise<Catalogue> {
  const row = await env.ACCOUNTS.prepare(`SELECT c.application_id,c.page_id,c.label
    FROM assistant_connections c JOIN tendrils t ON t.id=c.page_id
    WHERE c.application_id=? AND c.owner_account=? AND c.enabled=1 AND t.owner_account=c.owner_account AND t.state='active'`)
    .bind(applicationId, account).first<IndexRow>();
  if (!row) throw new HttpError(404, 'application_not_connected');
  return fromRow(row);
}
