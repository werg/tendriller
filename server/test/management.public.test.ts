import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, create, inDO, joinAccountAgent, ownerHeaders, req } from './helpers';
import { sha256Hex } from '../src/ids';

it('serves recovery independently of authored code and enforces owner and origin boundaries', async () => {
  const h = await create();
  const url = h.page_url + '_tendril/manage';
  const response = await req(url);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).toContain('Give an agent access');
  expect(html).toContain('Agents with access');
  expect(html).toContain('Created this page');
  expect(html).not.toContain('Replace all agent credentials');
  expect(html).not.toContain('tendril.js');
  expect(html).not.toContain('<script');
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const foreign = await req(url, { method: 'POST', headers: { ...ownerHeaders(url), ...form, Origin: 'https://other.example' }, body: 'action=agent-access' });
  expect(foreign.status).toBe(403);

  const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
  const displayURL = display.url + '_tendril/manage';
  const displayPage = await req(displayURL, { anonymous: true });
  expect(await displayPage.text()).not.toContain('name="agent"');
  const denied = await req(displayURL, { anonymous: true, method: 'POST', headers: { ...form, Origin: new URL(displayURL).origin }, body: `action=remove-agent&agent=${h.agent.id}` });
  expect(denied.status).toBe(403);
  expect((await api(h, 'GET', '')).status).toBe(200);
});

it('grants and removes account agents with one checkbox per agent on the script-free page', async () => {
  const h = await create(), url = h.page_url + '_tendril/manage';
  const joined = await joinAccountAgent(h, 'reviewer');
  const reviewer = { ...h, token: joined.token, agent: joined.agent };
  expect((await api(reviewer, 'GET', '')).status).toBe(404);
  const page = await (await req(url)).text();
  expect(page).toContain(`name="agent" value="${joined.agent.id}"`);
  expect(page).toMatch(new RegExp(`value="${h.agent.id}" checked`));
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const known = `known=${h.agent.id}&known=${joined.agent.id}`;
  const granted = await req(url, { method: 'POST', headers: form, body: `action=agent-access&${known}&agent=${h.agent.id}&agent=${joined.agent.id}` });
  expect(await granted.text()).toContain('1 granted, 0 removed');
  expect((await api(reviewer, 'GET', '')).status).toBe(200);
  expect((await req(url).then(r => r.text()))).toMatch(new RegExp(`value="${joined.agent.id}" checked`));
  const removed = await req(url, { method: 'POST', headers: form, body: `action=agent-access&${known}&agent=${h.agent.id}` });
  expect(await removed.text()).toContain('0 granted, 1 removed');
  expect((await api(reviewer, 'GET', '')).status).toBe(404);
  expect((await api(h, 'GET', '')).status).toBe(200);
  await req(url, { method: 'POST', headers: form, body: `action=remove-agent&agent=${h.agent.id}` });
  expect((await api(h, 'GET', '')).status).toBe(404);
});

it('requires a new signed release instead of an unsigned version-selection form', async () => {
  const h = await create();
  const response = await req(h.page_url + '_tendril/manage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=select-version&head_revision=1&version=1' });
  expect(response.status).toBe(400);
  const html = await (await req(h.page_url + '_tendril/manage')).text();
  expect(html).toContain('new signed Chronolog publication');
  expect(html).not.toContain('name="version"');
  expect(await inDO(h.id, t => t.db.get('current', 0))).toBe(0);
});

