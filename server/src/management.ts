import type { Tendril } from './tendril';
import { validOptionalEmail } from './tendril';
import type { PagePrincipal } from './access';
import { AGENT_SCOPES, currentPrincipal, localAgentGrant } from './access';
import { addActivity } from './activity';
import { brandMark } from './brand';
import { renderQrSvg } from './qr';
import { listVersions, pointers } from './files';
import { escapeHtml } from './inject';
import { HttpError, readBody } from './http';
import { avatar, icon, renderShell } from './accounts/ui';
import { copyAttrs, renderCopyText, SITE_COPY } from './site-copy';
import { cleanupPageCustomDomain } from './custom-domains';
import { getPageSubdomain, setPageSubdomain, subdomainPlanAllowed } from './subdomains';
import { getAccountEntitlements } from './billing/entitlements';
import { hostApprovalBinding, requireHostApprovalBinding, requireHostApprovalPolicy } from './owner-review';
import { listAccountAgents, type AccountAgent } from './agents';
import { deleteAgentGrant, mirroredAgents, pageAgents, putAgentGrant, setPrimaryAgent } from './agent-grants';

export interface PageManagementView {
  tid: string;
  rawName: string;
  base: string;
  publicBase: string;
  owner: boolean;
  role: string;
  ownerUrl: string;
  currentVersion: number;
  lifetime: string;
  tab: 'device' | 'person' | 'agent';
  message?: string;
  createdLink?: { url: string; role: string; email: string | null } | null;
  pendingGuests: number;
  primaryAgentId: string | null;
  rosterAgents: Array<{ id: string; handle: string; bio: string | null; kind: 'workspace' | 'hosted-mcp'; is_primary: boolean; origin: string }>;
  accountAgents: Array<{ id: string; handle: string; bio: string | null; grants: number; checked: boolean }>;
  shareLinks: Array<{ id: string; role: string; label: string | null; email: string | null; url: string; expires_at: number | null }>;
  versions: Array<{ version: number; message: string | null }>;
  openReaders?: boolean;
  openWriters?: boolean;
  subdomain?: string | null;
  bareUrl?: string;
  fallbackBareUrl?: string;
  pageBaseDomain?: string;
  subdomainAllowed?: boolean;
  subdomainUsed?: number;
  subdomainLimit?: number | null;
  now?: number;
  editable?: boolean;
}

export function renderPageDeletedHtml(options: { base: string; dashboardUrl: string; editable?: boolean }): string {
  const editable = Boolean(options.editable);
  const d = SITE_COPY.pageManage.deleted;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  return renderShell({
    title: 'Page deleted',
    brand: brandMark(options.base + '_tendril/brand/', options.dashboardUrl),
    brandBase: options.base + '_tendril/brand/',
    nav: `<a class="nav-link" href="${options.dashboardUrl}">Dashboard</a>`,
    footer: '',
    themeToggle: editable,
    body: `<section class="card"><span class="eyebrow"${c('pageManage.deleted.eyebrow', d.eyebrow)}>${renderCopyText(d.eyebrow)}</span><h1${c('pageManage.deleted.title', d.title)}>${renderCopyText(d.title)}</h1><p class="lead"${c('pageManage.deleted.lead', d.lead)}>${renderCopyText(d.lead)}</p><div class="actions"><a class="button" href="${options.dashboardUrl}">Back to dashboard</a></div></section>`,
  });
}

