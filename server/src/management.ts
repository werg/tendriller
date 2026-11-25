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
import { hostApprovalBinding, requireHostApprovalBinding, requireHostApprovalPolicy } from './owner-review';
import { listAccountAgents, type AccountAgent } from './agents';
import { deleteAgentGrant, mirroredAgents, pageAgents, putAgentGrant, setPrimaryAgent } from './agent-grants';

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
        if (!currentPrincipal(t, principal, req.headers.get('x-tendril-key') ?? undefined))
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
      await t.destroy();
      const deletedHtml = renderShell({
        title: 'Page deleted',
        brand: brandMark(base + '_tendril/brand/', dashboardUrl),
        brandBase: base + '_tendril/brand/',
        nav: `<a class="nav-link" href="${dashboardUrl}">Dashboard</a>`,
        footer: '',
        body: `<section class="card"><span class="eyebrow">Deleted</span><h1>This page was deleted</h1><p class="lead">Its files, invite links and agent credentials were removed.</p><div class="actions"><a class="button" href="${dashboardUrl}">Back to dashboard</a></div></section>`,
      });
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
        if (!currentPrincipal(t, principal, req.headers.get('x-tendril-key') ?? undefined))
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

  const actionURL = text(`${base}_tendril/manage`), current = pointers(t).current ?? 0;
  const rawName = t.db.get('name', 'Tendril'), pageName = text(rawName);
  const brandPrefix = `${base}_tendril/brand/`;
  const qr = (value: string, caption: string, size = 176) => {
    try { return `<div class="qr-frame">${renderQrSvg(value, { sizePx: size, label: caption })}<span>${text(caption)}</span></div>`; }
    catch { return '<p class="fine">This link is too long for a QR code. Copy it instead.</p>'; }
  };
  const copyField = (value: string, label: string, id: string) =>
    `<div class="copy-box"><label class="field-label" for="${id}">${text(label)}</label><input id="${id}" type="text" readonly value="${text(value)}"></div>`;
  const roster = owner ? pageAgents(t) : { primary_agent_id: null, agents: [] };
  const granted = owner ? mirroredAgents(t).map(id => ({ id, grant: localAgentGrant(t, id)! })) : [];
  const agentRows = roster.agents.map(entry => {
    const grant = entry.kind === 'workspace' ? localAgentGrant(t, entry.id) : null;
    const origin = entry.kind === 'hosted-mcp'
      ? 'Hosted MCP participant'
      : grant?.granted_by === 'creator'
        ? 'Created this page'
        : `Granted ${new Date(entry.granted_at).toISOString().slice(0, 10)}`;
    const primaryBadge = entry.is_primary ? ' <span class="badge ok">Primary</span>' : '';
    const bioLine = entry.bio ? `${text(entry.bio)} · ` : '';
    const removeForm = entry.kind === 'workspace'
      ? `<form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="remove-agent"><input type="hidden" name="agent" value="${text(entry.id)}"><button class="sm danger">Remove access</button></form>`
      : `<a class="button sm secondary" href="${text(t.env.PUBLIC_BASE + '/connections')}">Manage MCP</a>`;
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${icon('bot')} @${text(entry.handle)}${primaryBadge}</div><p class="list-item-sub">${bioLine}${text(origin)}</p></div>${removeForm}</li>`;
  }).join('');
  const primaryRadios = roster.agents.length
    ? `<form action="${actionURL}" method="post" style="margin-top:.85rem"><input type="hidden" name="action" value="set-primary-agent"><div class="field"><label class="field-label" for="primary-agent-select">Primary agent (answers general messages)</label><select id="primary-agent-select" name="agent_id"><option value=""${roster.primary_agent_id === null ? ' selected' : ''}>None (only direct @mentions)</option>${roster.agents.map(entry => `<option value="${text(entry.id)}"${entry.is_primary ? ' selected' : ''}>@${text(entry.handle)}${entry.kind === 'hosted-mcp' ? ' (Hosted MCP)' : ''}</option>`).join('')}</select></div><div class="actions"><button class="secondary sm" type="submit">Save primary agent</button></div></form>`
    : '';
  const agentChecks = accountAgents.map(agent =>
    `<label class="check-item"><input type="hidden" name="known" value="${text(agent.id)}"><input type="checkbox" name="agent" value="${text(agent.id)}"${localAgentGrant(t, agent.id) ? ' checked' : ''}><span class="check-copy"><span class="check-title">${icon('bot')} @${text(agent.handle)}</span><span class="check-desc">${agent.bio ? `${text(agent.bio)} · ` : ''}${agent.grants} ${agent.grants === 1 ? 'page' : 'pages'} granted</span></span></label>`,
  ).join('');
  const agents = roster.agents;
  const shareLinks = owner ? t.listLinks().filter(link => link.role !== 'owner') : [];
  const shareRows = shareLinks.map(link => {
    const roleLabel = link.role === 'guest' ? 'Guest invite' : 'Page-only';
    const roleClass = link.role === 'guest' ? 'ok' : '';
    const emailBadge = link.email ? ` <span class="badge">${text(link.email)}</span>` : '';
    const expired = link.expires_at !== null && link.expires_at <= t.now();
    const expiry = expired ? 'Expired' : link.expires_at ? `Expires ${new Date(link.expires_at).toLocaleDateString()}` : 'No expiry';
    const qrHtml = expired ? '' : `<details class="disclosure" style="margin-top:.55rem"><summary>${icon('qr')} QR code for nearby devices</summary><div class="disclosure-body" style="display:flex;justify-content:center">${qr(link.url, `Scan to open this ${roleLabel.toLowerCase()} link`, 168)}</div></details>`;
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${icon(link.role === 'guest' ? 'user-plus' : 'link')} ${text(link.label || roleLabel)} <span class="badge ${roleClass}">${roleLabel}</span>${emailBadge}</div><p class="list-item-sub"><code>${text(link.url)}</code><br>${text(expiry)}</p>${qrHtml}</div><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="revoke-link"><input type="hidden" name="link_id" value="${text(link.id)}"><button class="sm danger">Revoke</button></form></li>`;
  }).join('');
  const versions = owner ? listVersions(t).map(version =>
    `<li class="list-item"><div class="list-item-main"><div class="list-item-title">Version ${text(version.version)}${version.version === current ? ' <span class="badge ok">Current</span>' : ''}</div>${version.message ? `<p class="list-item-sub">${text(version.message)}</p>` : ''}</div></li>`,
  ).join('') : '';
  const pendingGuests = owner ? t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM guest_accounts WHERE approved = 0')?.n ?? 0 : 0;
  const ownerUrl = owner ? t.mainPageUrl() : '';
  const checked = (name: typeof tab) => tab === name ? ' checked' : '';

  const linkResult = createdLink ? `<div class="result" role="status"><h3>${icon('check')} ${createdLink.role === 'guest' ? 'Invite link ready' : 'Page-only link ready'}</h3><p class="fine">${createdLink.role === 'guest' ? `Send this to ${createdLink.email ? text(createdLink.email) : 'the person you are inviting'}, or let them scan the code. They sign in with GitHub or Google to join.` : 'Anyone with this link can open the page files without signing in.'}</p><div class="split"><div class="stack-sm">${copyField(createdLink.url, 'Invite link', 'created-link')}</div>${qr(createdLink.url, 'Scan to join')}</div></div>` : '';

  const addPanel = `<section class="card" id="add" aria-labelledby="add-title">
      <div class="card-head"><div><span class="eyebrow">${icon('sparkles')} Grow this page</span><h2 id="add-title">Add people &amp; devices</h2><p>Open this page on another device, invite someone, or give one of your agents access.</p></div></div>
      <div class="tabs">
        <input class="tab-input" type="radio" name="add-tab" id="tab-device" aria-controls="panel-device"${checked('device')}>
        <input class="tab-input" type="radio" name="add-tab" id="tab-person" aria-controls="panel-person"${checked('person')}>
        <input class="tab-input" type="radio" name="add-tab" id="tab-agent" aria-controls="panel-agent"${checked('agent')}>
        <div class="tab-list"><label for="tab-device">${icon('phone')} My device</label><label for="tab-person">${icon('user-plus')} A person</label><label for="tab-agent">${icon('bot')} An agent</label></div>
        <div class="tab-panels">
          <div class="tab-panel" id="panel-device"><div class="split"><div><h3>Open on your phone or another computer</h3><ol class="steps"><li>Scan the code with the other device’s camera, or copy the link to it.</li><li>Sign in with the same GitHub or Google account you use here.</li><li>The page opens with your owner access. Your app may ask to enroll the new device.</li></ol>${copyField(ownerUrl, 'Your page link (keep it private)', 'owner-link')}</div>${qr(ownerUrl, 'Scan with your other device')}</div></div>
          <div class="tab-panel" id="panel-person"><h3>Invite someone to join</h3><p class="muted" style="font-size:.9rem">They sign in with GitHub or Google. Optionally lock the invite to their email address.</p>
            <form action="${actionURL}" method="post">
              <input type="hidden" name="action" value="create-link">
              <div class="field-row"><div class="field"><label class="field-label" for="link-email">Their email (optional)</label><input id="link-email" name="email" type="email" maxlength="254" placeholder="Anyone with the link"></div><div class="field"><label class="field-label" for="link-label">Label (optional)</label><input id="link-label" name="label" maxlength="100" placeholder="e.g. Alex or Living room tablet"></div></div>
              <div class="field-row"><div class="field"><label class="field-label" for="link-role">Access</label><select id="link-role" name="role"><option value="guest">Guest — signs in and joins</option><option value="display">Page-only — page files, no sign-in</option></select></div><div class="field"><label class="field-label" for="link-expiry">Expires</label><select id="link-expiry" name="expires_in"><option value="604800">In 7 days</option><option value="86400">In 24 hours</option><option value="2592000">In 30 days</option><option value="">Never</option></select></div></div>
              <div class="actions"><button>${icon('link')} Create share link</button></div>
            </form>${linkResult}</div>
          <div class="tab-panel" id="panel-agent"><h3>Give an agent access</h3><p class="muted" style="font-size:.9rem">Agents belong to your account and maintain any page you check here. Add new agents from your <a href="${text(t.env.PUBLIC_BASE + '/dashboard#agents')}">dashboard</a>.</p>
            ${accountAgents.length ? `<form action="${actionURL}" method="post"><input type="hidden" name="action" value="agent-access"><div class="check-list">${agentChecks}</div><div class="actions"><button>${icon('bot')} Save agent access</button></div></form>` : `<p class="empty">No agents in your account yet. <a href="${text(t.env.PUBLIC_BASE + '/dashboard#agents')}">Add an agent</a> from your dashboard.</p>`}</div>
        </div>
      </div>
    </section>`;

  const ownerSections = `<div class="stack">
    ${addPanel}
    <section class="card">
      <div class="card-head"><div><h2>Share &amp; invite</h2><p>Anyone with a guest invite link can sign in and join directly — optionally restrict a link to a specific email address. Page-only links (up to 3) open page files without sign-in or private data access.</p></div>${shareLinks.length ? `<span class="badge">${shareLinks.length} retained</span>` : ''}</div>
      ${pendingGuests ? `<p class="notice warn">${pendingGuests} guest ${pendingGuests === 1 ? 'request is' : 'requests are'} waiting for your approval.</p>` : ''}
      ${shareRows ? `<ul class="list">${shareRows}</ul>` : '<p class="empty">No active invite or page-only links yet. Create one under <a href="#add">Add people &amp; devices</a>.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Agents with access</h2><p>Each agent uses its own account-level credential or hosted MCP grant. Removing access closes its connections to this page; Chronolog signing grants are managed separately.</p></div>${agents.length ? `<span class="badge ok">${agents.length} with access</span>` : ''}</div>
      ${agentRows ? `<ul class="list">${agentRows}</ul>${primaryRadios}` : '<p class="empty">No agents have access to this page.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Publications</h2><p>Restoring earlier code requires a new signed Chronolog publication.</p></div>${current ? `<span class="badge">v${text(current)}</span>` : ''}</div>
      ${versions ? `<ol class="list">${versions}</ol>` : '<p class="empty">No version has been published yet.</p>'}
    </section>
    <details class="disclosure danger"><summary>Delete this page</summary><div class="disclosure-body">
      <p class="muted">Permanently deletes this page, its published files, invite links and agent credentials. People, devices and agents lose access immediately.${t.db.get<string>('lifetime', 'ad_hoc') === 'resident' ? ' This frees one of your resident page slots.' : ''}</p>
      <form action="${actionURL}" method="post"><input type="hidden" name="action" value="delete-page"><div class="field"><label class="field-label" for="delete-page-confirm">Type DELETE to confirm</label><input id="delete-page-confirm" name="confirm" required autocomplete="off"></div><div class="actions"><button class="danger">Delete page permanently</button></div></form>
    </div></details>
  </div>`;

  const facts = owner ? `<div class="page-meta"><span>${icon('layers')} ${current ? `Version ${text(current)}` : 'Not published yet'}</span><span>${icon('bot')} ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}</span><span>${icon('link')} ${shareLinks.length} ${shareLinks.length === 1 ? 'link' : 'links'}</span></div>` : '';
  const html = renderShell({
    title: 'Manage page',
    brand: brandMark(brandPrefix, base),
    brandBase: brandPrefix,
    nav: `<nav>${owner ? `<a class="nav-link" href="#add">${icon('user-plus')} Add people</a>` : ''}<a class="nav-link" href="${text(base)}">Return to page</a></nav>`,
    body: `<div class="page-head"><div class="page-head-row"><div style="display:flex;gap:.9rem;align-items:center">${avatar(rawName, t.tid)}<div><span class="eyebrow">Page settings</span><h1 style="margin:0">${pageName}</h1>${facts}</div></div><span class="badge${owner ? ' ok' : ''}">${text(principal.role)} access</span></div></div>${message ? `<p class="notice" role="status">${icon('check')}<span>${text(message)}</span></p>` : ''}${owner ? ownerSections : '<section class="card"><p>Only the signed-in owner can manage agent connections, guest access, and publications.</p></section>'}`,
    footer: `<span>Tendriller</span><span class="foot-links"><a href="${text(t.env.PUBLIC_BASE + '/dashboard')}">Account dashboard</a><a href="${text(base + '_tendril/report')}">Report this page</a></span>`,
  });
  return new Response(req.method === 'HEAD' ? null : html, { headers: {
    // Keep Origin on same-origin navigation POSTs for the management forms.
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
