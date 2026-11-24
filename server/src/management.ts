import type { Tendril } from './tendril';
import { validOptionalEmail } from './tendril';
import type { PagePrincipal } from './access';
import { agentScopes, currentPrincipal } from './access';
import { addActivity } from './activity';
import { brandHead, brandMark, brandStyle } from './brand';
import { renderQrSvg } from './qr';
import { listVersions, pointers } from './files';
import { escapeHtml } from './inject';
import { HttpError, readBody } from './http';
import { sha256Hex, sixDigits } from './ids';
import { ADOPT_CODE_TTL } from './limits';
import { avatar, icon, serviceStyle } from './accounts/ui';
import { AGENT_SCOPE_ITEMS, agentInviteResponse, issueAgentInvite } from './sharing';
import { hostApprovalBinding, requireHostApprovalBinding, requireHostApprovalPolicy, type HostApproval } from './host-adoption';

const text = (value: unknown) => escapeHtml(String(value ?? ''));

const SCOPE_ITEMS = AGENT_SCOPE_ITEMS;

/** Service-owned page management works even when the authored page cannot execute. */
export async function handleManagement(t: Tendril, req: Request, base: string, principal: PagePrincipal): Promise<Response> {
  const owner = principal.role === 'owner' && !!principal.accountId;
  let message = '';
  let tab: 'device' | 'person' | 'agent' = 'device';
  let createdLink: { url: string; role: string; email: string | null } | null = null;
  let createdAgent: ReturnType<typeof agentInviteResponse> | null = null;
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
    if (action === 'delegate-agent') {
      const invite = await issueAgentInvite(t, principal.accountId!, form.get('name'), form.getAll('scopes'), () => {
        if (!currentPrincipal(t, principal, req.headers.get('x-tendril-key') ?? undefined))
          throw new HttpError(401, 'unauthorized', 'The owner session changed. Sign in and review this action again.');
      });
      createdAgent = agentInviteResponse(invite, t.db.get('name', 'Tendril'));
      tab = 'agent';
      message = `One-time code for ${invite.name}: ${invite.code} (expires in 10 minutes). Existing agents keep their access. Copy the invitation below and paste it to the new agent.`;
    } else if (action === 'delete-page') {
      if ((form.get('confirm') ?? '').trim() !== 'DELETE') throw new HttpError(400, 'confirmation_required', 'Type DELETE to confirm deleting this page.');
      await commit(() => {});
      const dashboardUrl = text(t.env.PUBLIC_BASE + '/dashboard?deleted=1');
      await t.destroy();
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page deleted · Tendriller</title>${serviceStyle}</head><body><main><section class="card" style="margin-top:2rem"><span class="eyebrow">Deleted</span><h1>This page was deleted</h1><p class="lead">Its files, invite links and agent credentials were removed.</p><div class="actions"><a class="button" href="${dashboardUrl}">Back to dashboard</a></div></section></main></body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
    } else if (action === 'connect-agent') {
      const code = `${t.tid}-${sixDigits()}`, expires = t.now() + ADOPT_CODE_TTL;
      const hash = await sha256Hex(code);
      await commit(() => {
        t.db.set('adopt', { ...binding, hash, expires_at: expires, attempts: 0 } satisfies HostApproval);
        addActivity(t, { kind: 'adopt_code', summary: 'The owner created an agent connection code', by: `owner:${principal.accountId}` });
      });
      message = `Recovery code: ${code} (expires in 10 minutes). Using it replaces all existing agent credentials.`;
    } else if (action === 'disconnect-agent') {
      const name = form.get('agent') ?? '';
      await commit(() => {
        if (!t.db.one('SELECT 1 FROM tokens WHERE name=?', name)) throw new HttpError(404, 'not_found', 'No such agent');
        t.db.run('DELETE FROM tokens WHERE name=?', name);
        t.db.del('agent_binding:' + name);
      });
      message = `Disconnected ${name}.`;
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
  const scopeChecks = SCOPE_ITEMS.map(item =>
    `<label class="check-item"><input type="checkbox" name="scopes" value="${item.value}"${item.defaultChecked ? ' checked' : ''}><span class="check-copy"><span class="check-title">${item.label}</span><span class="check-desc">${item.desc}</span></span></label>`,
  ).join('');
  const agents = owner ? t.db.all<{ name: string; last_used: number | null }>('SELECT name, last_used FROM tokens ORDER BY created_at') : [];
  const agentRows = agents.map(agent => {
    const binding = t.db.get<{ scopes?: string[] } | null>('agent_binding:' + agent.name, null);
    const scopeSummary = binding?.scopes?.length ? binding.scopes.join(', ') : 'Full host access';
    const used = agent.last_used ? `Last active ${new Date(agent.last_used).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Not used yet';
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${icon('bot')} ${text(agent.name)}</div><p class="list-item-sub">${text(scopeSummary)} · ${text(used)}</p></div><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="disconnect-agent"><input type="hidden" name="agent" value="${text(agent.name)}"><button class="sm danger">Disconnect</button></form></li>`;
  }).join('');
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
  const agentResult = createdAgent ? `<div class="result" role="status"><h3>${icon('check')} Invitation for “${text(createdAgent.name)}” is ready</h3><p class="fine">Paste one of these into the other agent’s chat or terminal. The code works once and expires at ${text(new Date(createdAgent.expires_at).toISOString().slice(11, 16))} UTC.</p><div class="stack-sm"><div class="copy-box"><label class="field-label" for="agent-blurb">Full invitation (includes the one-time code)</label><textarea id="agent-blurb" class="blurb-full" readonly rows="14">${text(createdAgent.blurb)}</textarea></div><div class="copy-box"><label class="field-label" for="agent-link">Or a short message with an instructions link</label><textarea id="agent-link" readonly rows="4">${text(createdAgent.link_blurb)}</textarea></div><p class="fine">One-time code: <code>${text(createdAgent.code)}</code></p></div></div>` : '';

  const addPanel = `<section class="card" id="add" aria-labelledby="add-title">
      <div class="card-head"><div><span class="eyebrow">${icon('sparkles')} Grow this page</span><h2 id="add-title">Add people &amp; devices</h2><p>Open this page on another device, invite someone, or connect another agent.</p></div></div>
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
          <div class="tab-panel" id="panel-agent"><h3>Connect another agent</h3><p class="muted" style="font-size:.9rem">You get a paste-ready invitation with a one-time code. Existing agents keep their access.</p>
            <form action="${actionURL}" method="post">
              <input type="hidden" name="action" value="delegate-agent">
              <div class="field"><label class="field-label" for="agent-name">Agent name</label><input id="agent-name" name="name" required maxlength="64" placeholder="e.g. reviewer or mobile-sync"><span class="field-hint">Letters, numbers, dots, dashes and underscores.</span></div>
              <details class="disclosure"><summary>Host permissions</summary><div class="disclosure-body"><div class="check-list">${scopeChecks}</div></div></details>
              <div class="actions"><button>${icon('bot')} Add agent</button></div>
            </form>${agentResult}</div>
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
      <div class="card-head"><div><h2>Connected agents</h2><p>Each connected agent uses its own revocable host credential. Chronolog signing grants are managed separately.</p></div>${agents.length ? `<span class="badge ok">${agents.length} connected</span>` : ''}</div>
      ${agentRows ? `<ul class="list">${agentRows}</ul>` : '<p class="empty">No agents connected.</p>'}
      <details class="disclosure danger"><summary>Replace all agent credentials for recovery</summary><div class="disclosure-body">
        <p class="muted">Creates a one-time recovery code. Redeeming it revokes every existing agent token above.</p>
        <form action="${actionURL}" method="post"><input type="hidden" name="action" value="connect-agent"><div class="actions"><button class="danger">Create replacing recovery code</button></div></form>
      </div></details>
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>Manage page · Tendriller</title>${brandHead(brandPrefix)}${serviceStyle}${brandStyle}</head><body><main><header>${brandMark(brandPrefix, base)}<nav>${owner ? `<a class="nav-link" href="#add">${icon('user-plus')} Add people</a>` : ''}<a class="nav-link" href="${text(base)}">Return to page</a></nav></header><div class="page-head"><div class="page-head-row"><div style="display:flex;gap:.9rem;align-items:center">${avatar(rawName, t.tid)}<div><span class="eyebrow">Page settings</span><h1 style="margin:0">${pageName}</h1>${facts}</div></div><span class="badge${owner ? ' ok' : ''}">${text(principal.role)} access</span></div></div>${message ? `<p class="notice" role="status">${icon('check')}<span>${text(message)}</span></p>` : ''}${owner ? ownerSections : '<section class="card"><p>Only the signed-in owner can manage agent connections, guest access, and publications.</p></section>'}<footer><a href="${text(t.env.PUBLIC_BASE + '/dashboard')}">Account dashboard</a><a href="${text(base + '_tendril/report')}">Report this page</a></footer></main></body></html>`;
  return new Response(req.method === 'HEAD' ? null : html, { headers: {
    // Keep Origin on same-origin navigation POSTs for the management forms.
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
