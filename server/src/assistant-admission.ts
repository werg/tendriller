import { escapeHtml } from './inject';
import { browserIdentity, redirect } from './accounts/oauth-data';
import { pagePolicy, currentPrincipal, type AgentPrincipal } from './access';
import { selectedApplication } from './application';
import { pendingPeerOwner, exchangePeerControl } from './peer-generations';
import type { Tendril } from './tendril';
import { sha256Hex, safeEqual } from './ids';
import { HttpError, json, readBody, readJson } from './http';
import { servicePage } from './accounts/ui';
import { requireWritesOpen } from './service-state';
import { publicBase } from './urls';
import { APP_NAME, assistantOAuth, fields, string, type EventDefinition, type Operation } from './assistant-shared';
import { initializeAssistantBindings, selectedProvider, selectProvider, type ConsumerRow } from './assistant-bindings';
import { revokeAssistantConsumer } from './assistant-events';

export type Proposal = {
  id: string; owner: string; applicationId: string; label: string; adapterHashes: string[]; agent: AgentPrincipal;
  queries: Operation[]; commands: Operation[]; events: EventDefinition[];
};
export type Connection = Pick<Proposal, 'id' | 'owner' | 'applicationId' | 'label' | 'queries' | 'commands' | 'events'> & { version: string; inboxVersion: string };
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
  const claimedOwner = t.db.get<string | null>('owner_account', null);
  const owner = claimedOwner ?? pendingPeerOwner(t);
  const input = fields(await readJson(req, 16384), ['label', 'adapterHashes', 'queries', 'commands', 'events']);
  const label = string(input.label, 100);
  if (!Array.isArray(input.adapterHashes) || !input.adapterHashes.length || input.adapterHashes.length > 3 ||
    new Set(input.adapterHashes).size !== input.adapterHashes.length) throw new HttpError(400, 'invalid_adapter_keys');
  const adapterHashes = input.adapterHashes.map(hash => string(hash, 64, /^[a-f0-9]{64}$/u));
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
  const id = await sha256Hex(JSON.stringify([owner, applicationId, agent.credentialHash, label, adapterHashes, queries, commands, events]));
  return t.serializeAssistant(async () => {
    if (owner !== (t.db.get('owner_account', null) ?? pendingPeerOwner(t)) || !currentPrincipal(t, agent)) throw new HttpError(403, 'forbidden');
    const previous = proposal(t);
    if (previous?.id !== id) {
      if (claimedOwner) await t.env.ACCOUNTS.prepare(`INSERT INTO assistant_connections(page_id,application_id,owner_account,label) VALUES(?,?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET label=CASE WHEN enabled=0 THEN excluded.label ELSE label END`)
        .bind(t.tid, applicationId, owner, label).run();
      t.db.set('assistant_proposal', { id, owner, applicationId, label, adapterHashes, agent, queries, commands, events });
    }
    return json({ applicationId, proposed: id, approved: connection(t)?.id === id,
      reviewUrl: publicBase(t.env) + reviewPath(t.tid) });
  });
}

/** Claim activates discovery only; queries, commands and events still need owner consent. */
export async function adoptPreparedAssistant(t: Tendril, accountId: string): Promise<void> {
  return t.serializeAssistant(async () => {
    const item = proposal(t);
    if (!item || item.owner !== pendingPeerOwner(t) && item.owner !== accountId) return;
    if (t.db.get('owner_account', null) !== accountId) throw new HttpError(403, 'forbidden');
    await t.env.ACCOUNTS.prepare(`INSERT INTO assistant_connections(page_id,application_id,owner_account,label) VALUES(?,?,?,?)
      ON CONFLICT(page_id) DO UPDATE SET label=CASE WHEN enabled=0 THEN excluded.label ELSE label END`)
      .bind(t.tid, item.applicationId, accountId, item.label).run();
    if (item.owner === pendingPeerOwner(t)) t.db.set('assistant_proposal', { ...item, owner: accountId });
  });
}

