import type { Tendril } from './tendril';
import type { PagePrincipal } from './access';
import { agentScopes, currentPrincipal } from './access';
import { addActivity } from './activity';
import { brandHead, brandMark, brandStyle } from './brand';
import { listVersions, pointers } from './files';
import { escapeHtml } from './inject';
import { HttpError, readBody } from './http';
import { sha256Hex, sixDigits } from './ids';
import { ADOPT_CODE_TTL } from './limits';
import { serviceStyle } from './accounts/ui';
import { hostApprovalBinding, requireHostApprovalBinding, requireHostApprovalPolicy, type HostApproval } from './host-adoption';

const text = (value: unknown) => escapeHtml(String(value ?? ''));

const SCOPE_ITEMS: ReadonlyArray<{ value: string; label: string; desc: string; defaultChecked?: boolean }> = [
  { value: 'host:read', label: 'Read host status', desc: 'Inspect page info, publications and activity.', defaultChecked: true },
  { value: 'participants:connect', label: 'Connect enrolled participants', desc: 'Relay peer introductions for already-enrolled devices.', defaultChecked: true },
  { value: 'control:write', label: 'Update signed application control', desc: 'Stage and commit Chronolog control transitions.' },
  { value: 'publication:write', label: 'Publish signed code', desc: 'Upload and activate new signed page releases.' },
  { value: 'assistant:manage', label: 'Propose assistant access', desc: 'Advertise queries, commands and events for assistant review.' },
];