it('lets the owner create, list and revoke guest and display share links via page API and management UI', async () => {
  const h = await create();
  const linksUrl = h.page_url + '_tendril/links';
  const manageUrl = h.page_url + '_tendril/manage';

  const guestRes = await req(linksUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'guest', label: 'Alex', expires_in: 86400 }),
  });
  expect(guestRes.status).toBe(201);
  const guestLink = await guestRes.json() as { id: string; url: string; role: string; label: string };
  expect(guestLink.role).toBe('guest');
  expect(guestLink.label).toBe('Alex');

  const displayRes = await req(linksUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'display', label: 'Kitchen tablet' }),
  });
  expect(displayRes.status).toBe(201);
  const displayLink = await displayRes.json() as { id: string; url: string; role: string; label: string };
  expect(displayLink.role).toBe('display');

  const listed = await (await req(linksUrl)).json() as { links: { id: string; role: string }[] };
  expect(listed.links.map(l => l.id)).toContain(guestLink.id);
  expect(listed.links.map(l => l.id)).toContain(displayLink.id);

  // Display visitors cannot manage or list owner links
  expect((await req(displayLink.url + '_tendril/links', { anonymous: true })).status).toBe(403);
  expect((await req(linksUrl + '/l_main', { method: 'DELETE' })).status).toBe(400);

  // Management HTML shows created links and can create/revoke them without scripts
  const html = await (await req(manageUrl)).text();
  expect(html).toContain('Share &amp; invite');
  expect(html).toContain('Alex');
  expect(html).toContain('Kitchen tablet');

  const formCreate = await req(manageUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=create-link&role=guest&label=Sam&expires_in=604800',
  });
  expect(formCreate.status).toBe(200);
  expect(await formCreate.text()).toContain('Guest invite link created:');

  expect((await req(`${linksUrl}/${guestLink.id}`, { method: 'DELETE' })).status).toBe(204);
  const after = await (await req(linksUrl)).json() as { links: { id: string }[] };
  expect(after.links.map(l => l.id)).not.toContain(guestLink.id);
});

it('keeps expired page-only links visible and revocable so their slots can be reused', async () => {
  const h = await create(), manageUrl = h.page_url + '_tendril/manage';
  const links = await inDO(h.id, async t => {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await t.createLink('display', `Expired tablet ${i}`, 1));
    t.db.run("UPDATE links SET expires_at=? WHERE role='display'", t.now() - 1);
    return rows;
  });
  const html = await (await req(manageUrl)).text();
  expect(html).toContain('open page files without sign-in or private data access.');
  expect(html).toContain('Expired tablet 0');
  expect(html).toContain('Expired');
  expect(html).toContain(`name="link_id" value="${links[0].id}"`);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  expect((await req(manageUrl, { method: 'POST', headers, body: `action=revoke-link&link_id=${links[0].id}` })).status).toBe(200);
  expect((await req(manageUrl, { method: 'POST', headers, body: 'action=create-link&role=display&label=Replacement' })).status).toBe(200);
});

