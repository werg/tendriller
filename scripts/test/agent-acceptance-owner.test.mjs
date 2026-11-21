import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { Owner, ownerUrl, mcpBridge } from '../agent-acceptance/owner.mjs';
import { browserMeasurement } from '../agent-acceptance/observer.mjs';

test('owner rejects credential-bearing and cross-origin navigation', () => {
  const origin = 'https://selected.example';
  for (const url of ['https://other.example/', 'https://user:pass@selected.example/', origin + '/auth/test#token=secret'])
    assert.throws(() => ownerUrl(origin, url), /exact service origin/);
  assert.equal(ownerUrl(origin, origin + '/t/app'), origin + '/t/app');
});

test('bounded local Chromium owner: login, exact review, checklist interaction, reload and page reopen',
  { skip: process.env.TENDRILLER_ACCEPTANCE_BROWSER !== '1' ? 'Set TENDRILLER_ACCEPTANCE_BROWSER=1 for the bounded real-browser owner test' : false }, async t => {
  const fixture = `<!doctype html><form method="post" action="/dashboard"><label>Token<input name="token"></label><button>Open test account</button></form>
  <p>Fingerprint ABCD</p><p>Rights: checklist write</p><p>Retained prefix: 12</p><a href="/review">Review exact request</a>
  <label><input type="checkbox">Allow checklist</label><button onclick="document.querySelector('output').textContent='Approved'">Approve</button><output></output>
  <label>New item<input id="new"></label><button onclick="localStorage.item=document.querySelector('#new').value;document.querySelector('#list').textContent=localStorage.item">Add</button>
  <div id="list"></div><input id="measured-device" value="${'11'.repeat(32)}"><ul id="measured-rows"><li><label><input data-item-id="row-1">Measured marker</label></li></ul>
  <details><summary>Owned recovery</summary><button>Explicit recovery action</button></details>
  <script>document.querySelector('#list').textContent=localStorage.item||'';window.tendril={identity:{page:'fixture',publication:'pub',version:1}}</script>`;
  const server = createServer((req, res) => res.end(fixture));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext(); context.setDefaultTimeout(1000);
  const origin = `http://127.0.0.1:${server.address().port}`, records = [];
  const owner = new Owner({ context, access: { origin, loginUrl: origin + '/auth/test', code: 'local-fixture-only' }, record: value => records.push(value) });
  await owner.login();
  await owner.act({ action: 'open-details', name: 'Owned recovery' });
  await owner.act({ action: 'open-details', name: 'Owned recovery' });
  assert.equal(await owner.page.locator('details').evaluate(node => node.open), true);
  await assert.rejects(owner.act({ action: 'open-details', name: 'Wrong recovery' }), /exact visible/);
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
  const measured = await browserMeasurement(owner, { handle: { id: 'fixture', page_url: owner.page.url() },
    browser: { device: { selector: '#measured-device', read: 'value' }, rows: '#measured-rows li', rowIdentityAttribute: 'data-item-id', rowIdentitySelector: 'input' } });
  assert.deepEqual(measured.rowIds, ['row-1']); assert(measured.rows[0].includes('Measured marker'));
  const inspection = await owner.act({ action: 'inspect' });
  assert(inspection.view.links.some(link => link.name === 'Review exact request'));
  assert(!inspection.view.inputs.some(input => input.name === 'token'));
  const original = owner.page;
  await owner.act({ action: 'open-link', name: 'Review exact request' }); assert.notEqual(owner.page, original);
  await owner.act({ action: 'return-page' }); assert.equal(owner.page, original);
  await owner.act({ action: 'wait', selector: '#new', condition: 'enabled', timeoutMs: 1000 });
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
  actions.length = 0; input.permissions = [];
  await owner.act(input); assert.deepEqual(actions, ['fingerprint', 'rights', 'correct prefix', 'approve']);
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

test('concurrent MCP 401s renew once and replay identical buffered bodies and protocol headers', async t => {
  const entered = Promise.withResolvers(), renewed = Promise.withResolvers(), calls = [];
  let renewals = 0;
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired',
    freshToken: async ({ signal }) => { renewals++; assert(!signal.aborted); await renewed.promise; return 'fresh'; },
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, headers: { ...options.headers }, body: options.body.toString() });
      if (calls.filter(call => call.headers.authorization === 'Bearer expired').length === 3) entered.resolve();
      return options.headers.authorization === 'Bearer expired' ? new Response('Unauthorized', { status: 401 })
        : new Response(JSON.stringify({ result: { tools: [{ name: 'actual_source_tool' }] } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'actual-session' } });
    } });
  t.after(() => bridge.close());
  const bodies = [1, 2, 3].map(id => ` { "id": ${id}, "method": "tools/list" }\n`);
  const requests = bodies.map(body => fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
    'mcp-session-id': 'same-session', 'mcp-protocol-version': '2025-06-18', 'last-event-id': 'event-4' }, body }));
  await entered.promise; renewed.resolve();
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.equal(response.headers.get('mcp-session-id'), 'actual-session');
    assert.deepEqual((await response.json()).result.tools, [{ name: 'actual_source_tool' }]);
  }
  assert.equal(renewals, 1); assert.equal(calls.length, 6);
  for (const body of bodies) {
    const attempts = calls.filter(call => call.body === body);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(call => call.headers.authorization), ['Bearer expired', 'Bearer fresh']);
    const omitAuth = ({ authorization, ...headers }) => headers;
    assert.deepEqual(omitAuth(attempts[0].headers), omitAuth(attempts[1].headers));
    assert.equal(attempts[0].method, attempts[1].method); assert.equal(attempts[0].url, attempts[1].url);
  }
});

