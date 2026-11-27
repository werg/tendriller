import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { BASE, agentReq, api, create, dashboard, inDO, req, testPublicKey, testWrapKey } from './helpers';
import { sha256Hex } from '../src/ids';

async function serviceCookie(id: string): Promise<string> {
  const account = await inDO(id, t => t.db.get<string>('owner_account', ''));
  const raw = `test-${crypto.randomUUID()}`;
  await env.ACCOUNTS!.prepare('INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(raw), account, Date.now(), Date.now() + 60_000).run();
  return `__Host-tendriller=${raw}`;
}

it('Dashboard → Your agents issues a paste-ready one-time join code and lists, grants and revokes account agents', async () => {
  const h = await create({ name: 'Kitchen helper' });
  const html = await (await dashboard(h, '/dashboard')).text();
  expect(html).toContain('id="agents"');
  expect(html).toContain('Add agent');
  expect(html).toContain(h.agent.handle);
  expect(html).toContain(`value="${h.agent.id}" data-grant`);
  expect(html).toContain(`data-agents="${h.agent.id}"`);

  expect((await req('/dashboard/agents/join', { method: 'POST', anonymous: true, headers: { Cookie: h.session!, Origin: 'https://evil.example' } })).status).toBe(403);
  const issued = await dashboard(h, '/dashboard/agents/join', { method: 'POST' });
  expect(issued.status).toBe(201);
  const invite = await issued.json() as { code: string; blurb: string; expires_at: number };
  expect(invite.code).toMatch(/^tj_[a-z2-7]{26}$/);
  expect(invite.blurb).toContain(invite.code);
  expect(invite.blurb).toContain(`${BASE}/api/agents/join`);
  expect(invite.blurb).toContain('publicKey');
  expect(invite.expires_at - Date.now()).toBeLessThanOrEqual(10 * 60_000);

  const join = (code: string, handle: string) => req('/api/agents/join', { method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, handle, publicKey: testPublicKey(), wrapKey: testWrapKey() }) });
  expect((await join(invite.code, h.agent.handle)).status).toBe(409);
  const joined = await join(invite.code, 'reviewer');
  expect(joined.status).toBe(201);
  const reviewer = await joined.json() as { token: string; agent: { id: string; handle: string; claimed: boolean } };
  expect(reviewer.agent).toMatchObject({ handle: 'reviewer', claimed: true });
  expect(reviewer.token).toMatch(/^ta_[a-z2-7]{32}$/);
  expect((await join(invite.code, 'second-use')).status).toBe(404);

  const asReviewer = { ...h, token: reviewer.token, agent: { ...h.agent, id: reviewer.agent.id } };
  expect((await api(asReviewer, 'GET', '')).status).toBe(404);
  const listed = await (await dashboard(h, '/dashboard')).text();
  expect(listed).toContain('reviewer');
  expect(listed).toContain(`value="${reviewer.agent.id}" data-grant`);
  const grant = (granted: boolean, page = h.id) => dashboard(h, `/dashboard/t/${page}/agents`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: reviewer.agent.id, granted }) });
  expect((await grant(true)).status).toBe(200);
  expect((await api(asReviewer, 'GET', '')).status).toBe(200);
  expect(await (await dashboard(h, '/dashboard')).text()).toContain(`data-agents="${[h.agent.id, reviewer.agent.id].sort().join(' ')}"`);
  const other = await create();
  expect((await grant(true, other.id)).status).toBe(404);
  expect((await grant(false)).status).toBe(200);
  expect((await api(asReviewer, 'GET', '')).status).toBe(404);

  const revoked = await dashboard(h, `/dashboard/agents/${reviewer.agent.id}/revoke`, { method: 'POST' });
  expect(revoked.status).toBe(303);
  expect((await agentReq(reviewer.token, 'GET', '/api/agent')).status).toBe(401);
  const afterRevoke = await (await dashboard(h, '/dashboard')).text();
  expect(afterRevoke).not.toContain(reviewer.agent.id);
  expect(afterRevoke).not.toContain('Revoke @reviewer');
});

