import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { route } from '../src/router';
import { sha256Hex } from '../src/ids';
import { activeAccount } from '../src/accounts/oauth-data';
import type { Env } from '../src/env';

it('test links create ordinary isolated sessions and revoke on disable or expiry', async () => {
  const account = 'test_' + 'a'.repeat(32), token = 'b'.repeat(43), now = Date.now();
  const access = { accountId: account, tokenSha256: await sha256Hex(token), expiresAt: now + 86400000 };
  const settings: Env = { ...env, TEST_ACCESS_JSON: JSON.stringify(access) };
  const request = (path: string, init: RequestInit = {}, target = settings) =>
    route(new Request('https://tendriller.dev' + path, init), target);
  const post = (value = token, origin = 'https://tendriller.dev') => request('/auth/test', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: value }),
  });
  expect((await request('/auth/test', {}, { ...settings, TEST_ACCESS_JSON: undefined })).status).toBe(404);
  expect((await post(token, 'https://other.example')).status).toBe(403);
  expect((await post('c'.repeat(43))).status).toBe(401);
  const loginPage = await request('/auth/test');
  expect(loginPage.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(loginPage.headers.get('Cache-Control')).toBe('no-store');
  expect(await loginPage.text()).not.toContain(token);
  expect((await post()).status).toBe(403);
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, now, 'review@example.invalid'),
    env.ACCOUNTS.prepare('INSERT INTO identities(provider,subject,account_id,login,created_at) VALUES(?,?,?,?,?)')
      .bind('test', account, account, 'Sample account', now),
  ]);
  const login = await post();
  expect(login.status).toBe(303);
  expect(login.headers.get('Cache-Control')).toBe('no-store');
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  expect(login.headers.get('Set-Cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
  const me = await request('/auth/me', { headers: { Cookie: cookie } });
  expect((await me.json() as { accountId: string }).accountId).toBe(account);
  expect((await request('/auth/link/github', { headers: { Cookie: cookie } })).status).toBe(403);
  expect(await activeAccount(settings, account)).toBe(true);
  const disabled = { ...settings, TEST_ACCESS_JSON: undefined };
  expect((await request('/auth/me', { headers: { Cookie: cookie } }, disabled)).status).toBe(401);
  expect(await activeAccount(disabled, account)).toBe(false);
  const expired = { ...settings, TEST_ACCESS_JSON: JSON.stringify({ ...access, expiresAt: now - 1 }) };
  expect((await request('/auth/test', {}, expired)).status).toBe(404);
  expect((await request('/auth/me', { headers: { Cookie: cookie } }, expired)).status).toBe(401);
  expect(await activeAccount(expired, account)).toBe(false);
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(now, account).run();
  expect((await post()).status).toBe(403);
});