export function renderPageManagementHtml(view: PageManagementView): string {
  const editable = Boolean(view.editable);
  const pm = SITE_COPY.pageManage;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const txt = (t: string) => renderCopyText(t);
  const now = view.now ?? Date.now();
  const actionURL = text(`${view.base}_tendril/manage`);
  const pageName = text(view.rawName);
  const brandPrefix = `${view.base}_tendril/brand/`;
  const qr = (value: string, caption: string, size = 176) => {
    try { return `<div class="qr-frame">${renderQrSvg(value, { sizePx: size, label: caption })}<span>${text(caption)}</span></div>`; }
    catch { return '<p class="fine">This link is too long for a QR code. Copy it instead.</p>'; }
  };
  const copyField = (value: string, label: string, id: string) =>
    `<div class="copy-box"><label class="field-label" for="${id}">${text(label)}</label><input id="${id}" type="text" readonly value="${text(value)}"></div>`;
  const agentRows = view.rosterAgents.map(entry => {
    const primaryBadge = entry.is_primary ? ' <span class="badge ok">Primary</span>' : '';
    const bioLine = entry.bio ? `${text(entry.bio)} · ` : '';
    const removeForm = entry.kind === 'workspace'
      ? `<form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="remove-agent"><input type="hidden" name="agent" value="${text(entry.id)}"><button class="sm danger">Remove access</button></form>`
      : `<a class="button sm secondary" href="${text(view.publicBase + '/connections')}">Manage MCP</a>`;
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${icon('bot')} @${text(entry.handle)}${primaryBadge}</div><p class="list-item-sub">${bioLine}${text(entry.origin)}</p></div>${removeForm}</li>`;
  }).join('');
  const primaryRadios = view.rosterAgents.length
    ? `<form action="${actionURL}" method="post" style="margin-top:.85rem"><input type="hidden" name="action" value="set-primary-agent"><div class="field"><label class="field-label" for="primary-agent-select">Primary agent (answers general messages)</label><select id="primary-agent-select" name="agent_id"><option value=""${view.primaryAgentId === null ? ' selected' : ''}>None (only direct @mentions)</option>${view.rosterAgents.map(entry => `<option value="${text(entry.id)}"${entry.is_primary ? ' selected' : ''}>@${text(entry.handle)}${entry.kind === 'hosted-mcp' ? ' (Hosted MCP)' : ''}</option>`).join('')}</select></div><div class="actions"><button class="secondary sm" type="submit">Save primary agent</button></div></form>`
    : '';
  const agentChecks = view.accountAgents.map(agent =>
    `<label class="check-item"><input type="hidden" name="known" value="${text(agent.id)}"><input type="checkbox" name="agent" value="${text(agent.id)}"${agent.checked ? ' checked' : ''}><span class="check-copy"><span class="check-title">${icon('bot')} @${text(agent.handle)}</span><span class="check-desc">${agent.bio ? `${text(agent.bio)} · ` : ''}${agent.grants} ${agent.grants === 1 ? 'page' : 'pages'} granted</span></span></label>`,
  ).join('');
  const shareRows = view.shareLinks.map(link => {
    const roleLabel = link.role === 'guest' ? 'Guest invite' : 'Page-only';
    const roleClass = link.role === 'guest' ? 'ok' : '';
    const emailBadge = link.email ? ` <span class="badge">${text(link.email)}</span>` : '';
    const expired = link.expires_at !== null && link.expires_at <= now;
    const expiry = expired ? 'Expired' : link.expires_at ? `Expires ${new Date(link.expires_at).toLocaleDateString()}` : 'No expiry';
    const qrHtml = expired ? '' : `<details class="disclosure" style="margin-top:.55rem"><summary>${icon('qr')} QR code for nearby devices</summary><div class="disclosure-body" style="display:flex;justify-content:center">${qr(link.url, `Scan to open this ${roleLabel.toLowerCase()} link`, 168)}</div></details>`;
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${icon(link.role === 'guest' ? 'user-plus' : 'link')} ${text(link.label || roleLabel)} <span class="badge ${roleClass}">${roleLabel}</span>${emailBadge}</div><p class="list-item-sub"><code>${text(link.url)}</code><br>${text(expiry)}</p>${qrHtml}</div><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="revoke-link"><input type="hidden" name="link_id" value="${text(link.id)}"><button class="sm danger">Revoke</button></form></li>`;
  }).join('');
  const versionsHtml = view.versions.map(version =>
    `<li class="list-item"><div class="list-item-main"><div class="list-item-title">Version ${text(version.version)}${version.version === view.currentVersion ? ' <span class="badge ok">Current</span>' : ''}</div>${version.message ? `<p class="list-item-sub">${text(version.message)}</p>` : ''}</div></li>`,
  ).join('');
  const checked = (name: 'device' | 'person' | 'agent') => view.tab === name ? ' checked' : '';
  const linkResult = view.createdLink ? `<div class="result" role="status"><h3>${icon('check')} ${view.createdLink.role === 'guest' ? 'Invite link ready' : 'Page-only link ready'}</h3><p class="fine">${view.createdLink.role === 'guest' ? `Send this to ${view.createdLink.email ? text(view.createdLink.email) : 'the person you are inviting'}, or let them scan the code. They sign in with GitHub or Google to join.` : 'Anyone with this link can open the page files without signing in.'}</p><div class="split"><div class="stack-sm">${copyField(view.createdLink.url, 'Invite link', 'created-link')}</div>${qr(view.createdLink.url, 'Scan to join')}</div></div>` : '';

  const addPanel = `<section class="card" id="add" aria-labelledby="add-title">
      <div class="card-head"><div><span class="eyebrow">${icon('sparkles')} <span${c('pageManage.add.eyebrow', pm.add.eyebrow)}>${txt(pm.add.eyebrow)}</span></span><h2 id="add-title"${c('pageManage.add.title', pm.add.title)}>${txt(pm.add.title)}</h2><p${c('pageManage.add.lead', pm.add.lead)}>${txt(pm.add.lead)}</p></div></div>
      <div class="tabs">
        <input class="tab-input" type="radio" name="add-tab" id="tab-device" aria-controls="panel-device"${checked('device')}>
        <input class="tab-input" type="radio" name="add-tab" id="tab-person" aria-controls="panel-person"${checked('person')}>
        <input class="tab-input" type="radio" name="add-tab" id="tab-agent" aria-controls="panel-agent"${checked('agent')}>
        <div class="tab-list"><label for="tab-device">${icon('phone')} My device</label><label for="tab-person">${icon('user-plus')} A person</label><label for="tab-agent">${icon('bot')} An agent</label></div>
        <div class="tab-panels">
          <div class="tab-panel" id="panel-device"><div class="split"><div><h3${c('pageManage.add.deviceTitle', pm.add.deviceTitle)}>${txt(pm.add.deviceTitle)}</h3><ol class="steps">${pm.add.deviceSteps.map((step, i) => `<li><span${c(`pageManage.add.deviceSteps.${i}`, step)}>${txt(step)}</span></li>`).join('')}</ol>${copyField(view.ownerUrl, 'Your page link (keep it private)', 'owner-link')}</div>${qr(view.ownerUrl, 'Scan with your other device')}</div></div>
          <div class="tab-panel" id="panel-person"><h3${c('pageManage.add.personTitle', pm.add.personTitle)}>${txt(pm.add.personTitle)}</h3><p class="muted" style="font-size:.9rem"${c('pageManage.add.personLead', pm.add.personLead)}>${txt(pm.add.personLead)}</p>
            <form action="${actionURL}" method="post">
              <input type="hidden" name="action" value="create-link">
              <div class="field-row"><div class="field"><label class="field-label" for="link-email">Their email (optional)</label><input id="link-email" name="email" type="email" maxlength="254" placeholder="Anyone with the link"></div><div class="field"><label class="field-label" for="link-label">Label (optional)</label><input id="link-label" name="label" maxlength="100" placeholder="e.g. Alex or Living room tablet"></div></div>
              <div class="field-row"><div class="field"><label class="field-label" for="link-role">Access</label><select id="link-role" name="role"><option value="guest">Guest — signs in and joins</option><option value="display">Page-only — page files, no sign-in</option></select></div><div class="field"><label class="field-label" for="link-expiry">Expires</label><select id="link-expiry" name="expires_in"><option value="604800">In 7 days</option><option value="86400">In 24 hours</option><option value="2592000">In 30 days</option><option value="">Never</option></select></div></div>
              <div class="actions"><button>${icon('link')} Create share link</button></div>
            </form>${linkResult}</div>
          <div class="tab-panel" id="panel-agent"><h3${c('pageManage.add.agentTitle', pm.add.agentTitle)}>${txt(pm.add.agentTitle)}</h3><p class="muted" style="font-size:.9rem"${c('pageManage.add.agentLead', pm.add.agentLead)}>${txt(pm.add.agentLead)}</p>
            ${view.accountAgents.length ? `<form action="${actionURL}" method="post"><input type="hidden" name="action" value="agent-access"><div class="check-list">${agentChecks}</div><div class="actions"><button>${icon('bot')} Save agent access</button></div></form>` : `<p class="empty">No agents in your account yet. <a href="${text(view.publicBase + '/dashboard#agents')}">Add an agent</a> from your dashboard.</p>`}</div>
        </div>
      </div>
    </section>`;

  const publicHref = view.bareUrl || view.ownerUrl;
  const publicAccessCard = view.owner && view.openReaders
    ? `<section class="card" aria-labelledby="public-access-title">
      <div class="card-head"><div><span class="eyebrow">${icon('link')} Public access (zero-OAuth)</span><h2 id="public-access-title">${view.openWriters ? 'Public · Open contributions' : 'Public · Read-only'}</h2><p>${view.openWriters
        ? 'Anyone with this URL can view and submit signed entries to this unencrypted Chronolog log without signing in.'
        : 'Anyone with this URL can view this page and sync its unencrypted public Chronolog log without signing in. Only authorized writers and admins can publish changes.'}</p></div><span class="badge ${view.openWriters ? 'warn' : 'ok'}">${view.openWriters ? 'Public write' : 'Public read'}</span></div>
      ${view.openWriters
        ? '<p class="notice warn"><span><strong>Security notice:</strong> Anyone with this link can submit signed entries to an unencrypted public log without signing in. Never store private secrets here; use <code>chronolog/rls</code> write rules or switch to read-only via <code>tendril permissions set-open</code>.</span></p>'
        : '<p class="notice"><span><strong>Privacy notice:</strong> Data on this public page is unencrypted so anonymous browsers can sync it peer-to-peer without signing in. Management, Hosted MCP, and OAuth connections remain strictly owner-only.</span></p>'}
      <div class="stack-sm" style="margin-top:.75rem">
        ${copyField(publicHref, 'Public page URL (no sign-in required for visitors)', 'public-page-link')}
        ${copyField(`<iframe src="${publicHref}" title="${view.rawName}" style="width:100%;min-height:480px;border:0" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`, 'Embed snippet (optional)', 'public-embed-code')}
      </div>
    </section>`
    : '';

  const pageDomain = view.pageBaseDomain || 'tendriller.dev';
  const currentBareUrl = view.bareUrl || view.ownerUrl;
  const subQuotaText = view.subdomainLimit === null || view.subdomainLimit === undefined
    ? (view.subdomainAllowed ? 'Unlimited' : 'Pro & Team')
    : `${view.subdomainUsed ?? 0} / ${view.subdomainLimit}`;
  const addressCard = view.owner
    ? `<section class="card" id="address" aria-labelledby="address-title">
      <div class="card-head"><div><span class="eyebrow">${icon('link')} Page address</span><h2 id="address-title">Named subdomain</h2><p>${view.subdomainAllowed
        ? `Replace the generated subdomain with a memorable unique name under <code>.${text(pageDomain)}</code>. The generated address keeps working as a fallback.`
        : `Upgrade to Pro or Team to replace the generated subdomain with a unique name like <code>my-app.${text(pageDomain)}</code>.`}</p></div><span class="badge ${view.subdomain ? (view.subdomainAllowed ? 'ok' : 'warn') : ''}">${view.subdomain ? (view.subdomainAllowed ? `${text(view.subdomain)}.${text(pageDomain)}` : 'Paused') : text(subQuotaText)}</span></div>
      <div class="stack-sm">
        ${copyField(currentBareUrl, 'Direct page URL (signed-in owners & public pages)', 'bare-page-link')}
        ${view.subdomain && view.fallbackBareUrl ? `<p class="fine">Fallback address: <code>${text(view.fallbackBareUrl)}</code></p>` : ''}
        ${view.subdomainAllowed
          ? `<form action="${actionURL}" method="post" class="stack-sm">
              <input type="hidden" name="action" value="set-subdomain">
              <div class="field">
                <label class="field-label" for="page-subdomain">Unique subdomain name</label>
                <input id="page-subdomain" name="subdomain" type="text" value="${text(view.subdomain ?? '')}" minlength="3" maxlength="45" pattern="[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])" placeholder="e.g. my-app" autocomplete="off">
                <span class="field-hint">3–45 lowercase letters, numbers, or single hyphens. Served at <code>https://&lt;name&gt;.${text(pageDomain)}/</code> (${text(subQuotaText)} slots).</span>
              </div>
              <div class="actions tight">
                <button class="sm" type="submit">${icon('link')} ${view.subdomain ? 'Update subdomain' : 'Set subdomain'}</button>
              </div>
            </form>
            ${view.subdomain ? `<form action="${actionURL}" method="post" class="inline-form"><input type="hidden" name="action" value="set-subdomain"><input type="hidden" name="subdomain" value=""><button class="danger sm" type="submit">Remove named subdomain</button></form>` : ''}`
          : `<div class="actions tight"><a class="button sm" href="${text(view.publicBase + '/dashboard/billing')}">${icon('sparkles')} Upgrade to Pro — $12/mo</a><a class="button secondary sm" href="${text(view.publicBase + '/dashboard/domains')}">Manage domains</a>${view.subdomain ? `<form action="${actionURL}" method="post" class="inline-form"><input type="hidden" name="action" value="set-subdomain"><input type="hidden" name="subdomain" value=""><button class="danger sm" type="submit">Remove paused subdomain</button></form>` : ''}</div>`}
      </div>
    </section>`
    : '';

  const ownerSections = `<div class="stack">
    ${publicAccessCard}
    ${addressCard}
    ${addPanel}
    <section class="card">
      <div class="card-head"><div><h2${c('pageManage.share.title', pm.share.title)}>${txt(pm.share.title)}</h2><p${c('pageManage.share.lead', pm.share.lead)}>${txt(pm.share.lead)}</p></div>${view.shareLinks.length ? `<span class="badge">${view.shareLinks.length} retained</span>` : ''}</div>
      ${view.pendingGuests ? `<p class="notice warn">${view.pendingGuests} guest ${view.pendingGuests === 1 ? 'request is' : 'requests are'} waiting for your approval.</p>` : ''}
      ${shareRows ? `<ul class="list">${shareRows}</ul>` : `<p class="empty"${c('pageManage.share.empty', pm.share.empty)}>${txt(pm.share.empty)}</p>`}
    </section>
    <section class="card">
      <div class="card-head"><div><h2${c('pageManage.agents.title', pm.agents.title)}>${txt(pm.agents.title)}</h2><p${c('pageManage.agents.lead', pm.agents.lead)}>${txt(pm.agents.lead)}</p></div>${view.rosterAgents.length ? `<span class="badge ok">${view.rosterAgents.length} with access</span>` : ''}</div>
      ${agentRows ? `<ul class="list">${agentRows}</ul>${primaryRadios}` : `<p class="empty"${c('pageManage.agents.empty', pm.agents.empty)}>${txt(pm.agents.empty)}</p>`}
    </section>
    <section class="card">
      <div class="card-head"><div><h2${c('pageManage.publications.title', pm.publications.title)}>${txt(pm.publications.title)}</h2><p${c('pageManage.publications.lead', pm.publications.lead)}>${txt(pm.publications.lead)}</p></div>${view.currentVersion ? `<span class="badge">v${text(view.currentVersion)}</span>` : ''}</div>
      ${versionsHtml ? `<ol class="list">${versionsHtml}</ol>` : `<p class="empty"${c('pageManage.publications.empty', pm.publications.empty)}>${txt(pm.publications.empty)}</p>`}
      <p class="fine" style="margin-top:.6rem">The host retains a rolling 3-version R2 cache; older signed <code>$publications</code> releases remain verifiable and recoverable from connected Chronolog peers by SHA-256 hash.</p>
    </section>
    <details class="disclosure danger"><summary><span${c('pageManage.delete.summary', pm.delete.summary)}>${txt(pm.delete.summary)}</span></summary><div class="disclosure-body">
      <p class="muted"><span${c('pageManage.delete.body', pm.delete.body)}>${txt(pm.delete.body)}</span>${view.lifetime === 'resident' ? ' This frees one of your resident page slots.' : ''}</p>
      <form action="${actionURL}" method="post"><input type="hidden" name="action" value="delete-page"><div class="field"><label class="field-label" for="delete-page-confirm">Type DELETE to confirm</label><input id="delete-page-confirm" name="confirm" required autocomplete="off"></div><div class="actions"><button class="danger">Delete page permanently</button></div></form>
    </div></details>
  </div>`;

  const facts = view.owner ? `<div class="page-meta"><span>${icon('layers')} ${view.currentVersion ? `Version ${text(view.currentVersion)}` : 'Not published yet'}</span><span>${icon('bot')} ${view.rosterAgents.length} ${view.rosterAgents.length === 1 ? 'agent' : 'agents'}</span><span>${icon('link')} ${view.shareLinks.length} ${view.shareLinks.length === 1 ? 'link' : 'links'}</span></div>` : '';
  return renderShell({
    title: 'Manage page',
    brand: brandMark(brandPrefix, view.base),
    brandBase: brandPrefix,
    nav: `<nav>${view.owner ? `<a class="nav-link" href="#add">${icon('user-plus')} Add people</a>` : ''}<a class="nav-link" href="${text(view.base)}">Return to page</a></nav>`,
    themeToggle: editable,
    body: `<div class="page-head"><div class="page-head-row"><div style="display:flex;gap:.9rem;align-items:center">${avatar(view.rawName, view.tid)}<div><span class="eyebrow"${c('pageManage.eyebrow', pm.eyebrow)}>${txt(pm.eyebrow)}</span><h1 style="margin:0">${pageName}</h1>${facts}</div></div><span class="badge${view.owner ? ' ok' : ''}">${text(view.role)} access</span></div></div>${view.message ? `<p class="notice" role="status">${icon('check')}<span>${text(view.message)}</span></p>` : ''}${view.owner ? ownerSections : `<section class="card"><p${c('pageManage.nonOwnerNotice', pm.nonOwnerNotice)}>${txt(pm.nonOwnerNotice)}</p></section>`}`,
    footer: `<span>Tendriller</span><span class="foot-links"><a href="${text(view.publicBase + '/dashboard')}">Account dashboard</a><a href="${text(view.base + '_tendril/report')}">Report this page</a></span>`,
  });
}

