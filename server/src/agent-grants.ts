/** Page-object side of agent grants, @handle/bio mirrors, primary-agent selection, and hub events. */
import { agentScopes, localAgentGrant, type AgentScope, type LocalAgentGrant } from './access';
import { addActivity } from './activity';
import { HttpError, json, readJson } from './http';
import { AGENT_ID_RE } from './ids';
import { notifyAgentsWatchers } from './publication-watch';
import type { Tendril } from './tendril';

export type AgentEventKind = 'grant' | 'revoked' | 'page-deleted' | 'publication' | 'agents-changed';
export const AGENT_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const AGENT_HANDLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const AGENT_BIO_MAX = 160;

export function validAgentHandle(value: unknown): string {
  const handle = typeof value === 'string' ? value.trim().replace(/^@+/, '').toLowerCase() : '';
  if (!AGENT_HANDLE_RE.test(handle)) {
    throw new HttpError(400, 'invalid_agent_handle', 'Agent handles must be 2–32 lowercase characters starting with a letter (a-z, 0-9, _, -).');
  }
  return handle;
}

export function validAgentBio(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_agent_bio', 'Agent bio must be a string.');
  const trimmed = value.trim();
  if (trimmed.length > AGENT_BIO_MAX || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new HttpError(400, 'invalid_agent_bio', `Agent bio must be at most ${AGENT_BIO_MAX} printable characters.`);
  }
  return trimmed;
}

export interface PageAgentEntry {
  id: string;
  kind: 'workspace' | 'hosted-mcp';
  handle: string;
  bio: string;
  public_key: string;
  is_primary: boolean;
  granted_by?: string;
  granted_at: number;
}

export interface PageAgentRoster {
  primary_agent_id: string | null;
  agents: PageAgentEntry[];
}

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

/** Mirrored workspace agents, for page-wide events such as publication, roster change and deletion. */
export function mirroredAgents(t: Tendril): string[] {
  return t.db.all<{ agent_id: string }>('SELECT agent_id FROM agent_grants ORDER BY agent_id').map(row => row.agent_id);
}

/** Unified roster of workspace agents and opted-in hosted MCP agents on this page. */
export function pageAgents(t: Tendril): PageAgentRoster {
  const primaryId = t.db.get<string | null>('primary_agent_id', null);
  const workspaceRows = t.db.all<{ agent_id: string; handle: string; bio: string; public_key: string; granted_by: string; granted_at: number }>(
    'SELECT agent_id,handle,bio,public_key,granted_by,granted_at FROM agent_grants ORDER BY granted_at, agent_id',
  );
  const mcpRows = t.db.all<{ grant_id: string; handle: string; bio: string; public_key: string; created_at: number }>(
    'SELECT grant_id,handle,bio,public_key,created_at FROM mcp_connections ORDER BY created_at, grant_id',
  );
  const agents: PageAgentEntry[] = [
    ...workspaceRows.map(row => ({
      id: row.agent_id,
      kind: 'workspace' as const,
      handle: row.handle,
      bio: row.bio,
      public_key: row.public_key,
      is_primary: row.agent_id === primaryId,
      granted_by: row.granted_by,
      granted_at: row.granted_at,
    })),
    ...mcpRows.map(row => ({
      id: `mcp:${row.grant_id}`,
      kind: 'hosted-mcp' as const,
      handle: row.handle,
      bio: row.bio,
      public_key: row.public_key,
      is_primary: `mcp:${row.grant_id}` === primaryId,
      granted_at: row.created_at,
    })),
  ];
  const resolvedPrimary = primaryId && agents.some(item => item.id === primaryId) ? primaryId : null;
  return { primary_agent_id: resolvedPrimary, agents };
}