it('the dashboard adds people and devices for owned pages only', async () => {
  const h = await create({ name: 'Garden log' });
  const cookie = await serviceCookie(h.id);
  const page = await req('/dashboard', { headers: { Cookie: cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Add people &amp; devices');
  expect(html).toContain(`data-add="${h.id}"`);
  expect(html).toContain('class="avatar favicon"');
  await api(h, 'PATCH', '', { icon: '🥕' });
  const withEmoji = await (await req('/dashboard', { headers: { Cookie: cookie } })).text();
  expect(withEmoji).toContain('class="avatar favicon emoji"');
  expect(withEmoji).toContain('🥕');
  await api(h, 'PATCH', '', { icon: 'https://cdn.example/icon.png' });
  const remote = await req('/dashboard', { headers: { Cookie: cookie } });
  expect(remote.headers.get('content-security-policy')).toContain("img-src 'self' https:");
  expect(await remote.text()).toContain('src="https://cdn.example/icon.png"');

  const qr = await req(`/dashboard/t/${h.id}/qr.svg`, { headers: { Cookie: cookie } });
  expect(qr.status).toBe(200);
  expect(qr.headers.get('content-type')).toBe('image/svg+xml');

  const json = { Cookie: cookie, 'Content-Type': 'application/json', Origin: BASE };
  const foreign = await req(`/dashboard/t/${h.id}/invite`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{"role":"guest"}' });
  expect(foreign.status).toBe(403);
  const link = await req(`/dashboard/t/${h.id}/invite`, { method: 'POST', headers: json, body: JSON.stringify({ role: 'guest', email: 'alex@example.test', expires_in: 3600 }) });
  expect(link.status).toBe(201);
  const created = await link.json() as { url: string; role: string; email: string; qr_svg: string };
  expect(created).toMatchObject({ role: 'guest', email: 'alex@example.test' });
  expect(created.qr_svg).toContain('<svg');

  const other = await create();
  const forbidden = await req(`/dashboard/t/${other.id}/invite`, { method: 'POST', headers: json, body: JSON.stringify({ role: 'guest' }) });
  expect(forbidden.status).toBe(404);
  expect((await req(`/dashboard/t/${other.id}/qr.svg`, { headers: { Cookie: cookie } })).status).toBe(404);
});

it('owners can delete a resident page from the dashboard or page settings, freeing a resident slot', async () => {
  const h = await create({ name: 'Old project' });
  const cookie = await serviceCookie(h.id);
  const owner = await inDO(h.id, t => t.db.get<string>('owner_account', ''));
  await env.ACCOUNTS!.prepare("UPDATE tendrils SET lifetime = 'resident' WHERE id = ?").bind(h.id).run();
  for (let i = 0; i < 19; i++) await env.ACCOUNTS!.prepare("INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES(?,?,?,'resident')")
    .bind(crypto.randomUUID(), owner, Date.now()).run();
  await expect(env.ACCOUNTS!.prepare("INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES(?,?,?,'resident')")
    .bind(crypto.randomUUID(), owner, Date.now()).run()).rejects.toThrow('account_tendrils_full');
  const html = await (await req('/dashboard', { headers: { Cookie: cookie } })).text();
  expect(html).toContain(`data-delete="${h.id}"`);
  expect(html).toContain('You have reached 20 resident pages');

  const form = { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE };
  expect((await req(`/dashboard/t/${h.id}/delete`, { method: 'POST', headers: form, body: 'confirm=wrong' })).status).toBe(400);
  expect((await req(`/dashboard/t/${h.id}/delete`, { method: 'POST', headers: { ...form, Origin: 'https://evil.example' }, body: `confirm=${h.id}` })).status).toBe(403);
  const deleted = await req(`/dashboard/t/${h.id}/delete`, { method: 'POST', headers: form, body: `confirm=${h.id}`, redirect: 'manual' });
  expect(deleted.status).toBe(303);
  expect(deleted.headers.get('Location')).toBe('/dashboard?deleted=1');
  expect(await env.ACCOUNTS!.prepare('SELECT 1 FROM tendrils WHERE id = ?').bind(h.id).first()).toBeNull();
  await env.ACCOUNTS!.prepare("INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES(?,?,?,'resident')").bind(crypto.randomUUID(), owner, Date.now()).run();

  const other = await create({ name: 'Settings delete' });
  const manage = other.page_url + '_tendril/manage';
  const urlencoded = { 'Content-Type': 'application/x-www-form-urlencoded' };
  expect((await req(manage, { method: 'POST', headers: urlencoded, body: 'action=delete-page&confirm=nope' })).status).toBe(400);
  const gone = await req(manage, { method: 'POST', headers: urlencoded, body: 'action=delete-page&confirm=DELETE' });
  expect(gone.status).toBe(200);
  expect(await gone.text()).toContain('This page was deleted');
  expect(await env.ACCOUNTS!.prepare('SELECT 1 FROM tendrils WHERE id = ?').bind(other.id).first()).toBeNull();
});

it('the status page keeps the labels the deployment smoke check reads', async () => {
  const html = await (await req('/status', { anonymous: true })).text();
  expect(html).toMatch(/Operational|New page creation paused|Read-only or unavailable/);
});

it('invite and display links support an optional target view and inject viewerRole + defaultView into page HTML', async () => {
  const h = await create({ name: 'Multi-view board' });
  const cookie = await serviceCookie(h.id);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: BASE };

  // Invalid view id is rejected
  const bad = await req(`/dashboard/t/${h.id}/invite`, {
    method: 'POST', headers, body: JSON.stringify({ role: 'display', view: '../bad' }),
  });
  expect(bad.status).toBe(400);

  // Dashboard invite with view appends ?view= and returns view
  const dashRes = await req(`/dashboard/t/${h.id}/invite`, {
    method: 'POST', headers, body: JSON.stringify({ role: 'display', label: 'Wallboard', view: 'kiosk' }),
  });
  expect(dashRes.status).toBe(201);
  const dashLink = await dashRes.json() as { id: string; url: string; view?: string };
  expect(dashLink.view).toBe('kiosk');
  expect(dashLink.url).toContain('?view=kiosk');

  // Opening the display link HTML (even without ?view= in query) injects viewerRole:"display" & defaultView:"kiosk"
  const rawDisplayUrl = dashLink.url.split('?')[0]!;
  const displayHtml = await (await req(rawDisplayUrl, { anonymous: true })).text();
  expect(displayHtml).toContain('"viewerRole":"display"');
  expect(displayHtml).toContain('"defaultView":"kiosk"');

  // Page-local POST _tendril/links supports view and DELETE cleans up link_view:<id>
  const pageLinkRes = await req(`${h.page_url}_tendril/links`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'guest', label: 'Field crew', view: 'guest-mobile' }),
  });
  expect(pageLinkRes.status).toBe(201);
  const pageLink = await pageLinkRes.json() as { id: string; url: string; view?: string };
  expect(pageLink.view).toBe('guest-mobile');
  expect(pageLink.url).toContain('?view=guest-mobile');

  const delRes = await req(`${h.page_url}_tendril/links/${pageLink.id}`, { method: 'DELETE' });
  expect(delRes.status).toBe(204);
  const leftover = await inDO(h.id, t => t.db.get<string | null>(`link_view:${pageLink.id}`, null));
  expect(leftover).toBeNull();
});