test('a delayed old-token 401 reuses the already renewed credential without another OAuth flow', async t => {
  const slowSent = Promise.withResolvers(), releaseSlow = Promise.withResolvers(); let renewals = 0;
  const calls = [];
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired', freshToken: async () => { renewals++; return 'fresh'; },
    fetch: async (_url, options) => {
      const body = options.body.toString(); calls.push([body, options.headers.authorization]);
      if (options.headers.authorization === 'Bearer expired') {
        if (body === 'slow') { slowSent.resolve(); await releaseSlow.promise; }
        return new Response('', { status: 401 });
      }
      return new Response(body);
    } });
  t.after(() => bridge.close());
  const slow = fetch(bridge.url, { method: 'POST', body: 'slow' }); await slowSent.promise;
  assert.equal(await (await fetch(bridge.url, { method: 'POST', body: 'fast' })).text(), 'fast');
  releaseSlow.resolve(); assert.equal(await (await slow).text(), 'slow');
  assert.equal(renewals, 1); assert.equal(calls.length, 4);
});

test('MCP 403, tool errors and non-auth failures never renew; a second 401 is forwarded unchanged', async t => {
  for (const status of [403, 200, 503, 401]) await t.test(String(status), async () => {
    let calls = 0, renewals = 0;
    const body = status === 200 ? '{"isError":true,"content":[{"text":"tool denied"}]}' : 'source rejection';
    const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'old', freshToken: async () => { renewals++; return 'new'; },
      fetch: async () => { calls++; return new Response(body, { status, headers: { 'www-authenticate': 'Bearer resource_metadata="https://selected.example/resource"' } }); } });
    try {
      const response = await fetch(bridge.url, { method: 'POST', body: '{"method":"tools/call"}' });
      assert.equal(response.status, status); assert.equal(await response.text(), body);
      assert.equal(calls, status === 401 ? 2 : 1); assert.equal(renewals, status === 401 ? 1 : 0);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer resource_metadata="https://selected.example/resource"');
    } finally { await bridge.close(); }
  });
});

test('renewal failure does not replay or expose diagnostics', async t => {
  let calls = 0;
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired',
    freshToken: async () => { throw Error('PRIVATE_OAUTH_DIAGNOSTIC'); },
    fetch: async () => { calls++; return new Response('', { status: 401 }); } });
  t.after(() => bridge.close());
  const response = await fetch(bridge.url, { method: 'POST', body: 'same-command' });
  assert.equal(response.status, 502); assert(!(await response.text()).includes('PRIVATE_OAUTH_DIAGNOSTIC')); assert.equal(calls, 1);
});