/** Keep primary_agent_id valid after grant/connection changes: auto-select first or sole survivor, clear if dangling. */
export function reconcilePrimaryAgent(t: Tendril): string | null {
  const current = t.db.get<string | null>('primary_agent_id', null);
  const roster = pageAgents(t);
  if (current && roster.agents.some(item => item.id === current)) return current;
  const next = roster.agents.length === 1 ? roster.agents[0].id : null;
  if (next) t.db.set('primary_agent_id', next);
  else t.db.del('primary_agent_id');
  return next;
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

/** Push live roster + primary state to every granted workspace agent hub and every open browser tab. */
export function notifyRosterChanged(t: Tendril): void {
  const roster = pageAgents(t);
  notifyGrantedAgents(t, 'agents-changed', roster);
  notifyAgentsWatchers(t);
}

/** Allocates a revision that is never reused by this page, even after a grant is removed. */
function nextRevision(t: Tendril): number {
  const revision = t.db.get<number>('agent_grant_revision', 0) + 1;
  t.db.set('agent_grant_revision', revision);
  return revision;
}

export function writeLocalGrant(
  t: Tendril,
  agentId: string,
  handle: string,
  bio: string,
  publicKey: string,
  scopes: AgentScope[],
  grantedBy: 'creator' | 'owner',
): LocalAgentGrant {
  const revision = nextRevision(t);
  t.db.run(`INSERT INTO agent_grants(agent_id,handle,bio,public_key,scopes,revision,granted_by,granted_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET handle=excluded.handle,bio=excluded.bio,public_key=excluded.public_key,
      scopes=excluded.scopes,revision=excluded.revision,granted_by=excluded.granted_by,granted_at=excluded.granted_at`,
    agentId, handle, bio, publicKey, JSON.stringify(scopes), revision, grantedBy, t.now());
  if (!t.db.get<string | null>('primary_agent_id', null)) {
    t.db.set('primary_agent_id', agentId);
  }
  return localAgentGrant(t, agentId)!;
}

/** Owner action: explicitly choose (or clear) the page's primary agent. */
export function setPrimaryAgent(t: Tendril, agentId: string | null, by: string): PageAgentRoster {
  const roster = pageAgents(t);
  if (agentId !== null && !roster.agents.some(item => item.id === agentId)) {
    throw new HttpError(404, 'not_found', 'That agent does not have access to this page.');
  }
  const previous = roster.primary_agent_id;
  if (previous !== agentId) {
    t.transaction(() => {
      if (agentId === null) {
        t.db.del('primary_agent_id');
        addActivity(t, { kind: 'agent_primary', summary: 'Cleared the primary agent for this page', by });
      } else {
        const chosen = roster.agents.find(item => item.id === agentId)!;
        t.db.set('primary_agent_id', agentId);
        addActivity(t, { kind: 'agent_primary', summary: `Set @${chosen.handle} as primary agent`, by });
      }
      t.afterCommit(() => notifyRosterChanged(t));
    });
  }
  return pageAgents(t);
}

/** Owner grant: mirror first, then the D1 routing row; a D1 failure restores the mirror. */
export async function putAgentGrant(
  t: Tendril,
  account: string,
  agentId: string,
  handle: string,
  bio: string,
  publicKey: string,
  scopes: AgentScope[],
): Promise<LocalAgentGrant> {
  if (account !== t.db.get<string | null>('owner_account', null)) throw new HttpError(403, 'forbidden', 'Only the page owner can grant agents');
  if (!AGENT_ID_RE.test(agentId)) throw new HttpError(400, 'invalid_agent');
  if (!AGENT_PUBLIC_KEY_RE.test(publicKey)) throw new HttpError(400, 'invalid_public_key');
  const cleanHandle = validAgentHandle(handle);
  const cleanBio = validAgentBio(bio);
  const previous = localAgentGrant(t, agentId);
  const previousPrimary = t.db.get<string | null>('primary_agent_id', null);
  const grant = t.transaction(() => {
    if (account !== t.db.get<string | null>('owner_account', null)) throw new HttpError(403, 'forbidden');
    const next = writeLocalGrant(t, agentId, cleanHandle, cleanBio, publicKey, scopes, previous?.granted_by === 'creator' ? 'creator' : 'owner');
    if (!previous) addActivity(t, { kind: 'agent_grant', summary: `The owner granted @${cleanHandle} access`, by: `owner:${account}` });
    return next;
  });
  try {
    await t.env.ACCOUNTS.prepare(`INSERT INTO agent_grants(agent_id,page_id,scopes,revision,granted_at,granted_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(agent_id,page_id) DO UPDATE SET scopes=excluded.scopes,revision=excluded.revision,granted_at=excluded.granted_at`)
      .bind(agentId, t.tid, JSON.stringify(grant.scopes), grant.revision, grant.granted_at, grant.granted_by).run();
  } catch (error) {
    t.transaction(() => {
      if (localAgentGrant(t, agentId)?.revision !== grant.revision) return;
      if (previous) writeLocalGrant(t, agentId, previous.handle, previous.bio, previous.public_key, previous.scopes, previous.granted_by as 'creator' | 'owner');
      else t.db.run('DELETE FROM agent_grants WHERE agent_id=?', agentId);
      if (previousPrimary) t.db.set('primary_agent_id', previousPrimary);
      else t.db.del('primary_agent_id');
    });
    throw error;
  }
  closeAgentSockets(t, agentId, 'Agent grant changed', grant.revision);
  void notifyAgentHub(t, agentId, 'grant', { scopes: grant.scopes });
  notifyRosterChanged(t);
  return grant;
}

/** Update an agent's mirrored handle/bio in place without revoking its active sockets. */
export function syncAgentProfile(t: Tendril, agentId: string, handle: string, bio: string): boolean {
  const existing = localAgentGrant(t, agentId);
  if (!existing) return false;
  const cleanHandle = validAgentHandle(handle);
  const cleanBio = validAgentBio(bio);
  if (existing.handle === cleanHandle && existing.bio === cleanBio) return true;
  t.transaction(() => {
    t.db.run('UPDATE agent_grants SET handle=?, bio=? WHERE agent_id=?', cleanHandle, cleanBio, agentId);
    t.afterCommit(() => notifyRosterChanged(t));
  });
  return true;
}

/** Revocation: mirror first (applies at the next synchronous check), then sockets, then D1. */
export async function deleteAgentGrant(t: Tendril, agentId: string, by: string): Promise<boolean> {
  const removed = t.transaction(() => {
    const existing = localAgentGrant(t, agentId);
    if (!existing) return false;
    t.db.run('DELETE FROM agent_grants WHERE agent_id=?', agentId);
    reconcilePrimaryAgent(t);
    addActivity(t, { kind: 'agent_grant', summary: `Agent @${existing.handle} lost access`, by });
    return true;
  });
  closeAgentSockets(t, agentId, 'Agent access revoked');
  await t.env.ACCOUNTS.prepare('DELETE FROM agent_grants WHERE agent_id=? AND page_id=?').bind(agentId, t.tid).run();
  if (removed) {
    void notifyAgentHub(t, agentId, 'revoked');
    notifyRosterChanged(t);
  }
  return removed;
}

/** Internal grant & roster routes, called by account surfaces after their D1 ownership checks. */
export async function handleAgentGrants(t: Tendril, req: Request, url: URL): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson(req, 4096), account = req.headers.get('x-account-id');
  if (url.pathname === '/agent-grant/primary') {
    if (!account || account !== t.db.get<string | null>('owner_account', null)) throw new HttpError(403, 'forbidden', 'Only the page owner can choose the primary agent');
    const agentId = body.agentId === null || body.agentId === '' ? null : typeof body.agentId === 'string' ? body.agentId : undefined;
    if (agentId === undefined) throw new HttpError(400, 'invalid_agent');
    return json(setPrimaryAgent(t, agentId, `owner:${account}`));
  }
  if (typeof body.agentId !== 'string' || !AGENT_ID_RE.test(body.agentId)) throw new HttpError(400, 'invalid_agent');
  if (url.pathname === '/agent-grant/put') {
    if (!account) throw new HttpError(403, 'forbidden', 'Only the page owner can grant agents');
    if (typeof body.publicKey !== 'string') throw new HttpError(400, 'invalid_public_key');
    const grant = await putAgentGrant(t, account, body.agentId, body.handle, body.bio, body.publicKey, agentScopes(body.scopes));
    return json({ agentId: body.agentId, handle: grant.handle, bio: grant.bio, page: t.tid, scopes: grant.scopes, revision: grant.revision, granted_by: grant.granted_by });
  }
  if (url.pathname === '/agent-grant/profile') {
    const updated = syncAgentProfile(t, body.agentId, body.handle, body.bio);
    return json({ agentId: body.agentId, updated });
  }
  if (url.pathname === '/agent-grant/delete')
    return json({ agentId: body.agentId, page: t.tid, removed: await deleteAgentGrant(t, body.agentId, account ? `owner:${account}` : 'service') });
  throw new HttpError(404, 'not_found');
}
