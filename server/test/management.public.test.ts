import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, create, inDO, ownerHeaders, req } from './helpers';
import { sha256Hex } from '../src/ids';

it('serves recovery independently of authored code and enforces owner and origin boundaries', async () => {
  const h = await create();
  const url = h.page_url + '_tendril/manage';
  const response = await req(url);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).toContain('Add agent');
  expect(html).toContain('value="control:write"');
  expect(html).toContain('Update signed application control');
  expect(html).toContain('Replace all agent credentials for recovery');
  expect(html).not.toContain('tendril.js');
  expect(html).not.toContain('<script');
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const foreign = await req(url, { method: 'POST', headers: { ...ownerHeaders(url), ...form, Origin: 'https://other.example' }, body: 'action=connect-agent' });
  expect(foreign.status).toBe(403);
  const connected = await req(url, { method: 'POST', headers: form, body: 'action=connect-agent' });
  expect(connected.status).toBe(200);
  expect(await connected.text()).toContain('replaces all existing agent credentials');
  expect(await inDO(h.id, t => t.db.get<any>('adopt', null))).toMatchObject({ attempts: 0 });

  const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
  const displayURL = display.url + '_tendril/manage';
  const displayPage = await req(displayURL, { anonymous: true });
  expect(await displayPage.text()).not.toContain('name="agent"');
  const denied = await req(displayURL, { anonymous: true, method: 'POST', headers: { ...form, Origin: new URL(displayURL).origin }, body: 'action=connect-agent' });
  expect(denied.status).toBe(403);
});

it('an owner can enroll another scoped agent without revoking existing agents', async () => {
  const h = await create(), url = h.page_url + '_tendril/manage';
  const issued = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=delegate-agent&name=reviewer&scopes=host%3Aread&scopes=participants%3Aconnect' });
  expect(issued.status).toBe(200);
  const code = new RegExp(h.id + '-[0-9]{6}').exec(await issued.text())![0];
  const response = await req('https://tendriller.dev/api/adopt', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  expect(response.status).toBe(200);
  const added = await response.json() as { token: string };
  expect((await api(h, 'GET', '')).status).toBe(200);
  expect((await api({ ...h, token: added.token }, 'GET', '')).status).toBe(200);
  expect((await api({ ...h, token: added.token }, 'PATCH', '', { name: 'unauthorized' })).status).toBe(403);
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

it('requires the reviewed delegation mode and exact application before consuming its code', async () => {
  const descriptor = await req('/api/adopt', { anonymous: true });
  expect(descriptor.status).toBe(200);
  expect(descriptor.headers.get('cache-control')).toBe('no-store');
  expect(await descriptor.json()).toEqual({ schemaVersion: 1, serviceOrigin: 'https://tendriller.dev',
    delegation: { applicationBound: true, nonReplacing: true, responseRecovery: false } });
  const h = await create(), url = h.page_url + '_tendril/manage';
  const issue = async (body: string) => {
    const response = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    expect(response.status).toBe(200);
    return new RegExp(h.id + '-[0-9]{6}').exec(await response.text())![0];
  };
  const redeem = (code: string, applicationId = h.application.id) => req('/api/adopt', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, expectedMode: 'delegate', applicationId }) });
  const replacing = await issue('action=connect-agent');
  const wrongMode = await redeem(replacing);
  expect(wrongMode.status).toBe(409);
  expect(await wrongMode.json()).toMatchObject({ error: { code: 'adoption_mode_mismatch' } });
  expect((await api(h, 'GET', '')).status).toBe(200);
  const code = await issue('action=delegate-agent&name=retained-native&scopes=host%3Aread&scopes=participants%3Aconnect&scopes=control%3Awrite');
  const wrongApp = await redeem(code, 'f'.repeat(64));
  expect(wrongApp.status).toBe(409);
  expect(await wrongApp.json()).toMatchObject({ error: { code: 'adoption_application_mismatch' } });
  const [first, concurrent] = await Promise.all([redeem(code), redeem(code)]);
  expect([first, concurrent].filter(response => response.ok)).toHaveLength(1);
  const loser = first.ok ? concurrent : first;
  expect([404, 409]).toContain(loser.status);
  expect(['invalid_code', 'adoption_changed']).toContain((await loser.json() as { error: { code: string } }).error.code);
  const added = await (first.ok ? first : concurrent).json() as { token: string; application: { id: string } };
  expect(added.application.id).toBe(h.application.id);
  expect((await api(h, 'GET', '')).status).toBe(200);
  expect((await api({ ...h, token: added.token }, 'GET', 'self')).status).toBe(200);
  expect(await inDO(h.id, t => t.db.get('agent_binding:retained-native', null)))
    .toMatchObject({ scopes: ['host:read', 'participants:connect', 'control:write'] });
  expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n: 2 });
});

