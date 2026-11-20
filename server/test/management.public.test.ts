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
  expect(html).toContain('value="control:write"> Update signed application control');
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
