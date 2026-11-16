import { expect, it } from 'vitest';
import { apiJson, publishFilesJson, create, inDO, ownerHeaders, req } from './helpers';

it('serves recovery independently of authored code and enforces owner and origin boundaries', async () => {
  const h = await create();
  const url = h.page_url + '_tendril/manage';
  const response = await req(url);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).toContain('Create connection code');
  expect(html).not.toContain('tendril.js');
  expect(html).not.toContain('<script');
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const foreign = await req(url, { method: 'POST', headers: { ...ownerHeaders(url), ...form, Origin: 'https://other.example' }, body: 'action=connect-agent' });
  expect(foreign.status).toBe(403);
  const connected = await req(url, { method: 'POST', headers: form, body: 'action=connect-agent' });
  expect(connected.status).toBe(200);
  expect(await connected.text()).toContain('one-time code');
  expect(await inDO(h.id, t => t.db.get<any>('adopt', null))).toMatchObject({ attempts: 0 });

  const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
  const displayURL = display.url + '_tendril/manage';
  const displayPage = await req(displayURL, { anonymous: true });
  expect(await displayPage.text()).not.toContain('name="agent"');
  const denied = await req(displayURL, { anonymous: true, method: 'POST', headers: { ...form, Origin: new URL(displayURL).origin }, body: 'action=connect-agent' });
  expect(denied.status).toBe(403);
});

it('recovers page files without reverting application data and rejects stale selection forms', async () => {
  const h = await create();
  for (const title of ['First', 'Second']) await publishFilesJson(h, { 'index.html': `<!doctype html><title>${title}</title>` });
  await apiJson(h, 'PATCH', 'state', { cid: 'fresh-work', expected_generations: {}, ops: [{ op: 'set', path: ['notes'], value: 'Retain current work' }] });
  const submit = (body: string) => req(h.page_url + '_tendril/manage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const stale = await submit('action=select-version&head_revision=1&version=1');
  expect(stale.status).toBe(409);
  const restored = await submit('action=select-version&head_revision=2&version=1');
  expect(restored.status).toBe(200);
  expect(await inDO(h.id, t => t.db.get('current', 0))).toBe(1);
  expect((await apiJson(h, 'GET', 'state')).state).toEqual({ notes: 'Retain current work' });
});