it('preserves a reviewed code when writes, its page or its owner no longer permit redemption', async () => {
  for (const reason of ['read_only', 'disabled', 'suspended', 'deleting', 'page_deleting'] as const) {
    const h = await create(), url = h.page_url + '_tendril/manage';
    const issued = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=delegate-agent&name=retained-native&scopes=host%3Aread&scopes=participants%3Aconnect' });
    const code = new RegExp(h.id + '-[0-9]{6}').exec(await issued.text())![0];
    const before = await inDO(h.id, t => ({ code: t.db.get('adopt', null), owner: t.db.get('owner_account', '') }));
    if (reason === 'read_only') await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
    if (reason === 'disabled') await inDO(h.id, t => t.db.set('disabled', true));
    if (reason === 'suspended') await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), before.owner).run();
    if (reason === 'deleting') await env.ACCOUNTS.prepare('UPDATE accounts SET deleting_at=? WHERE id=?').bind(Date.now(), before.owner).run();
    if (reason === 'page_deleting') await env.ACCOUNTS.prepare("UPDATE tendrils SET state='deleting' WHERE id=?").bind(h.id).run();
    try {
      const response = await req('/api/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, expectedMode: 'delegate', applicationId: h.application.id }) });
      expect(response.status, reason).toBe(reason === 'read_only' ? 503 : 403);
      expect(await response.json()).toMatchObject({ error: { code: reason === 'read_only' ? 'read_only' : 'disabled' } });
      expect(await inDO(h.id, t => t.db.get('adopt', null)), reason).toEqual(before.code);
      expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens')), reason).toEqual({ n: 1 });
    } finally {
      await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
    }
  }
});

it('rechecks write admission after asynchronous token preparation without consuming the code', async () => {
  const h = await create(), url = h.page_url + '_tendril/manage';
  const issued = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=delegate-agent&name=retained-native&scopes=host%3Aread' });
  const code = new RegExp(h.id + '-[0-9]{6}').exec(await issued.text())![0];
  const before = await inDO(h.id, t => t.db.get('adopt', null));
  const restore = await inDO(h.id, t => {
    const original = t.addToken;
    t.addToken = async (...args) => {
      await t.env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
      return original.apply(t, args);
    };
    return () => { t.addToken = original; };
  });
  try {
    const response = await req('/api/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, expectedMode: 'delegate', applicationId: h.application.id }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'read_only' } });
    expect(await inDO(h.id, t => t.db.get('adopt', null))).toEqual(before);
    expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n: 1 });
  } finally {
    await inDO(h.id, restore);
    await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
  }
  const retry = await req('/api/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, expectedMode: 'delegate', applicationId: h.application.id }) });
  expect(retry.status).toBe(200);
  const delegated = await retry.json() as { token: string };
  expect((await api({ ...h, token: delegated.token }, 'GET', 'self')).status).toBe(200);
});

it('a late failed redemption cannot restore the code replaced during its policy read', async () => {
  const h = await create(), url = h.page_url + '_tendril/manage';
  const issued = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=delegate-agent&name=retained-native&scopes=host%3Aread' });
  const code = new RegExp(h.id + '-[0-9]{6}').exec(await issued.text())![0];
  const wrongCode = code.slice(0, -1) + ((Number(code.at(-1)) + 1) % 10);
  const replacementCode = code.slice(0, -1) + ((Number(code.at(-1)) + 2) % 10);
  const replacementHash = await sha256Hex(replacementCode);
  const original = await inDO(h.id, t => t.db.get<object>('adopt', {}));
  const replacement = { ...original, hash: replacementHash };
  const restore = await inDO(h.id, t => {
    const database = t.env.ACCOUNTS; let replaced = false;
    t.env.ACCOUNTS = new Proxy(database, { get(target, key) {
      if (key !== 'prepare') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
      return (query: string) => {
        const statement = target.prepare(query);
        if (!query.includes('FROM service_state s')) return statement;
        return { bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return { async first() {
            const row = await bound.first();
            if (!replaced) { replaced = true; t.db.set('adopt', replacement); }
            return row;
          } };
        } };
      };
    } });
    return () => { t.env.ACCOUNTS = database; };
  });
  try {
    const response = await req('/api/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wrongCode, expectedMode: 'delegate', applicationId: h.application.id }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'adoption_changed' } });
    expect(await inDO(h.id, t => t.db.get('adopt', null))).toEqual(replacement);
    expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n: 1 });
  } finally { await inDO(h.id, restore); }
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