function options(group: string, entries: Array<{ name: string; description: string }>, previous: Array<{ name: string }> = []) {
  if (!entries.length) return '';
  return `<fieldset><legend>${group}</legend>${entries.map(item =>
    `<p><label><input type="checkbox" name="${group}" value="${escapeHtml(item.name)}"${previous.some(entry => entry.name === item.name) ? " checked" : ""}> <strong>${escapeHtml(item.name)}</strong></label><br>${escapeHtml(item.description)}</p>`).join('')}</fieldset>`;
}

export async function reviewAssistant(t: Tendril, req: Request) {
  const browser = await browserIdentity(req, t.env);
  const returnTo = reviewPath(t.tid);
  if (!browser) return redirect('/auth?return_to=' + encodeURIComponent(returnTo));
  const item = proposal(t);
  if (!item || item.owner !== browser.id || browser.id !== t.db.get('owner_account', null) || await pagePolicy(t, browser.id) !== 'active')
    throw new HttpError(404, 'application_not_found');
  const current = connection(t);
  const csrf = await sha256Hex(JSON.stringify([browser.sessionHash, item.id, current?.version, t.tid, 'application-mcp-consent']));
  if (req.method === 'GET') {
    const selection = current?.id === item.id ? current : null;
    const consumers = t.db.get('assistant_binding_tables_v1', false)
      ? t.db.all<ConsumerRow>('SELECT * FROM assistant_consumers ORDER BY created_at') : [];
    const consumerForms = consumers.map(agent => `<li><strong>${escapeHtml(agent.label)}</strong> · ${escapeHtml(agent.status)} · ${escapeHtml(agent.route)}
      <p>OAuth client: ${escapeHtml(agent.client_id)}. Queries: ${escapeHtml(JSON.parse(agent.queries).join(', ') || 'none')}.
      Commands: ${escapeHtml(JSON.parse(agent.commands).join(', ') || 'none')}. Events: ${escapeHtml(JSON.parse(agent.events).join(', ') || 'none')}.</p>
      <form method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="binding" value="${escapeHtml(agent.id)}">
      <input type="hidden" name="revision" value="${agent.revision}">${agent.status === 'pending' ? '<button name="action" value="approve-agent">Approve this agent</button>' : ''}
      ${agent.status !== 'revoked' ? '<button name="action" value="revoke-agent">Revoke this agent</button>' : ''}</form></li>`).join('');
    const provider = selectedProvider(t);
    const providerForms = current ? activeAdapters(t).map(hash => {
      const device = t.db.one<{ device_id: string }>('SELECT device_id FROM assistant_devices WHERE adapter_hash=?', hash)?.device_id;
      return `<li>Provider key <code>${escapeHtml(hash.slice(0, 12))}</code> · ${hash === provider?.adapterHash ? 'Selected executor' : 'Read replica'}
        <p>${device ? 'Enrolled signer: <code>' + escapeHtml(device) + '</code>' : 'No enrolled process has connected.'}</p>
        ${device && hash !== provider?.adapterHash ? `<form method="post"><input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="provider" value="${hash}"><input type="hidden" name="epoch" value="${provider?.selectionEpoch ?? 0}">
        <button name="action" value="select-provider">Use for new commands</button></form>` : ''}</li>`;
    }).join('') : '';
    const page = servicePage('Assistant connection',
    `<h1>${escapeHtml(item.label)}</h1><p>${current ? 'Removing an event stops its subscriptions and removes that event from the inbox.' : 'Choose what the assistant may access.'}</p>
    <p>Participant keys ${item.adapterHashes.map(hash => '<code>' + hash.slice(0, 12) + '</code>').join(', ')}</p>
    <form method="post"><input type="hidden" name="csrf" value="${csrf}">
    ${options('queries', item.queries, selection?.queries)}${options('commands', item.commands, selection?.commands)}${options('events', item.events, selection?.events)}
    <button name="action" value="approve">Approve selected permissions</button>
    ${current ? '<button name="action" value="revoke">Disconnect application</button>' : ''}</form>
    ${current ? `<section><h2>Application tool provider</h2><p>One selected provider executes new commands. Existing operations remain bound to their original signer.</p><ul>${providerForms}</ul></section>
    <section><h2>Independent agents</h2><p>Each approved agent has a separate proof, operation namespace and delivery progress. Revoking one agent leaves the others connected.</p><ul>${consumerForms || '<li>No independently registered agents.</li>'}</ul></section>` : ''}`);
    const headers = new Headers(page.headers);
    headers.set('Content-Security-Policy', headers.get('Content-Security-Policy') + "; frame-ancestors 'none'");
    return new Response(page.body, { status: page.status, headers });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if (req.headers.get('Origin') !== publicBase(t.env)) throw new HttpError(403, 'invalid_origin');
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 8192, 3000)));
  if (!safeEqual(form.get('csrf') ?? '', csrf)) throw new HttpError(403, 'invalid_confirmation');
  return t.serializeAssistant(async () => {
    if (proposal(t)?.id !== item.id || connection(t)?.version !== current?.version || t.db.get('owner_account', null) !== browser.id)
      throw new HttpError(409, 'proposal_changed');
    if (form.get('action') === 'approve-agent' || form.get('action') === 'revoke-agent') {
      if (!current) throw new HttpError(409, 'application_not_connected');
      initializeAssistantBindings(t);
      const agent = t.db.one<ConsumerRow>('SELECT * FROM assistant_consumers WHERE id=?', form.get('binding') ?? '');
      if (!agent || String(agent.revision) !== form.get('revision')) throw new HttpError(409, 'agent_binding_changed');
      if (form.get('action') === 'approve-agent') {
        await requireWritesOpen(t.env);
        if (agent.status !== 'pending') throw new HttpError(409, 'agent_binding_changed');
        t.db.run("UPDATE assistant_consumers SET status='active',revision=revision+1 WHERE id=?", agent.id);
      } else t.transaction(() => revokeAssistantConsumer(t, agent.id));
    } else if (form.get('action') === 'select-provider') {
      await requireWritesOpen(t.env);
      const hash = form.get('provider') ?? '';
      if (!current || !activeAdapters(t).includes(hash) || !t.db.one('SELECT 1 FROM assistant_devices WHERE adapter_hash=?', hash))
        throw new HttpError(403, 'provider_not_approved');
      if (String(selectedProvider(t)?.selectionEpoch ?? 0) !== form.get('epoch')) throw new HttpError(409, 'provider_changed');
      selectProvider(t, hash);
    } else if (form.get('action') === 'revoke') {
      t.transaction(() => {
        t.db.del('assistant_connection');
        t.db.del('assistant_adapters');
        t.db.del('assistant_provider');
        resetAssistantConnection(t);
        t.afterCommit(() => closeAssistantConnections(t, []));
      });
      await t.env.ACCOUNTS.prepare("UPDATE assistant_connections SET enabled=0 WHERE page_id=?").bind(t.tid).run();
    } else if (form.get('action') === 'approve') {
      await requireWritesOpen(t.env);
      if (!currentPrincipal(t, item.agent)) throw new HttpError(409, 'adapter_agent_revoked');
      const version = crypto.randomUUID();
      const approved = { id: item.id, version, inboxVersion: version, owner: item.owner, applicationId: item.applicationId, label: item.label,
        queries: names(form.getAll('queries'), item.queries), commands: names(form.getAll('commands'), item.commands),
        events: names(form.getAll('events'), item.events) };
      if (!approved.queries.length && !approved.commands.length && !approved.events.length) throw new HttpError(400, 'no_permissions_selected');
      if (current?.id === item.id && JSON.stringify([current.queries, current.commands, current.events]) ===
        JSON.stringify([approved.queries, approved.commands, approved.events])) return redirect(returnTo);
      initializeAssistantTables(t);
      initializeAssistantBindings(t);
      try {
        await t.env.ACCOUNTS.prepare('UPDATE assistant_connections SET enabled=1,label=? WHERE page_id=? AND owner_account=?')
          .bind(approved.label, t.tid, browser.id).run();
      } catch (error) {
        const another = await t.env.ACCOUNTS.prepare(`SELECT page_id FROM assistant_connections
          WHERE owner_account=? AND application_id=? AND enabled=1 AND page_id<>?`)
          .bind(browser.id, approved.applicationId, t.tid).first();
        if (another) throw new HttpError(409, 'application_already_connected', 'This account already connected a page with this application ID');
        throw error;
      }
      const removed = (current?.events ?? []).filter(previous => !approved.events.some(event =>
        event.name === previous.name && event.description === previous.description)).map(event => event.name);
      const sameEvents = current && JSON.stringify(current.events) === JSON.stringify(approved.events);
      if (sameEvents) approved.inboxVersion = current.inboxVersion;
      t.transaction(() => {
        for (const name of removed) {
          t.db.run('DELETE FROM assistant_jobs WHERE watcher_id IN (SELECT id FROM assistant_watchers WHERE name=?)', name);
          t.db.run('DELETE FROM assistant_watchers WHERE name=?', name);
          t.db.run('DELETE FROM assistant_events WHERE name=?', name);
          t.db.run('DELETE FROM assistant_receipts WHERE name=?', name);
        }
        t.db.set('assistant_connection', approved);
        t.db.set('assistant_adapters', { agent: item.agent, hashes: item.adapterHashes });
        if (!selectedProvider(t) || !item.adapterHashes.includes(selectedProvider(t)!.adapterHash)) selectProvider(t, item.adapterHashes[0]);
        t.afterCommit(() => closeAssistantConnections(t, item.adapterHashes, Boolean(sameEvents)));
      });
    } else throw new HttpError(400, 'invalid_action');
    return redirect(returnTo);
  });
}