/** Service-owned page management works even when the authored page cannot execute. */
export async function handleManagement(t: Tendril, req: Request, base: string, principal: PagePrincipal): Promise<Response> {
  const owner = principal.role === 'owner' && !!principal.accountId;
  let message = '';
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
      const name = form.get('name')?.trim() ?? '';
      if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(name)) throw new HttpError(400, 'invalid_agent_name', 'Choose a short agent name.');
      if (name === 'setup') throw new HttpError(400, 'reserved_agent_name', 'Choose an agent name other than the fixed setup binding.');
      const selected = form.getAll('scopes'), scopes = agentScopes(selected.length ? selected : ['host:read', 'participants:connect']);
      const code = `${t.tid}-${sixDigits()}`, expires = t.now() + ADOPT_CODE_TTL;
      const hash = await sha256Hex(code);
      await commit(() => {
        if (t.db.one('SELECT 1 FROM tokens WHERE name=?', name)) throw new HttpError(409, 'agent_name_in_use');
        if ((t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM tokens')?.n ?? 0) >= 32) throw new HttpError(429, 'agent_binding_capacity');
        t.db.set('adopt', { ...binding, hash, expires_at: expires, attempts: 0, mode: 'delegate', name, scopes } satisfies HostApproval);
        addActivity(t, { kind: 'agent_delegation', summary: `The owner approved an additional scoped agent: ${name}`, by: `owner:${principal.accountId}` });
      });
      message = `One-time code for ${name}: ${code} (expires in 10 minutes). Existing agents keep their access.`;
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
      });
      const createdUrl = t.renderLink(created).url;
      addActivity(t, { kind: 'link', summary: `Created ${role} link${label ? ` (${label})` : ''}`, by: `owner:${principal.accountId}` });
      message = `${role === 'guest' ? 'Guest invite' : 'Page-only'} link created: ${createdUrl}`;
    } else if (action === 'revoke-link') {
      const id = form.get('link_id') ?? '';
      if (!id || id === 'l_main') throw new HttpError(400, 'cannot_delete', 'The main owner link cannot be revoked here');
      await commit(() => {
        const existing = t.db.one<{ role: string; label: string | null }>('SELECT role, label FROM links WHERE id=?', id);
        if (!existing) throw new HttpError(404, 'not_found', 'No such link');
        t.db.run('DELETE FROM links WHERE id=?', id);
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
  const pageName = text(t.db.get('name', 'Tendril'));
  const brandPrefix = `${base}_tendril/brand/`;
  const scopeChecks = SCOPE_ITEMS.map(item =>
    `<label class="check-item"><input type="checkbox" name="scopes" value="${item.value}"${item.defaultChecked ? ' checked' : ''}><span class="check-copy"><span class="check-title">${item.label}</span><span class="check-desc">${item.desc}</span></span></label>`,
  ).join('');
  const agentRows = owner ? t.db.all<{ name: string; last_used: number | null }>('SELECT name, last_used FROM tokens ORDER BY created_at').map(agent => {
    const binding = t.db.get<{ scopes?: string[] } | null>('agent_binding:' + agent.name, null);
    const scopeSummary = binding?.scopes?.length ? binding.scopes.join(', ') : 'Full host access';
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${text(agent.name)}</div><p class="list-item-sub">${text(scopeSummary)}</p></div><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="disconnect-agent"><input type="hidden" name="agent" value="${text(agent.name)}"><button class="sm danger">Disconnect</button></form></li>`;
  }).join('') : '';
  const requests = owner ? t.db.all<{ account_id: string; link_id: string }>('SELECT account_id,link_id FROM guest_accounts WHERE approved=0 ORDER BY created_at') : [];
  const guests = (await Promise.all(requests.map(async pending => {
    const account = await t.env.ACCOUNTS.prepare('SELECT email FROM accounts WHERE id=?').bind(pending.account_id).first<{ email: string | null }>();
    const fields = `<input type="hidden" name="account" value="${text(pending.account_id)}"><input type="hidden" name="link" value="${text(pending.link_id)}">`;
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${text(account?.email ?? pending.account_id)}</div><p class="list-item-sub">Pending guest invitation</p></div><div class="actions tight"><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="approve-guest">${fields}<button class="sm">Approve</button></form><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="decline-guest">${fields}<button class="sm secondary">Decline</button></form></div></li>`;
  }))).join('');
  const shareLinks = owner ? t.listLinks().filter(link => link.role !== 'owner') : [];
  const shareRows = shareLinks.map(link => {
    const roleLabel = link.role === 'guest' ? 'Guest invite' : 'Page-only';
    const roleClass = link.role === 'guest' ? 'ok' : '';
    const expiry = link.expires_at !== null && link.expires_at <= t.now() ? 'Expired' : link.expires_at ? `Expires ${new Date(link.expires_at).toLocaleDateString()}` : 'No expiry';
    return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${text(link.label || roleLabel)} <span class="badge ${roleClass}">${roleLabel}</span></div><p class="list-item-sub"><code>${text(link.url)}</code><br>${text(expiry)}</p></div><form class="inline-form" action="${actionURL}" method="post"><input type="hidden" name="action" value="revoke-link"><input type="hidden" name="link_id" value="${text(link.id)}"><button class="sm danger">Revoke</button></form></li>`;
  }).join('');
  const versions = owner ? listVersions(t).map(version =>
    `<li class="list-item"><div class="list-item-main"><div class="list-item-title">Version ${text(version.version)}${version.version === current ? ' <span class="badge ok">Current</span>' : ''}</div>${version.message ? `<p class="list-item-sub">${text(version.message)}</p>` : ''}</div></li>`,
  ).join('') : '';

  const ownerSections = `<div class="stack">
    <section class="card">
      <div class="card-head"><div><h2>Share &amp; invite</h2><p>Anyone with a guest invite link can sign in and join this app directly. Page-only links (up to 3) open page files without sign-in or private data access.</p></div>${shareLinks.length ? `<span class="badge">${shareLinks.length} retained</span>` : ''}</div>
      ${shareRows ? `<ul class="list">${shareRows}</ul>` : '<p class="empty">No active invite or page-only links yet.</p>'}
      <details class="disclosure"><summary>Create an invite or page-only link</summary><div class="disclosure-body">
        <form action="${actionURL}" method="post">
          <input type="hidden" name="action" value="create-link">
          <div class="field"><label class="field-label" for="link-role">Access type</label><select id="link-role" name="role"><option value="guest">Guest invite (anyone with link signs in and joins)</option><option value="display">Page-only link (page files only, no sign-in)</option></select></div>
          <div class="field"><label class="field-label" for="link-label">Label (optional)</label><input id="link-label" name="label" maxlength="100" placeholder="e.g. Alex or Living room tablet"></div>
          <div class="field"><label class="field-label" for="link-expiry">Expires</label><select id="link-expiry" name="expires_in"><option value="604800">In 7 days</option><option value="86400">In 24 hours</option><option value="2592000">In 30 days</option><option value="">Never</option></select></div>
          <div class="actions"><button>Create share link</button></div>
        </form>
      </div></details>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Guest requests</h2><p>People who opened an invitation link and are waiting for your approval.</p></div>${requests.length ? `<span class="badge warn">${requests.length} pending</span>` : ''}</div>
      ${guests ? `<ul class="list">${guests}</ul>` : '<p class="empty">No pending guest requests.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Connected agents</h2><p>Each connected agent uses its own revocable host credential. Chronolog signing grants are managed separately.</p></div></div>
      ${agentRows ? `<ul class="list">${agentRows}</ul>` : '<p class="empty">No agents connected.</p>'}
      <details class="disclosure"><summary>Add another agent</summary><div class="disclosure-body">
        <form action="${actionURL}" method="post">
          <input type="hidden" name="action" value="delegate-agent">
          <div class="field"><label class="field-label" for="agent-name">Agent name</label><input id="agent-name" name="name" required maxlength="64" placeholder="e.g. reviewer or mobile-sync"></div>
          <div class="group-label">Host permissions</div>
          <div class="check-list">${scopeChecks}</div>
          <div class="actions"><button>Add agent</button></div>
        </form>
      </div></details>
      <details class="disclosure danger"><summary>Replace all agent credentials for recovery</summary><div class="disclosure-body">
        <p class="muted">Creates a one-time recovery code. Redeeming it revokes every existing agent token above.</p>
        <form action="${actionURL}" method="post"><input type="hidden" name="action" value="connect-agent"><div class="actions"><button class="danger">Create replacing recovery code</button></div></form>
      </div></details>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Publications</h2><p>Restoring earlier code requires a new signed Chronolog publication.</p></div></div>
      ${versions ? `<ol class="list">${versions}</ol>` : '<p class="empty">No version has been published yet.</p>'}
    </section>
  </div>`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>Manage page · Tendriller</title>${brandHead(brandPrefix)}${serviceStyle}${brandStyle}</head><body><main><header>${brandMark(brandPrefix, base)}<a class="nav-link" href="${text(base)}">Return to page</a></header><div class="page-head"><div class="page-head-row"><div><span class="eyebrow">Page settings</span><h1>${pageName}</h1></div><span class="badge${owner ? ' ok' : ''}">${text(principal.role)} access</span></div></div>${message ? `<p class="notice" role="status">${text(message)}</p>` : ''}${owner ? ownerSections : '<section class="card"><p>Only the signed-in owner can manage agent connections, guest access, and publications.</p></section>'}<footer><a href="${text(t.env.PUBLIC_BASE + '/dashboard')}">Account dashboard</a><a href="${text(base + '_tendril/report')}">Report this page</a></footer></main></body></html>`;
  return new Response(req.method === 'HEAD' ? null : html, { headers: {
    // Keep Origin on same-origin navigation POSTs for the management forms.
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
