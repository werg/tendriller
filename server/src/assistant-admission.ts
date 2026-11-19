import { escapeHtml } from './inject';
import { browserIdentity, redirect } from './accounts/oauth-data';
import { pagePolicy, currentPrincipal, type AgentPrincipal } from './access';
import { selectedApplication } from './application';
import { exchangePeerControl } from './peer-generations';
import type { Tendril } from './tendril';
import { sha256Hex, safeEqual } from './ids';
import { HttpError, json, readBody, readJson } from './http';
import { servicePage } from './accounts/ui';
import { requireWritesOpen } from './service-state';
import { publicBase } from './urls';
import { APP_NAME, assistantOAuth, fields, string, type EventDefinition, type Operation } from './assistant-shared';

export type Proposal = {
  id: string; owner: string; applicationId: string; label: string; adapterHash: string; agent: AgentPrincipal;
  queries: Operation[]; commands: Operation[]; events: EventDefinition[];
};
export type Connection = Pick<Proposal, 'id' | 'owner' | 'applicationId' | 'label' | 'queries' | 'commands' | 'events'> & { version: string };
export const proposal = (t: Tendril) => t.db.get<Proposal | null>('assistant_proposal', null);
export const connection = (t: Tendril) => t.db.get<Connection | null>('assistant_connection', null);

const names = <T extends { name: string }>(input: unknown, available: readonly T[]): T[] => {
  if (!Array.isArray(input) || input.length > 24 || new Set(input).size !== input.length)
    throw new HttpError(400, 'invalid_exposure');
  return input.map(value => {
    const entry = available.find(item => item.name === value);
    if (!entry) throw new HttpError(400, 'unpublished_operation');
    return entry;
  });
};
const reviewPath = (pageId: string) => '/connections/' + pageId;

export async function proposeAssistant(t: Tendril, req: Request, agent: AgentPrincipal) {
  if (!await assistantOAuth(t.env)) throw new HttpError(503, 'assistant_oauth_unavailable');
  const owner = t.db.get<string | null>('owner_account', null);
  if (!owner) throw new HttpError(409, 'claim_page_first');
  const input = fields(await readJson(req, 16384), ['label', 'adapterHash', 'queries', 'commands', 'events']);
  const label = string(input.label, 100), adapterHash = string(input.adapterHash, 64, /^[a-f0-9]{64}$/u);
  const published = await exchangePeerControl(t, agent, 'definition') as { definition: { queries: Operation[]; commands: Operation[] } };
  const queries = names(input.queries, published.definition.queries), commands = names(input.commands, published.definition.commands);
  if (!Array.isArray(input.events) || input.events.length > 24) throw new HttpError(400, 'invalid_event_catalog');
  const events = input.events.map(value => {
    const entry = fields(value, ['name', 'description']);
    return { name: string(entry.name, 80, APP_NAME), description: string(entry.description, 400) };
  });
  if (new Set(events.map(event => event.name)).size !== events.length || !queries.length && !commands.length && !events.length)
    throw new HttpError(400, 'invalid_exposure');
  const applicationId = selectedApplication(t).id;
  // A replacement is a new grant even when the published schemas look alike.
  const id = await sha256Hex(JSON.stringify([owner, applicationId, agent.credentialHash, label, adapterHash, queries, commands, events]));
  return t.serializeAssistant(async () => {
    if (owner !== t.db.get('owner_account', null) || !currentPrincipal(t, agent)) throw new HttpError(403, 'forbidden');
    const previous = proposal(t);
    if (previous?.id !== id) {
      await t.env.ACCOUNTS.prepare(`INSERT INTO assistant_connections(page_id,application_id,owner_account,label) VALUES(?,?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET label=CASE WHEN enabled=0 THEN excluded.label ELSE label END`)
        .bind(t.tid, applicationId, owner, label).run();
      t.db.set('assistant_proposal', { id, owner, applicationId, label, adapterHash, agent, queries, commands, events });
    }
    return json({ applicationId, proposed: id, approved: connection(t)?.id === id,
      reviewUrl: publicBase(t.env) + reviewPath(t.tid) });
  });
}

function options(group: string, entries: Array<{ name: string; description: string }>) {
  if (!entries.length) return '';
  return `<fieldset><legend>${group}</legend>${entries.map(item =>
    `<p><label><input type="checkbox" name="${group}" value="${escapeHtml(item.name)}"> <strong>${escapeHtml(item.name)}</strong></label><br>${escapeHtml(item.description)}</p>`).join('')}</fieldset>`;
}

