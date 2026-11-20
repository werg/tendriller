import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const record = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const secret = new URL(record.url).hash.slice(1);
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto(record.url);
  assert.equal(new URL(page.url()).hash, '');
  await page.getByRole('button', { name: 'Open test account' }).click();
  await page.waitForURL(record.origin + '/dashboard');
  const me = await context.request.get(record.origin + '/auth/me');
  assert.equal((await me.json()).accountId, record.accountId);
  assert.ok(requests.every(url => !url.includes(secret) && !url.includes(new URLSearchParams(secret).get('token'))));
  const cookie = (await context.cookies()).find(cookie => cookie.name === '__Host-tendriller');
  assert.ok(cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
  const logout = await context.request.post(record.origin + '/auth/logout', { headers: { Origin: record.origin } });
  assert.ok(logout.ok());
  assert.equal((await context.request.get(record.origin + '/auth/me')).status(), 401);
  console.log('Live test link verified through Chromium: fragment cleared, token excluded from request URLs, account session and logout work.');
} finally {
  await browser.close();
}