const text = (value: unknown) => escapeHtml(String(value ?? ''));

/** Service-owned page management works even when the authored page cannot execute. */
export async function handleManagement(t: Tendril, req: Request, base: string, principal: PagePrincipal): Promise<Response> {
  const owner = principal.role === 'owner' && !!principal.accountId;
  let message = '';
  let tab: 'device' | 'person' | 'agent' = 'device';
  let createdLink: { url: string; role: string; email: string | null } | null = null;
  const accountAgents: AccountAgent[] = owner ? await listAccountAgents(t.env, principal.accountId!) : [];
  if (req.method === 'POST') {
    if (!owner) throw new HttpError(403, 'forbidden', 'Only the signed-in owner can manage this page');
    if (!(req.headers.get('Content-Type') ?? '').startsWith('application/x-www-form-urlencoded'))
      throw new HttpError(415, 'unsupported_media_type', 'Expected a management form');
    const binding = hostApprovalBinding(t, principal.accountId!);
    const commit = async (write: () => void) => {
      await requireHostApprovalPolicy(t, binding);
      t.transaction(() => {
        requireHostApprovalBinding(t, binding);
        if (!currentPrincipal(t, principal, req.headers.get('x-tendril-key') || undefined))
          throw new HttpError(401, 'unauthorized', 'The owner session changed. Sign in and review this action again.');
        write();
      });
    };
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
    const action = form.get('action');
    if (action === 'agent-access') {
      // One checkbox per account agent; `known` names every box the owner saw.
      const known = new Set(form.getAll('known')), checked = new Set(form.getAll('agent'));
      let granted = 0, removed = 0;
      for (const agent of accountAgents) {
        if (!known.has(agent.id)) continue;
        const has = !!localAgentGrant(t, agent.id);
        if (checked.has(agent.id) && !has) {
          await commit(() => {});
          await putAgentGrant(t, principal.accountId!, agent.id, agent.handle, agent.bio, agent.public_key, agent.wrap_key, [...AGENT_SCOPES]); granted++;
        } else if (!checked.has(agent.id) && has) {
          await commit(() => {});
          await deleteAgentGrant(t, agent.id, `owner:${principal.accountId}`); removed++;
        }
      }
      tab = 'agent';
      message = granted || removed ? `Agent access saved: ${granted} granted, ${removed} removed.` : 'Agent access unchanged.';
    } else if (action === 'set-primary-agent') {
      const target = (form.get('agent_id') ?? '').trim() || null;
      await commit(() => {
        setPrimaryAgent(t, target, `owner:${principal.accountId}`);
      });
      tab = 'agent';
      message = target ? 'Primary agent updated.' : 'Primary agent cleared.';
    } else if (action === 'remove-agent') {
      const agentId = form.get('agent') ?? '';
      await commit(() => { if (!localAgentGrant(t, agentId)) throw new HttpError(404, 'not_found', 'This agent has no access to this page'); });
      await deleteAgentGrant(t, agentId, `owner:${principal.accountId}`);
      message = 'Agent access removed. Its open connections to this page were closed.';
    } else if (action === 'delete-page') {
      if ((form.get('confirm') ?? '').trim() !== 'DELETE') throw new HttpError(400, 'confirmation_required', 'Type DELETE to confirm deleting this page.');
      await commit(() => {});
      const dashboardUrl = text(t.env.PUBLIC_BASE + '/dashboard?deleted=1');
      await cleanupPageCustomDomain(t.env, t.tid);
      await t.destroy();
      const deletedHtml = renderPageDeletedHtml({ base, dashboardUrl });
      return new Response(deletedHtml,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
    } else if (action === 'create-link') {
      const role = form.get('role');
      if (role !== 'guest' && role !== 'display') throw new HttpError(400, 'bad_request', 'Choose a guest invite or page-only link');
      const label = (form.get('label') ?? '').trim().slice(0, 100) || null;
      const email = validOptionalEmail(form.get('email'));
      if (email !== null && role !== 'guest') throw new HttpError(400, 'bad_request', 'Email restriction is only supported on guest invite links');
      const rawExpiry = form.get('expires_in')?.trim() ?? '';
      const expiresIn = rawExpiry ? Number(rawExpiry) : null;
      if (expiresIn !== null && (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 365 * 86400))
        throw new HttpError(400, 'bad_request', 'Invalid expiry');
      await requireHostApprovalPolicy(t, binding);
      const created = await t.createLink(role, label, expiresIn, false, () => {
        requireHostApprovalBinding(t, binding);
        if (!currentPrincipal(t, principal, req.headers.get('x-tendril-key') || undefined))
          throw new HttpError(401, 'unauthorized', 'The owner session changed. Sign in and review this action again.');
        const total = t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM links')?.n ?? 0;
        if (total >= 50) throw new HttpError(429, 'link_limit', 'At most 50 links are allowed per page');
      }, email);
      const createdUrl = t.renderLink(created).url;
      addActivity(t, { kind: 'link', summary: `Created ${role} link${label ? ` (${label})` : ''}${email ? ` for ${email}` : ''}`, by: `owner:${principal.accountId}` });
      message = `${role === 'guest' ? 'Guest invite' : 'Page-only'} link created${email ? ` for ${email}` : ''}: ${createdUrl}`;
      createdLink = { url: createdUrl, role, email };
      tab = 'person';
    } else if (action === 'revoke-link') {
      const id = form.get('link_id') ?? '';
      if (!id || id === 'l_main') throw new HttpError(400, 'cannot_delete', 'The main owner link cannot be revoked here');
      await commit(() => {
        const existing = t.db.one<{ role: string; label: string | null }>('SELECT role, label FROM links WHERE id=?', id);
        if (!existing) throw new HttpError(404, 'not_found', 'No such link');
        t.db.run('DELETE FROM links WHERE id=?', id);
        t.db.del(`link_email:${id}`);
        t.db.run('DELETE FROM guest_accounts WHERE link_id=?', id);
        t.closeLinkSockets(id);
        addActivity(t, { kind: 'link', summary: `Revoked ${existing.role} link${existing.label ? ` (${existing.label})` : ''}`, by: `owner:${principal.accountId}` });
      });
      message = 'Share link revoked.';
    } else if (action === 'set-subdomain') {
      const rawSub = (form.get('subdomain') ?? '').trim();
      const reassign = form.get('reassign') === '1' || form.get('reassign') === 'true';
      const swap = form.get('swap') === '1' || form.get('swap') === 'true';
      await commit(() => {});
      const updated = await setPageSubdomain(t.env, principal.accountId!, t.tid, rawSub || null, `owner:${principal.accountId}`, { reassign, swap });
      message = !updated.subdomain
        ? 'Named subdomain removed. Your page remains accessible at its generated address.'
        : updated.swapped_subdomain
          ? `Swapped subdomains with page ${updated.previous_tendril_id}: this page is now at ${updated.bare_url}.`
          : updated.previous_tendril_id
            ? `Moved subdomain from page ${updated.previous_tendril_id} to ${updated.bare_url} (both pages remain reachable at their generated addresses).`
            : `Named subdomain set to ${updated.bare_url} (the original address keeps working as a fallback).`;
    } else if (action === 'approve-guest' || action === 'decline-guest') {
      const account = form.get('account') ?? '', link = form.get('link') ?? '';
      await commit(() => {
        if (!t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND link_id=? AND approved=0', account, link))
          throw new HttpError(404, 'not_found', 'This guest request is no longer pending');
        t.db.run('UPDATE guest_accounts SET approved=? WHERE account_id=? AND link_id=?', action === 'approve-guest' ? 1 : -1, account, link);
      });
      message = action === 'approve-guest' ? 'Guest access approved.' : 'Guest access declined.';
    } else throw new HttpError(400, 'bad_request', 'Unknown management action');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');

  const current = pointers(t).current ?? 0;
  const rawName = t.db.get('name', 'Tendril');
  const roster = owner ? pageAgents(t) : { primary_agent_id: null, agents: [] };
  const rosterAgents = roster.agents.map(entry => {
    const grant = entry.kind === 'workspace' ? localAgentGrant(t, entry.id) : null;
    const origin = entry.kind === 'hosted-mcp'
      ? 'Hosted MCP participant'
      : grant?.granted_by === 'creator'
        ? 'Created this page'
        : `Granted ${new Date(entry.granted_at).toISOString().slice(0, 10)}`;
    return {
      id: entry.id,
      handle: entry.handle,
      bio: entry.bio ?? null,
      kind: entry.kind,
      is_primary: entry.is_primary,
      origin,
    };
  });
  const shareLinks = owner ? t.listLinks().filter(link => link.role !== 'owner') : [];
  const versions = owner ? listVersions(t).map(v => ({ version: Number(v.version), message: v.message == null ? null : String(v.message) })) : [];
  const pendingGuests = owner ? t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM guest_accounts WHERE approved = 0')?.n ?? 0 : 0;
  const ownerUrl = owner ? t.mainPageUrl() : '';
  const [ent, subRow, subCountRow] = owner && principal.accountId
    ? await Promise.all([
        getAccountEntitlements(t.env, principal.accountId).catch(() => null),
        getPageSubdomain(t.env, t.tid),
        t.env.ACCOUNTS?.prepare('SELECT COUNT(*) AS n FROM page_subdomains WHERE account_id = ?').bind(principal.accountId).first<{ n: number }>().catch(() => null) ?? Promise.resolve(null),
      ])
    : [null, null, null];
  const subdomain = subRow?.subdomain ?? t.activeSubdomain();
  const subdomainAllowed = Boolean(ent && subdomainPlanAllowed(ent));
  const bareUrl = owner ? (subdomainAllowed ? t.barePageUrl() : t.barePageUrl({ fallback: true })) : '';
  const fallbackBareUrl = owner ? t.barePageUrl({ fallback: true }) : '';
  const html = renderPageManagementHtml({
    tid: t.tid,
    rawName,
    base,
    publicBase: t.env.PUBLIC_BASE,
    owner,
    role: principal.role,
    ownerUrl,
    currentVersion: current,
    lifetime: t.db.get<string>('lifetime', 'ad_hoc'),
    tab,
    message,
    createdLink,
    pendingGuests,
    primaryAgentId: roster.primary_agent_id,
    rosterAgents,
    accountAgents: accountAgents.map(a => ({
      id: a.id,
      handle: a.handle,
      bio: a.bio ?? null,
      grants: a.grants,
      checked: Boolean(localAgentGrant(t, a.id)),
    })),
    shareLinks,
    versions,
    openReaders: t.db.get<boolean>('v2_open_readers', false),
    openWriters: t.db.get<boolean>('v2_open_writers', false),
    subdomain,
    bareUrl,
    fallbackBareUrl,
    pageBaseDomain: t.env.PAGE_BASE_DOMAIN || 'tendriller.dev',
    subdomainAllowed,
    subdomainUsed: subCountRow?.n ?? 0,
    subdomainLimit: ent ? (ent.unlimitedHost ? null : ent.quotas.customSubdomains) : 0,
    now: t.now(),
  });
  return new Response(req.method === 'HEAD' ? null : html, { headers: {
    // Keep Origin on same-origin navigation POSTs for the management forms.
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