export async function reviewAssistant(t: Tendril, req: Request) {
  const browser = await browserIdentity(req, t.env);
  const returnTo = reviewPath(t.tid);
  if (!browser) return redirect('/auth?return_to=' + encodeURIComponent(returnTo));
  const item = proposal(t);
  if (!item || item.owner !== browser.id || browser.id !== t.db.get('owner_account', null) || await pagePolicy(t, browser.id) !== 'active')
    throw new HttpError(404, 'application_not_found');
  const current = connection(t);
  const csrf = await sha256Hex(JSON.stringify([browser.sessionHash, item.id, t.tid, 'application-mcp-consent']));
  if (req.method === 'GET') {
    const page = servicePage('Assistant connection',
    `<h1>${escapeHtml(item.label)}</h1><p>${current ? 'Connection enabled. Review this proposal to change access.' : 'Choose what the assistant may access.'}</p>
    <form method="post"><input type="hidden" name="csrf" value="${csrf}">
    ${options('queries', item.queries)}${options('commands', item.commands)}${options('events', item.events)}
    <button name="action" value="approve">Approve selected permissions</button>
    ${current ? '<button name="action" value="revoke">Disconnect application</button>' : ''}</form>`);
    const headers = new Headers(page.headers);
    headers.set('Content-Security-Policy', headers.get('Content-Security-Policy') + "; frame-ancestors 'none'");
    return new Response(page.body, { status: page.status, headers });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if (req.headers.get('Origin') !== publicBase(t.env)) throw new HttpError(403, 'invalid_origin');
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 8192, 3000)));
  if (!safeEqual(form.get('csrf') ?? '', csrf)) throw new HttpError(403, 'invalid_confirmation');
  return t.serializeAssistant(async () => {
    if (proposal(t)?.id !== item.id || t.db.get('owner_account', null) !== browser.id)
      throw new HttpError(409, 'proposal_changed');
    if (form.get('action') === 'revoke') {
      t.db.del('assistant_connection');
      resetAssistantConnection(t);
      await t.env.ACCOUNTS.prepare("UPDATE assistant_connections SET enabled=0,exposed_events='[]' WHERE page_id=?").bind(t.tid).run();
    } else if (form.get('action') === 'approve') {
      await requireWritesOpen(t.env);
      if (!currentPrincipal(t, item.agent)) throw new HttpError(409, 'adapter_agent_revoked');
      const approved = { id: item.id, version: crypto.randomUUID(), owner: item.owner, applicationId: item.applicationId, label: item.label,
        queries: names(form.getAll('queries'), item.queries), commands: names(form.getAll('commands'), item.commands),
        events: names(form.getAll('events'), item.events) };
      if (!approved.queries.length && !approved.commands.length && !approved.events.length) throw new HttpError(400, 'no_permissions_selected');
      initializeAssistantTables(t);
      await t.env.ACCOUNTS.prepare('UPDATE assistant_connections SET enabled=1,label=?,exposed_events=? WHERE page_id=? AND owner_account=?')
        .bind(approved.label, JSON.stringify(approved.events), t.tid, browser.id).run();
      t.transaction(() => {
        resetAssistantConnection(t);
        t.db.set('assistant_connection', approved);
        t.db.set('assistant_adapter', { id: item.id, agent: item.agent, hash: item.adapterHash });
      });
    } else throw new HttpError(400, 'invalid_action');
    return redirect(returnTo);
  });
}

function resetAssistantConnection(t: Tendril) {
  if (t.db.get('assistant_tables', false)) {
    t.db.run('DELETE FROM assistant_jobs');
    t.db.run('DELETE FROM assistant_watchers');
    t.db.run('DELETE FROM assistant_events');
  }
  for (const ws of t.ctx.getWebSockets('application-mcp')) ws.close(4003, 'Application connection changed');
}

function initializeAssistantTables(t: Tendril) {
  if (t.db.get('assistant_tables', false)) return;
  t.transaction(() => {
    t.db.run(`CREATE TABLE IF NOT EXISTS assistant_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL,
      generation TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(generation,source_id,name));
      CREATE TABLE IF NOT EXISTS assistant_watchers(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, name TEXT NOT NULL,
      url TEXT NOT NULL, secret TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_jobs(event_seq INTEGER NOT NULL, watcher_id TEXT NOT NULL,
      due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(event_seq,watcher_id));
      CREATE INDEX IF NOT EXISTS assistant_jobs_due ON assistant_jobs(due);`);
    t.db.set('assistant_tables', true);
  });
}

export type Adapter = { id: string; agent: AgentPrincipal; hash: string };
export function activeAdapter(t: Tendril): Adapter | null {
  if (t.db.get('disabled', false)) return null;
  const approved = connection(t), adapter = t.db.get<Adapter | null>('assistant_adapter', null);
  return approved && adapter && approved.id === adapter.id && approved.owner === t.db.get('owner_account', null) &&
    currentPrincipal(t, adapter.agent) ? adapter : null;
}
