import type { Tendril } from './tendril';
import type { PagePrincipal } from './access';
import { addActivity } from './activity';
import { listVersions, pointers } from './files';
import { escapeHtml } from './inject';
import { HttpError, readBody } from './http';
import { sha256Hex, sixDigits } from './ids';
import { ADOPT_CODE_TTL } from './limits';
import { serviceStyle } from './accounts/ui';

const text = (value: unknown) => escapeHtml(String(value ?? ''));

/** Service-owned recovery works even when the authored page cannot execute. */
export async function handleManagement(t: Tendril, req: Request, base: string, principal: PagePrincipal): Promise<Response> {
  const owner = principal.role === 'owner' && !!principal.accountId;
  let message = '';
  if (req.method === 'POST') {
    if (!owner) throw new HttpError(403, 'forbidden', 'Only the signed-in owner can manage this page');
    if (!(req.headers.get('Content-Type') ?? '').startsWith('application/x-www-form-urlencoded'))
      throw new HttpError(415, 'unsupported_media_type', 'Expected a management form');
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
    const action = form.get('action');
    if (action === 'connect-agent') {
      const code = `${t.tid}-${sixDigits()}`, expires = t.now() + ADOPT_CODE_TTL;
      t.db.set('adopt', { hash: await sha256Hex(code), expires_at: expires, attempts: 0 });
      addActivity(t, { kind: 'adopt_code', summary: 'The owner created an agent connection code', by: `owner:${principal.accountId}` });
      message = `Give this one-time code to your agent: ${code}. It expires in ten minutes.`;
    } else if (action === 'disconnect-agent') {
      const name = form.get('agent') ?? '';
      if (!t.db.one('SELECT 1 FROM tokens WHERE name=?', name)) throw new HttpError(404, 'not_found', 'No such agent');
      t.db.run('DELETE FROM tokens WHERE name=?', name);
          message = `Disconnected ${name}.`;
    } else if (action === 'approve-guest' || action === 'decline-guest') {
      const account = form.get('account') ?? '', link = form.get('link') ?? '';
      if (!t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND link_id=? AND approved=0', account, link))
        throw new HttpError(404, 'not_found', 'This guest request is no longer pending');
      t.db.run('UPDATE guest_accounts SET approved=? WHERE account_id=? AND link_id=?', action === 'approve-guest' ? 1 : -1, account, link);
      message = action === 'approve-guest' ? 'Guest access approved.' : 'Guest access declined.';
    } else throw new HttpError(400, 'bad_request', 'Unknown management action');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');

  const actionURL = text(`${base}_tendril/manage`), current = pointers(t).current ?? 0;
  const form = (action: string, fields: string, label: string) => `<form action="${actionURL}" method="post"><input type="hidden" name="action" value="${action}">${fields}<button>${text(label)}</button></form>`;
  const versions = owner ? listVersions(t).map(version => `<li><strong>Publication ${text(version.version)}</strong>${version.version === current ? ' · current' : ''}<p>${text(version.message)}</p></li>`).join('') : '';
  const agents = owner ? t.db.all<{ name: string }>('SELECT name FROM tokens ORDER BY created_at').map(agent => `<li>${text(agent.name)}${form('disconnect-agent', `<input type="hidden" name="agent" value="${text(agent.name)}">`, 'Disconnect')}</li>`).join('') : '';
  const requests = owner ? t.db.all<{ account_id: string; link_id: string }>('SELECT account_id,link_id FROM guest_accounts WHERE approved=0 ORDER BY created_at') : [];
  const guests = (await Promise.all(requests.map(async pending => {
    const account = await t.env.ACCOUNTS.prepare('SELECT email FROM accounts WHERE id=?').bind(pending.account_id).first<{ email: string | null }>();
    const fields = `<input type="hidden" name="account" value="${text(pending.account_id)}"><input type="hidden" name="link" value="${text(pending.link_id)}">`;
    return `<li>${text(account?.email ?? pending.account_id)}<div class="actions">${form('approve-guest', fields, 'Approve')}${form('decline-guest', fields, 'Decline')}</div></li>`;
  }))).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Page recovery · Tendriller</title>${serviceStyle}<style>li{margin:1rem 0}li p{margin:.2rem 0}form{display:inline-block;margin:.4rem .5rem .4rem 0}h2{margin-top:2rem}</style></head><body><main><header><strong>Tendriller</strong><a href="${text(base)}">Return to page</a></header><h1>Page recovery</h1><p>${text(t.db.get('name', 'Tendril'))} · ${text(principal.role)} access</p>${message ? `<p class="notice" role="status">${text(message)}</p>` : ''}${owner ? `<section><h2>Agent connection</h2><p>Create a connection code when you need a new agent to continue this page.</p>${form('connect-agent', '', 'Create connection code')}<ul>${agents || '<li>No agent is connected.</li>'}</ul></section><section><h2>Guest requests</h2><ul>${guests || '<li>No pending requests.</li>'}</ul></section><section><h2>Publications</h2><p>Restoring earlier code requires a new signed Chronolog publication. The release history and application recovery remain independent.</p><ol>${versions || '<li>No page has been published.</li>'}</ol></section>` : '<p>The signed-in owner can manage agent connections, guest access, and publications.</p>'}<footer><a href="${text(t.env.PUBLIC_BASE + '/dashboard')}">Account dashboard</a><a href="${text(base + '_tendril/report')}">Report this page</a></footer></main></body></html>`;
  return new Response(req.method === 'HEAD' ? null : html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
