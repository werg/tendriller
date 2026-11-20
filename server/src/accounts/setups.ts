import type { Env } from '../env';
import { readSetupRow, requireSetupSchema } from '../account-setup';
import { errorResponse, HttpError } from '../http';
import { parsePageRoute, publicBase } from '../urls';
import { serviceSession } from './auth';
import { servicePage } from './ui';

interface OwnerSetup {
  page_id: string; operation_id: string; client_id: string; created_at: number; expires_at: number;
  state: string | null; indexed: number | null; page_state: string | null; owner_account: string | null;
}
const selection = `SELECT a.page_id,a.operation_id,a.client_id,a.created_at,a.expires_at,s.state,s.indexed,
  t.state AS page_state,t.owner_account FROM account_setup_allocations a
  LEFT JOIN account_setups s ON s.service_origin=a.service_origin AND s.account_id=a.account_id
    AND s.client_id=a.client_id AND s.operation_id=a.operation_id AND s.page_id=a.page_id
  LEFT JOIN tendrils t ON t.id=a.page_id WHERE a.service_origin=? AND a.account_id=?`;
const states = new Set(['prepared','provisioning','ready','blocked','expired','reconciliation_required']);
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const date = (value: number) => Number.isSafeInteger(value) && Math.abs(value) < 8.64e15 ? new Date(value).toISOString() : 'Unavailable';
function recordedState(row: OwnerSetup, account: string): string {
  if (!row.state || !states.has(row.state) || row.owner_account && row.owner_account !== account ||
      row.indexed && row.page_state !== 'active') return 'reconciliation_required';
  return row.expires_at <= Date.now() ? 'expired' : row.state;
}
function identity(row: OwnerSetup): string {
  return `<dl><dt>Page reference</dt><dd><code>${escape(row.page_id)}</code></dd>
    <dt>Setup operation</dt><dd><code>${escape(row.operation_id)}</code></dd>
    <dt>Connector client</dt><dd><code>${escape(row.client_id)}</code></dd>
    <dt>Started</dt><dd>${escape(date(row.created_at))}</dd>
    <dt>Setup credential deadline</dt><dd>${escape(date(row.expires_at))}</dd></dl>`;
}
function signIn(path: string): Response {
  return new Response(null,{status:302,headers:{Location:'/auth?return_to='+encodeURIComponent(path),'Cache-Control':'no-store'}});
}

/** Owner recovery is read-only and independent of a connector's continued grant. */
export async function setupDashboard(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.origin !== publicBase(env)) return errorResponse(404,'not_found');
  const detail = /^\/dashboard\/setups\/([a-z2-7]{12})$/.exec(url.pathname);
  if (!detail && url.pathname !== '/dashboard/setups') return errorResponse(404,'not_found');
  if (req.method !== 'GET') return errorResponse(405,'method_not_allowed','Setup recovery is read-only.');
  const session = await serviceSession(req,env);
  if (!session) return signIn(url.pathname);
  await requireSetupSchema(env);
  const currentOwner = async () => (await serviceSession(req,env))?.accountId === session.accountId;
  const args = [publicBase(env),session.accountId];
  if (!detail) {
    const rows = await env.ACCOUNTS.prepare(selection+' ORDER BY a.created_at DESC,a.page_id LIMIT 100').bind(...args).all<OwnerSetup>();
    if (!await currentOwner()) return signIn(url.pathname);
    const cards = rows.results.map(row => `<article class="card"><span class="eyebrow">Recorded setup: ${escape(recordedState(row,session.accountId).replaceAll('_',' '))}</span>
      <h2>${escape(row.page_id)}</h2>${identity(row)}<a href="/dashboard/setups/${escape(row.page_id)}">Inspect this setup</a></article>`).join('');
    return servicePage('Page setups',`<p><a href="/dashboard">Back to dashboard</a></p><h1>Your page setups</h1>
      <p>Find the original setup operation and inspect its existing page. This view includes retained setups from your connector clients, even after a connector is disconnected.</p>
      <p>The latest 100 retained records are shown. Listing them does not contact or restart their pages. A recorded ready setup is a host allocation; it does not prove that the application is prepared or connected.</p>
      <div class="grid">${cards || '<p>No retained page setups for this account.</p>'}</div>`);
  }
  const record = await env.ACCOUNTS.prepare(selection+' AND a.page_id=? LIMIT 1').bind(...args,detail[1]).first<OwnerSetup>();
  if (!record) return errorResponse(404,'not_found');
  let state = recordedState(record,session.accountId), pageUrl: string | null = null;
  let message = state === 'reconciliation_required'
    ? 'The retained records are missing or disagree. Preserve this operation and ask the service operator to reconcile it. Do not create a replacement.'
    : state === 'expired' ? 'This setup credential expired. Its operation remains reserved. A claimed page can still be managed through your dashboard.'
    : 'Retain the original local setup file. An agent can inspect or retry the same operation with its exact original input.';
  if (state !== 'reconciliation_required' && record.page_state === 'active') {
    try {
      const row = await readSetupRow(env,record.page_id);
      if (!row || row.account_id !== session.accountId || row.service_origin !== publicBase(env)) throw new HttpError(409,'reconciliation_required');
      if (!await currentOwner()) return signIn(url.pathname);
      const response = await env.TENDRIL.get(env.TENDRIL.idFromName(record.page_id)).fetch(new Request('https://tendril.internal/setup/inspect',{
        method:'POST',headers:{'Content-Type':'application/json','x-tendril-id':record.page_id},body:JSON.stringify({requestDigest:row.request_digest}),
      }));
      const data = await response.json<{page?:{id?:string;api?:string;page_url?:string;token?:unknown;application?:{id?:string}};error?:{code?:string}}>();
      if (!response.ok) throw new HttpError(response.status,data.error?.code ?? 'setup_inspection_unavailable');
      if (data.page) {
        const url = new URL(data.page.page_url ?? ''), parsed = parsePageRoute(url,env);
        if (data.page.id !== record.page_id || data.page.api !== publicBase(env)+'/api/t/'+record.page_id ||
            data.page.application?.id !== row.application_id || 'token' in data.page || !parsed || parsed.id !== record.page_id || parsed.rest !== '' ||
            url.username || url.password || url.search || url.hash) throw new HttpError(409,'reconciliation_required');
        pageUrl = url.toString();
        message = 'This is the original existing page. Open it when the agent has prepared the application. Owner sign-in, device enrollment and any assistant consent remain separate.';
      }
    } catch (error) {
      state = error instanceof HttpError && error.code === 'reconciliation_required' ? 'reconciliation_required' : 'inspection_unavailable';
      message = state === 'reconciliation_required'
        ? 'The page and retained records disagree. Preserve this operation and ask the service operator to reconcile it. No replacement has been created.'
        : 'The existing page could not be inspected. Keep this reference and inspect it again; this view never creates a replacement.';
    }
  }
  // No reference or page link is disclosed from an earlier, now-revoked session.
  if (!await currentOwner()) return signIn(url.pathname);
  return servicePage('Page setup',`<p><a href="/dashboard/setups">Back to page setups</a></p><h1>Page setup</h1>
    <p class="notice">${escape(state.replaceAll('_',' '))}</p>${identity(record)}<p>${escape(message)}</p>
    ${pageUrl ? `<p><a class="button" href="${escape(pageUrl)}">Open existing page</a></p>` : ''}
    <h2>If the local setup file was lost</h2><p>The service cannot reconstruct its private credential. Keep the operation and page references above. If the page exists, its intended owner can open it and use the existing reviewed access controls; a disconnected connector does not gain new authority here. Missing or damaged records require operator reconciliation.</p>`);
}