function closeAssistantConnections(t: Tendril, keep: string[], keepInbox = false) {
  for (const tag of ['application-mcp', 'application-activity']) {
    if (tag === 'application-activity' && keepInbox) continue;
    for (const ws of t.ctx.getWebSockets(tag)) {
      if (tag === 'application-mcp' && keep.includes(ws.deserializeAttachment()?.adapterHash)) continue;
      try { ws.close(4003, 'Application connection changed'); } catch { /* Already closed */ }
    }
  }
}

function resetAssistantConnection(t: Tendril) {
  if (t.db.get('assistant_binding_tables_v1', false)) {
    for (const row of t.db.all<{ id: string }>("SELECT id FROM assistant_consumers WHERE status<>'revoked'")) revokeAssistantConsumer(t, row.id);
  }
  if (t.db.get('assistant_tables', false)) {
    t.db.run('DELETE FROM assistant_jobs');
    t.db.run('DELETE FROM assistant_watchers');
    t.db.run('DELETE FROM assistant_events');
    t.db.run('DELETE FROM assistant_receipts');
  }
}

function initializeAssistantTables(t: Tendril) {
  if (t.db.get('assistant_tables', false)) return;
  t.transaction(() => {
    t.db.run(`CREATE TABLE IF NOT EXISTS assistant_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL,
      generation TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(generation,source_id,name));
      CREATE TABLE IF NOT EXISTS assistant_watchers(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL,
      url TEXT NOT NULL, secret TEXT NOT NULL, previous_secret TEXT, rotate_until INTEGER,
      verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_jobs(event_seq INTEGER NOT NULL, watcher_id TEXT NOT NULL,
      due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, block_reason TEXT, PRIMARY KEY(event_seq,watcher_id));
      CREATE TABLE IF NOT EXISTS assistant_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL,
      name TEXT NOT NULL, source_id TEXT NOT NULL, generation TEXT NOT NULL, watcher_id TEXT NOT NULL,
      outcome TEXT NOT NULL, attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_receipts_client ON assistant_receipts(client_id,seq DESC);
      CREATE TABLE IF NOT EXISTS assistant_commands(operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL,
      device_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_devices(adapter_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_jobs_due ON assistant_jobs(due);`);
    t.db.set('assistant_tables', true);
  });
}

export function activeAdapters(t: Tendril): readonly string[] {
  if (t.db.get('disabled', false)) return [];
  const approved = connection(t), adapters = t.db.get<{ agent: AgentPrincipal; hashes: string[] } | null>('assistant_adapters', null);
  return approved && adapters && approved.owner === t.db.get('owner_account', null) &&
    currentPrincipal(t, adapters.agent) ? adapters.hashes : [];
}