it('rechecks owner revocation and total quota at the link insertion boundary for both creation routes', async () => {
  for (const route of ['manage', 'links']) {
    for (const change of ['session', 'quota']) {
      const h = await create(), url = h.page_url + '_tendril/' + route;
      const restore = await inDO(h.id, t => {
        const original = t.createLink;
        t.createLink = async (...args) => {
          if (change === 'session') t.db.run('DELETE FROM page_sessions');
          else {
            for (let i = 0; i < 49; i++) t.db.run(`INSERT INTO links(id,key,key_hash,role,created_at,created_by_agent)
              VALUES(?,?,?,'guest',?,0)`, `filler-${i}`, `filler-key-${i}`, `filler-hash-${i}`, t.now());
          }
          return original.apply(t, args);
        };
        return () => { t.createLink = original; };
      });
      try {
        const response = await req(url, { method: 'POST', headers: { 'Content-Type': route === 'manage' ? 'application/x-www-form-urlencoded' : 'application/json' },
          body: route === 'manage' ? 'action=create-link&role=guest&label=MustNotExist' : JSON.stringify({ role: 'guest', label: 'MustNotExist' }) });
        expect(response.status, `${route}: ${change}`).toBe(change === 'session' ? 401 : 429);
        expect(await inDO(h.id, t => t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links WHERE label='MustNotExist'")!.n)).toBe(0);
      } finally { await inDO(h.id, restore); }
    }
  }
});

it('enforces the display quota atomically across parallel link preparation', async () => {
  const h = await create();
  const result = await inDO(h.id, async t => {
    await t.createLink('display', 'one', null);
    await t.createLink('display', 'two', null);
    const results = await Promise.allSettled([t.createLink('display', 'three', null), t.createLink('display', 'four', null)]);
    return { fulfilled: results.filter(row => row.status === 'fulfilled').length,
      count: t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links WHERE role='display'")!.n };
  });
  expect(result).toEqual({ fulfilled: 1, count: 3 });
});

it('lets a signed-in visitor join any open guest invite in one go and enforces optional email gating', async () => {
  const h = await create();
  const makeAccount = async (email: string) => {
    const id = crypto.randomUUID(), rawSession = 'guest-' + crypto.randomUUID();
    await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(id, Date.now(), email).run();
    await env.ACCOUNTS.prepare('INSERT INTO identities(provider,subject,account_id,login,email,created_at) VALUES(?,?,?,?,?,?)')
      .bind('github', id, id, email.split('@')[0], email, Date.now()).run();
    await env.ACCOUNTS.prepare('INSERT INTO identity_emails(provider,subject,email) VALUES(?,?,?)')
      .bind('github', id, email.toLowerCase()).run();
    await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
      .bind(await sha256Hex(rawSession), id, Date.now(), Date.now() + 86_400_000).run();
    return { id, cookie: `__Host-tendriller=${rawSession}` };
  };

  // Open guest invite (including agent-created): joins in one go with no waiting screen.
  const openRes = await api(h, 'POST', 'links', { role: 'guest', label: 'Open friend' });
  expect(openRes.status).toBe(201);
  const { url: openUrl } = await openRes.json() as { url: string };
  const openKey = new URL(openUrl).pathname.split('/')[2];
  const friend = await makeAccount('friend@example.test');
  const openAuth = await req(`https://tendriller.dev/auth/page?tendril=${h.id}&key=${openKey}`, {
    anonymous: true, redirect: 'manual', headers: { Cookie: friend.cookie },
  });
  expect(openAuth.status).toBe(303);
  expect(openAuth.headers.get('Location')).toContain('_tendril/auth/session?code=');
  expect(await inDO(h.id, t => t.db.one('SELECT approved FROM guest_accounts WHERE account_id=?', friend.id))).toEqual({ approved: 1 });

  // Email-gated guest invite: rejects non-matching email and admits matching OAuth email in one go.
  const badEmail = await req(h.page_url + '_tendril/links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'guest', email: 'not-an-email' }),
  });
  expect(badEmail.status).toBe(400);
  const displayWithEmail = await req(h.page_url + '_tendril/links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'display', email: 'alex@example.test' }),
  });
  expect(displayWithEmail.status).toBe(400);

  const gatedRes = await req(h.page_url + '_tendril/links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'guest', label: 'Alex only', email: 'Alex@Example.Test' }),
  });
  expect(gatedRes.status).toBe(201);
  const gated = await gatedRes.json() as { url: string; email: string };
  expect(gated.email).toBe('alex@example.test');
  const gatedKey = new URL(gated.url).pathname.split('/')[2];

  // Signed-out sign-in prompt shows masked email hint.
  const promptHtml = await (await req(`https://tendriller.dev/auth/page?tendril=${h.id}&key=${gatedKey}`, { anonymous: true })).text();
  expect(promptHtml).toContain('Invited email: a***@example.test');

  // Wrong email gets clear 403 screen, never admitted.
  const wrongAuth = await req(`https://tendriller.dev/auth/page?tendril=${h.id}&key=${gatedKey}`, {
    anonymous: true, redirect: 'manual', headers: { Cookie: friend.cookie },
  });
  expect(wrongAuth.status).toBe(403);
  expect(await wrongAuth.text()).toContain('This invitation is for another email address');

  // Matching verified OAuth email joins straight in one go!
  const alex = await makeAccount('alex@example.test');
  const alexAuth = await req(`https://tendriller.dev/auth/page?tendril=${h.id}&key=${gatedKey}`, {
    anonymous: true, redirect: 'manual', headers: { Cookie: alex.cookie },
  });
  expect(alexAuth.status).toBe(303);
  expect(alexAuth.headers.get('Location')).toContain('_tendril/auth/session?code=');
  expect(await inDO(h.id, t => t.db.one('SELECT approved FROM guest_accounts WHERE account_id=?', alex.id))).toEqual({ approved: 1 });
});
