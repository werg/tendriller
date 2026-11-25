/** Page-object side of agent grants: the synchronous mirror, socket revocation and hub events. */
import { agentScopes, localAgentGrant, type AgentScope, type LocalAgentGrant } from './access';
import { addActivity } from './activity';
import { HttpError, json, readJson } from './http';
import { AGENT_ID_RE } from './ids';
import type { Tendril } from './tendril';

export type AgentEventKind = 'grant' | 'revoked' | 'page-deleted' | 'publication';
export const AGENT_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** Every agent-owned socket attachment names its agent either directly or through its principal. */
function socketAgent(ws: WebSocket): { agentId: string; revision?: number } | null {
  let value: { agentId?: unknown; principal?: { kind?: unknown; agentId?: unknown; revision?: unknown } } | null;
  try { value = ws.deserializeAttachment(); } catch { return null; }
  if (value?.principal?.kind === 'agent' && typeof value.principal.agentId === 'string')
    return { agentId: value.principal.agentId, revision: value.principal.revision as number };
  return typeof value?.agentId === 'string' ? { agentId: value.agentId } : null;
}

/** Closes an agent's page sockets, or only those of an older grant revision. */
export function closeAgentSockets(t: Tendril, agentId: string, reason: string, keepRevision?: number): void {
  for (const ws of t.ctx.getWebSockets()) {
    const owner = socketAgent(ws);
    if (!owner || owner.agentId !== agentId || keepRevision !== undefined && owner.revision === keepRevision) continue;
    try { ws.close(4003, reason); } catch { /* already closed */ }
  }
}

/** Mirrored agents, for page-wide events such as publication and deletion. */
export function mirroredAgents(t: Tendril): string[] {
  return t.db.all<{ agent_id: string }>('SELECT agent_id FROM agent_grants ORDER BY agent_id').map(row => row.agent_id);
}

/** Best-effort delivery: a hub without a connection drops events; agents re-read state on reconnect. */
export function notifyAgentHub(t: Tendril, agentId: string, kind: AgentEventKind, data: unknown = {}, page = t.tid): Promise<void> {
  const hub = t.env.AGENT_HUB;
  if (!hub || !page) return Promise.resolve();
  const delivery = hub.get(hub.idFromName(agentId)).fetch(new Request('https://hub.internal/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page, kind, data }),
  })).then(response => response.body?.cancel()).catch(() => {});
  t.ctx.waitUntil(delivery);
  return delivery;
}

export function notifyGrantedAgents(t: Tendril, kind: AgentEventKind, data: unknown = {}): void {
  for (const agentId of mirroredAgents(t)) void notifyAgentHub(t, agentId, kind, data);
}

/** Allocates a revision that is never reused by this page, even after a grant is removed. */
function nextRevision(t: Tendril): number {
  const revision = t.db.get<number>('agent_grant_revision', 0) + 1;
  t.db.set('agent_grant_revision', revision);
  return revision;
}

export function writeLocalGrant(t: Tendril, agentId: string, publicKey: string, scopes: AgentScope[], grantedBy: 'creator' | 'owner'): LocalAgentGrant {
  const revision = nextRevision(t);
  t.db.run(`INSERT INTO agent_grants(agent_id,public_key,scopes,revision,granted_by,granted_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET public_key=excluded.public_key,scopes=excluded.scopes,revision=excluded.revision,
      granted_by=excluded.granted_by,granted_at=excluded.granted_at`, agentId, publicKey, JSON.stringify(scopes), revision, grantedBy, t.now());
  return localAgentGrant(t, agentId)!;
}

/** Owner grant: mirror first, then the D1 routing row; a D1 failure restores the mirror. */
export async function putAgentGrant(t: Tendril, account: string, agentId: string, publicKey: string, scopes: AgentScope[]): Promise<LocalAgentGrant> {
  if (account !== t.db.get<string | null>('owner_account', null)) throw new HttpError(403, 'forbidden', 'Only the page owner can grant agents');
  if (!AGENT_ID_RE.test(agentId)) throw new HttpError(400, 'invalid_agent');
  if (!AGENT_PUBLIC_KEY_RE.test(publicKey)) throw new HttpError(400, 'invalid_public_key');
  const previous = localAgentGrant(t, agentId);
  const grant = t.transaction(() => {
    if (account !== t.db.get<string | null>('owner_account', null)) throw new HttpError(403, 'forbidden');
    const next = writeLocalGrant(t, agentId, publicKey, scopes, previous?.granted_by === 'creator' ? 'creator' : 'owner');
    if (!previous) addActivity(t, { kind: 'agent_grant', summary: `The owner granted agent ${agentId} access`, by: `owner:${account}` });
    return next;
  });
  try {
    await t.env.ACCOUNTS.prepare(`INSERT INTO agent_grants(agent_id,page_id,scopes,revision,granted_at,granted_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(agent_id,page_id) DO UPDATE SET scopes=excluded.scopes,revision=excluded.revision,granted_at=excluded.granted_at`)
      .bind(agentId, t.tid, JSON.stringify(grant.scopes), grant.revision, grant.granted_at, grant.granted_by).run();
  } catch (error) {
    t.transaction(() => {
      if (localAgentGrant(t, agentId)?.revision !== grant.revision) return;
      if (previous) writeLocalGrant(t, agentId, previous.public_key, previous.scopes, previous.granted_by as 'creator' | 'owner');
      else t.db.run('DELETE FROM agent_grants WHERE agent_id=?', agentId);
    });
    throw error;
  }
  closeAgentSockets(t, agentId, 'Agent grant changed', grant.revision);
  void notifyAgentHub(t, agentId, 'grant', { scopes: grant.scopes });
  return grant;
}

/** Revocation: mirror first (applies at the next synchronous check), then sockets, then D1. */
export async function deleteAgentGrant(t: Tendril, agentId: string, by: string): Promise<boolean> {
  const removed = t.transaction(() => {
    if (!localAgentGrant(t, agentId)) return false;
    t.db.run('DELETE FROM agent_grants WHERE agent_id=?', agentId);
    addActivity(t, { kind: 'agent_grant', summary: `Agent ${agentId} lost access`, by });
    return true;
  });
  closeAgentSockets(t, agentId, 'Agent access revoked');
  await t.env.ACCOUNTS.prepare('DELETE FROM agent_grants WHERE agent_id=? AND page_id=?').bind(agentId, t.tid).run();
  if (removed) void notifyAgentHub(t, agentId, 'revoked');
  return removed;
}

/** Internal grant routes, called by account surfaces after their D1 ownership checks. */
export async function handleAgentGrants(t: Tendril, req: Request, url: URL): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson(req, 4096), account = req.headers.get('x-account-id');
  if (typeof body.agentId !== 'string' || !AGENT_ID_RE.test(body.agentId)) throw new HttpError(400, 'invalid_agent');
  if (url.pathname === '/agent-grant/put') {
    if (!account) throw new HttpError(403, 'forbidden', 'Only the page owner can grant agents');
    if (typeof body.publicKey !== 'string') throw new HttpError(400, 'invalid_public_key');
    const grant = await putAgentGrant(t, account, body.agentId, body.publicKey, agentScopes(body.scopes));
    return json({ agentId: body.agentId, page: t.tid, scopes: grant.scopes, revision: grant.revision, granted_by: grant.granted_by });
  }
  if (url.pathname === '/agent-grant/delete')
    return json({ agentId: body.agentId, page: t.tid, removed: await deleteAgentGrant(t, body.agentId, account ? `owner:${account}` : 'service') });
  throw new HttpError(404, 'not_found');
}
