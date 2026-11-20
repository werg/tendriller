import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { Owner, ownerUrl, mcpBridge } from '../agent-acceptance/owner.mjs';

test('owner rejects credential-bearing and cross-origin navigation', () => {
  const origin = 'https://selected.example';
  for (const url of ['https://other.example/', 'https://user:pass@selected.example/', origin + '/auth/test#token=secret'])
    assert.throws(() => ownerUrl(origin, url), /exact service origin/);
  assert.equal(ownerUrl(origin, origin + '/t/app'), origin + '/t/app');
});

test('bounded local Chromium owner: login, exact review, checklist interaction, reload and page reopen',
  { skip: process.env.TENDRILLER_ACCEPTANCE_BROWSER !== '1' ? 'Set TENDRILLER_ACCEPTANCE_BROWSER=1 for the bounded real-browser owner test' : false }, async t => {
  const fixture = `<!doctype html><form method="post" action="/dashboard"><label>Token<input name="token"></label><button>Open test account</button></form>
  <p>Fingerprint ABCD</p><p>Rights: checklist write</p><p>Retained prefix: 12</p>
  <label><input type="checkbox">Allow checklist</label><button onclick="document.querySelector('output').textContent='Approved'">Approve</button><output></output>
  <label>New item<input id="new"></label><button onclick="localStorage.item=document.querySelector('#new').value;document.querySelector('#list').textContent=localStorage.item">Add</button>
  <div id="list"></div><script>document.querySelector('#list').textContent=localStorage.item||''</script>`;
  const server = createServer((req, res) => res.end(fixture));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext(); context.setDefaultTimeout(1000);
  const origin = `http://127.0.0.1:${server.address().port}`, records = [];
  const owner = new Owner({ context, access: { origin, loginUrl: origin + '/auth/test', code: 'local-fixture-only' }, record: value => records.push(value) });
  await owner.login();
  await assert.rejects(owner.act({ action: 'review', expected: ['a', 'b', 'c'], permissions: ['Allow checklist'], button: 'Approve' }), /exact visible/);
  await assert.rejects(owner.act({ action: 'review', expected: { fingerprint: 'Wrong', rights: 'Rights: checklist write', retainedPrefix: 'Retained prefix: 12' }, permissions: ['Allow checklist'], button: 'Approve' }));
  assert.equal(await owner.page.getByRole('checkbox').isChecked(), false);
  await owner.act({ action: 'review', expected: { fingerprint: 'Fingerprint ABCD', rights: 'Rights: checklist write', retainedPrefix: 'Retained prefix: 12' }, permissions: ['Allow checklist'], button: 'Approve' });
  assert.equal(await owner.page.locator('output').innerText(), 'Approved');
  await owner.act({ action: 'fill', label: 'New item', value: 'Owner local test' });
  await owner.act({ action: 'click', name: 'Add' });
  for (const action of ['reload', 'reopen']) {
    const result = await owner.act({ action }); assert(result.text.includes('Owner local test'));
  }
  assert(!JSON.stringify(records).includes('local-fixture-only'));
  await assert.rejects(owner.act({ action: 'evaluate', script: 'state=fake' }), /Unsupported/);
});

test('owner review does not approve until every exact visible field has matched', async () => {
  const actions = [];
  const page = {
    getByText: (text, options) => ({ waitFor: async () => { assert(options.exact); actions.push(text); if (text === 'wrong prefix') throw Error('Visible prefix mismatch'); } }),
    getByRole: (role, options) => ({ check: async () => { actions.push(role + ':' + options.name); }, click: async () => actions.push('approve') }),
    url: () => 'https://selected.example/review', locator: () => ({ innerText: async () => 'Visible review' }),
  };
  const owner = new Owner({ context: {}, access: { origin: 'https://selected.example' } }); owner.page = page;
  const input = { action: 'review', expected: { fingerprint: 'fingerprint', rights: 'rights', retainedPrefix: 'wrong prefix' }, permissions: ['Selected permission'], button: 'Approve' };
  await assert.rejects(owner.act(input), /prefix mismatch/);
  assert.deepEqual(actions, ['fingerprint', 'rights', 'wrong prefix']);
  actions.length = 0; input.expected.retainedPrefix = 'correct prefix';
  await owner.act(input);
  assert.deepEqual(actions, ['fingerprint', 'rights', 'correct prefix', 'checkbox:Selected permission', 'approve']);
});

test('MCP bridge preserves selected-origin tools and uses refreshed account bearer on each request', async t => {
  const calls = [], payload = JSON.stringify({ result: { tools: [{ name: 'source_tool', inputSchema: { type: 'object' } }] } });
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'FIRST_PRIVATE_TOKEN', fetch: async (url, options) => {
    calls.push({ url, ...options }); return new Response(payload, { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => bridge.close());
  for (const token of ['FIRST_PRIVATE_TOKEN', 'REFRESHED_PRIVATE_TOKEN']) {
    bridge.refresh(token);
    const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer CLIENT_MUST_NOT_OVERRIDE' }, body: '{"method":"tools/list"}' });
    assert.equal(await response.text(), payload);
  }
  assert(calls.every(call => call.url === 'https://selected.example/mcp' && call.redirect === 'error'));
  assert.deepEqual(calls.map(call => call.headers.authorization), ['Bearer FIRST_PRIVATE_TOKEN', 'Bearer REFRESHED_PRIVATE_TOKEN']);
  assert.equal((await fetch(new URL('/wrong', bridge.url))).status, 404);
});