test('renewal timeout bounds callbacks that ignore cancellation', { timeout: 5000 }, async t => {
  let signal;
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired', renewalTimeoutMs: 25,
    freshToken: options => { signal = options.signal; return new Promise(() => {}); }, fetch: async () => new Response('', { status: 401 }) });
  t.after(() => bridge.close());
  const response = await fetch(bridge.url, { method: 'POST', body: 'same-command' });
  assert.equal(response.status, 502); await response.text(); assert(signal.aborted);
});

test('bridge close aborts a pending renewal and prevents late credential installation', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers(), late = Promise.withResolvers(); let signal;
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired', freshToken: options => {
    signal = options.signal; entered.resolve(); return late.promise;
  }, fetch: async () => new Response('', { status: 401 }) });
  const pending = fetch(bridge.url, { method: 'POST', body: 'same-command' }).then(response => response.text(), () => null);
  await entered.promise; await bridge.close(); assert(signal.aborted);
  late.resolve('too-late'); await pending;
  assert.throws(() => bridge.refresh('never-install-after-close'));
  await bridge.close();
});

test('one disconnected client does not cancel a renewal still needed by another request', { timeout: 5000 }, async t => {
  const bothSent = Promise.withResolvers(), renewed = Promise.withResolvers(); let signal, renewals = 0, oldCalls = 0, retries = 0;
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired', freshToken: options => {
    renewals++; signal = options.signal; return renewed.promise;
  }, fetch: async (_url, options) => {
    if (options.headers.authorization === 'Bearer expired') { if (++oldCalls === 2) bothSent.resolve(); return new Response('', { status: 401 }); }
    retries++; return new Response('unchanged command result');
  } });
  t.after(() => bridge.close());
  const abort = new AbortController();
  const first = fetch(bridge.url, { method: 'POST', body: 'first', signal: abort.signal }).catch(() => null);
  const second = fetch(bridge.url, { method: 'POST', body: 'second' });
  await bothSent.promise; abort.abort(); await first;
  await new Promise(resolve => setTimeout(resolve, 20)); // Let the server observe the closed client socket.
  assert(!signal.aborted); renewed.resolve('fresh');
  assert.equal(await (await second).text(), 'unchanged command result'); assert.equal(renewals, 1); assert.equal(retries, 1);
});

test('request cancellation aborts an OAuth flow once its last waiter disconnects', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const bridge = await mcpBridge({ origin: 'https://selected.example', token: 'expired', freshToken: ({ signal }) => {
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); entered.resolve(); return new Promise(() => {});
  }, fetch: async () => new Response('', { status: 401 }) });
  t.after(() => bridge.close());
  const abort = new AbortController();
  const pending = fetch(bridge.url, { method: 'POST', body: 'same-command', signal: abort.signal }).catch(() => null);
  await entered.promise; abort.abort(); await pending; await cancelled.promise;
});

test('Owner renewal closes only its OAuth page on cancellation or authorization failure', { timeout: 5000 }, async () => {
  for (const failure of [false, true]) {
    let oauthCloses = 0;
    const entered = Promise.withResolvers(), oauthPage = { close: async () => { oauthCloses++; } };
    const owner = new Owner({ context: { newPage: async () => oauthPage, request: {} }, access: {}, authorize: async context => {
      await context.newPage(); entered.resolve();
      if (failure) throw Error('Synthetic authorization failure');
      return new Promise(() => {});
    } });
    owner.page = { close: () => { throw Error('Must not close the owner app page'); } };
    const abort = new AbortController();
    const result = assert.rejects(owner.freshToken({ signal: abort.signal }));
    await entered.promise; if (!failure) abort.abort(); await result;
    assert.equal(oauthCloses, 1);
  }
});
