import { notifySetupChanged } from './setup-watch';
import { escapeHtml } from './inject';
import { browserIdentity, redirect } from './accounts/oauth-data';
import { pagePolicy, currentPrincipal, freshPrincipal, type AgentPrincipal } from './access';
import { selectedApplication } from './application';
import { applicationMetadata } from './authority';
const pendingPeerOwner = (t: Tendril) => `pending-page:${t.tid}`;
import type { Tendril } from './tendril';
import { sha256Hex, safeEqual } from './ids';
import { HttpError, json, readBody, readJson } from './http';
import { servicePage } from './accounts/ui';
import { requireWritesOpen } from './service-state';
import { publicBase } from './urls';
import { APP_NAME, assistantOAuth, fields, string, type EventDefinition, type Operation } from './assistant-shared';
import { selectedProvider, selectProvider, type ConsumerRow } from './assistant-bindings';
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
  const metadata = await applicationMetadata(t);
  const published = { definition: metadata.configuration?.tools as { queries: Operation[]; commands: Operation[] } | undefined };
  if (!published.definition || !Array.isArray(published.definition.queries) || !Array.isArray(published.definition.commands)) throw new HttpError(409, 'tools_not_declared');
  const queries = names(input.queries, published.definition.queries), commands = names(input.commands, published.definition.commands);
  if (!Array.isArray(input.events) || input.events.length > 24) throw new HttpError(400, 'invalid_event_catalog');
  const events = input.events.map(value => {
    const entry = fields(value, ['name', 'description']);
    return { name: string(entry.name, 80, APP_NAME), description: string(entry.description, 400) };
  });
  if (new Set(events.map(event => event.name)).size !== events.length || !queries.length && !commands.length && !events.length)
    throw new HttpError(400, 'invalid_exposure');
  const applicationId = selectedApplication(t).id;
  // Claim changes the authorized owner, not this page's exact prepared proposal.
  const id = await sha256Hex(JSON.stringify([t.tid, applicationId, agent.credentialHash, label, adapterHashes, queries, commands, events]));
  return t.serializeAssistant(async () => {
    const ownerCurrent = () => owner === (t.db.get('owner_account', null) ?? pendingPeerOwner(t));
    if (!await freshPrincipal(t, agent) || !ownerCurrent()) throw new HttpError(403, 'forbidden');
    const previous = proposal(t);
    if (previous?.id === id && previous.owner !== owner) throw new HttpError(403, 'forbidden');
    if (previous?.id !== id) {
      if (claimedOwner) await t.env.ACCOUNTS.prepare(`INSERT INTO assistant_connections(page_id,application_id,owner_account,label) VALUES(?,?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET label=CASE WHEN enabled=0 THEN excluded.label ELSE label END`)
        .bind(t.tid, applicationId, owner, label).run();
      if (!await freshPrincipal(t, agent) || !ownerCurrent()) throw new HttpError(403, 'forbidden');
      t.db.set('assistant_proposal', { id, owner, applicationId, label, adapterHashes, agent, queries, commands, events });
    }
    return json({ applicationId, proposed: id, approved: connection(t)?.id === id && connection(t)?.owner === owner,
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

const GROUP_LABELS: Record<string, string> = {
  queries: 'Read data',
  commands: 'Actions',
  events: 'Notifications',
};

function options(group: string, entries: Array<{ name: string; description: string }>, previous: Array<{ name: string }> | null) {
  if (!entries.length) return '';
  return `<div class="group-label">${GROUP_LABELS[group] ?? escapeHtml(group)} (${entries.length})</div><div class="check-list">${entries.map(item => {
    const checked = previous === null || previous.some(entry => entry.name === item.name);
    return `<label class="check-item"><input type="checkbox" name="${group}" value="${escapeHtml(item.name)}"${checked ? ' checked' : ''}><span class="check-copy"><span class="check-title">${escapeHtml(item.name)}</span><span class="check-desc">${escapeHtml(item.description)}</span></span></label>`;
  }).join('')}</div>`;
}

function summarizeCapabilities(item: Proposal): string {
  const parts: string[] = [];
  if (item.queries.length) parts.push(`read ${item.queries.length} ${item.queries.length === 1 ? 'view' : 'views'}`);
  if (item.commands.length) parts.push(`run ${item.commands.length} ${item.commands.length === 1 ? 'action' : 'actions'}`);
  if (item.events.length) parts.push(`receive ${item.events.length} ${item.events.length === 1 ? 'notification' : 'notifications'}`);
  if (!parts.length) return 'Review the permissions below.';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Allow your connected assistant to ${list} in ${item.label}.`;
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
    const consumers = t.db.all<ConsumerRow>('SELECT * FROM assistant_consumers ORDER BY created_at');
    const pendingConsumers = consumers.filter(agent => agent.status === 'pending');
    const renderConsumer = (agent: ConsumerRow) => {
      const badgeClass = agent.status === 'active' ? 'ok' : agent.status === 'pending' ? 'warn' : 'danger';
      const perms = [
        `Queries: ${JSON.parse(agent.queries).join(', ') || 'none'}`,
        `Commands: ${JSON.parse(agent.commands).join(', ') || 'none'}`,
        `Events: ${JSON.parse(agent.events).join(', ') || 'none'}`,
      ].join(' · ');
      return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${escapeHtml(agent.label)} <span class="badge ${badgeClass}">${escapeHtml(agent.status)}</span></div><p class="list-item-sub">OAuth client <code>${escapeHtml(agent.client_id)}</code> · ${escapeHtml(agent.route)}<br>${escapeHtml(perms)}</p></div><form class="inline-form" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="binding" value="${escapeHtml(agent.id)}"><input type="hidden" name="revision" value="${agent.revision}"><div class="actions tight">${agent.status === 'pending' ? '<button class="sm" name="action" value="approve-agent">Approve</button>' : ''}${agent.status !== 'revoked' ? '<button class="sm danger" name="action" value="revoke-agent">Revoke</button>' : ''}</div></form></li>`;
    };
    const consumerForms = consumers.map(renderConsumer).join('');
    const provider = selectedProvider(t);
    const providerForms = current ? (await freshAdapters(t)).map(hash => {
      const device = t.db.one<{ device_id: string }>('SELECT device_id FROM assistant_devices WHERE adapter_hash=?', hash)?.device_id;
      const isSelected = hash === provider?.adapterHash;
      return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">Provider <code>${escapeHtml(hash.slice(0, 12))}</code> <span class="badge${isSelected ? ' ok' : ''}">${isSelected ? 'Selected tool provider' : 'Alternative tool provider'}</span></div><p class="list-item-sub">${device ? 'Enrolled signer: <code>' + escapeHtml(device) + '</code>' : 'No enrolled process has connected yet.'}</p></div>${device && !isSelected ? `<form class="inline-form" method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="provider" value="${hash}"><input type="hidden" name="epoch" value="${provider?.selectionEpoch ?? 0}"><button class="sm secondary" name="action" value="select-provider">Use for new commands</button></form>` : ''}</li>`;
    }).join('') : '';
    const statusBadge = current && selection
      ? '<span class="badge ok">Connected</span>'
      : current ? '<span class="badge warn">Updated permissions</span>'
      : '<span class="badge">Not connected</span>';
    const primaryLabel = current && selection ? 'Save permissions' : 'Connect assistant';
    const techDetails = `<details class="disclosure"${pendingConsumers.length ? ' open' : ''}><summary>Technical details &amp; connected providers</summary><div class="disclosure-body stack"><dl class="meta-grid"><dt>Participant keys</dt><dd>${item.adapterHashes.map(hash => '<code>' + hash.slice(0, 12) + '</code>').join(' ')}</dd></dl>${current ? `<div><h3>Application tool provider</h3><p class="muted" style="margin-bottom:.65rem;font-size:.86rem">One selected provider executes new commands. Existing operations stay bound to their original signer.</p><ul class="list">${providerForms}</ul></div><div><h3>Independent agents</h3><p class="muted" style="margin-bottom:.65rem;font-size:.86rem">Each approved agent has its own credentials and delivery progress.</p>${consumerForms ? `<ul class="list">${consumerForms}</ul>` : '<p class="empty">No independently registered agents.</p>'}</div>` : ''}</div></details>`;
    const page = servicePage('Assistant connection',
      `<a class="back-link" href="/connections">← Assistant connections</a>
      <form class="stack" method="post"><input type="hidden" name="csrf" value="${csrf}">
      <section class="card">
        <div class="card-head"><div><span class="eyebrow">Assistant access</span><h1>${escapeHtml(item.label)}</h1><p>${escapeHtml(current && selection ? 'All checked permissions are active. Removing an event stops its subscriptions and clears its inbox.' : summarizeCapabilities(item))}</p></div>${statusBadge}</div>
        <div class="actions tight"><button class="lg" name="action" value="approve">${primaryLabel}</button>${current ? '<button class="danger" name="action" value="revoke">Disconnect</button>' : ''}</div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Permissions</h2><p>${selection ? 'Adjust which views, actions and notifications this assistant may use.' : 'All proposed permissions are pre-selected. Uncheck anything you want to keep private.'}</p></div></div>
        ${options('queries', item.queries, selection ? selection.queries : null)}${options('commands', item.commands, selection ? selection.commands : null)}${options('events', item.events, selection ? selection.events : null)}
      </section></form>
      ${techDetails}`);
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
      if (!current || !(await freshAdapters(t)).includes(hash) || !t.db.one('SELECT 1 FROM assistant_devices WHERE adapter_hash=?', hash))
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
      if (!await freshPrincipal(t, item.agent)) throw new HttpError(409, 'adapter_agent_revoked');
      const version = crypto.randomUUID();
      const approved = { id: item.id, version, inboxVersion: version, owner: item.owner, applicationId: item.applicationId, label: item.label,
        queries: names(form.getAll('queries'), item.queries), commands: names(form.getAll('commands'), item.commands),
        events: names(form.getAll('events'), item.events) };
      if (!approved.queries.length && !approved.commands.length && !approved.events.length) throw new HttpError(400, 'no_permissions_selected');
      if (current?.id === item.id && JSON.stringify([current.queries, current.commands, current.events]) ===
        JSON.stringify([approved.queries, approved.commands, approved.events])) return redirect(returnTo);
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
      if (!await freshPrincipal(t, item.agent)) throw new HttpError(409, 'adapter_agent_revoked');
      t.transaction(() => {
        if (!currentPrincipal(t, item.agent)) throw new HttpError(409, 'adapter_agent_revoked');
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
    notifySetupChanged(t);
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
  for (const row of t.db.all<{ id: string }>("SELECT id FROM assistant_consumers WHERE status<>'revoked'")) revokeAssistantConsumer(t, row.id);
  t.db.run('DELETE FROM assistant_jobs');
  t.db.run('DELETE FROM assistant_watchers');
  t.db.run('DELETE FROM assistant_events');
  t.db.run('DELETE FROM assistant_receipts');
}

export function activeAdapters(t: Tendril): readonly string[] {
  if (t.db.get('disabled', false)) return [];
  const approved = connection(t), adapters = t.db.get<{ agent: AgentPrincipal; hashes: string[] } | null>('assistant_adapters', null);
  return approved && adapters && approved.owner === t.db.get('owner_account', null) &&
    currentPrincipal(t, adapters.agent) ? adapters.hashes : [];
}

/** Cached adapter keys cannot outlive the OAuth grant that admitted a setup agent. */
export async function freshAdapters(t: Tendril): Promise<readonly string[]> {
  const adapters = t.db.get<{ agent: AgentPrincipal; hashes: string[] } | null>('assistant_adapters', null);
  if (!adapters || !await freshPrincipal(t, adapters.agent)) return [];
  // Reread after external policy lookup: concurrent owner revocation or a changed
  // proposal must not retain the old adapter's permission through this await.
  const current = t.db.get<{ agent: AgentPrincipal; hashes: string[] } | null>('assistant_adapters', null);
  return JSON.stringify(current?.agent) === JSON.stringify(adapters.agent) ? activeAdapters(t) : [];
}
