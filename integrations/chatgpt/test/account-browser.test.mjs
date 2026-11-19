import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHostAccountBrowser } from '../account-browser.mjs';
import { createMemoryStore } from '../store.mjs';

const HOST = 'https://accounts.tendriller.example', ORIGIN = 'https://assistant.example';
const SESSION = '__Host-tendriller-integration', PENDING = '__Host-tendriller-integration-login';
const tokenCookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + '=')).split(';')[0];
function fixture(options = {}) {
  let now = Date.now(), active = true, exchanges = 0, expectedChallenge, failExchange = false;
  const store = createMemoryStore();
  const browser = createHostAccountBrowser({ origin: HOST, resourceOrigin: ORIGIN, bridgeId: 'configured-bridge', store,
    clock: () => now, ...options,
    lookup: async principal => { assert.equal(principal.issuer, HOST); assert.equal(principal.managementSessionId, 'm'.repeat(43)); return { active }; },
    post: async (path, input) => {
      exchanges++; assert.equal(path, '/oauth/management/exchange');
      assert.equal(input.redirect_uri, `${ORIGIN}/connections/callback`);
      assert.equal(createHash('sha256').update(input.code_verifier).digest('base64url'), expectedChallenge);
      if (failExchange) throw Error('Private transport diagnostic');
      return { id: 'verified-owner', issuer: HOST, managementSessionId: 'm'.repeat(43), expiresAt: now + 900000 };
    },
  });
  const request = (path, cookies, init = {}) => new Request(ORIGIN + path, { ...init, headers: { ...init.headers, ...(cookies ? { Cookie: cookies } : {}) } });
  async function begin(previousCookie) {
    const response = await browser.handleRequest(request('/connections/login', previousCookie));
    if (response.status !== 303) return { response };
    const target = new URL(response.headers.get('Location'));
    expectedChallenge = target.searchParams.get('code_challenge');
    return { response, target, binding: tokenCookie(response, PENDING), state: target.searchParams.get('state') };
  }
  const callbackPath = login => '/connections/callback?' + new URLSearchParams({ state: login.state, code: 'c'.repeat(43), iss: HOST });
  return { browser, store, request, begin, callbackPath, exchanges: () => exchanges,
    active: value => { active = value; }, advance: ms => { now += ms; }, failExchange: () => { failExchange = true; } };
}

test('browser-bound PKCE handoff produces only an opaque private session and checks current account on use', async () => {
  const f = fixture(), login = await f.begin();
  assert.equal(login.target.origin, HOST); assert.equal(login.target.pathname, '/oauth/management/login');
  assert.equal(login.target.searchParams.get('client_id'), 'configured-bridge');
  assert.equal(login.target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(login.response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const response = await f.browser.handleRequest(f.request(f.callbackPath(login), login.binding));
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/connections');
  const session = tokenCookie(response, SESSION);
  const principal = await f.browser.authenticateBrowserSession(f.request('/connections', session));
  assert.equal(principal.id, 'verified-owner'); assert.equal(principal.issuer, HOST);
  const saved = JSON.stringify(await f.store.read());
  assert.equal(saved.includes(session.split('=')[1]), false); assert.equal(saved.includes(login.state), false); assert.equal(saved.includes('c'.repeat(43)), false);
  assert.equal(await f.browser.handleRequest(f.request('/connections', session)), null);
  f.active(false);
  assert.equal(await f.browser.authenticateBrowserSession(f.request('/connections', session)), null);
  assert.equal((await f.browser.handleRequest(f.request('/connections', session))).headers.get('Location'), '/connections/login');
});

test('a different browser, wrong issuer and consumed handoff cannot redeem a login code', async () => {
  const f = fixture(), login = await f.begin();
  const wrongBrowser = await f.browser.handleRequest(f.request(f.callbackPath(login), `${PENDING}=${'x'.repeat(43)}`));
  assert.equal(wrongBrowser.status, 403); assert.equal(f.exchanges(), 0);
  const wrongIssuer = await f.browser.handleRequest(f.request(f.callbackPath(login).replace(encodeURIComponent(HOST), encodeURIComponent('https://attacker.example')), login.binding));
  assert.equal(wrongIssuer.status, 403); assert.equal(f.exchanges(), 0);
  assert.equal((await f.browser.handleRequest(f.request(f.callbackPath(login), login.binding))).status, 303);
  assert.equal((await f.browser.handleRequest(f.request(f.callbackPath(login), login.binding))).status, 403);
  assert.equal(f.exchanges(), 1);
  const lost = await f.begin(); f.failExchange();
  const failure = await f.browser.handleRequest(f.request(f.callbackPath(lost), lost.binding));
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /Private transport/);
  assert.equal((await f.browser.handleRequest(f.request(f.callbackPath(lost), lost.binding))).status, 403);
});

test('management logout is same-origin, sessions expire, and denial requires a deliberate new login', async () => {
  const f = fixture(), login = await f.begin();
  const response = await f.browser.handleRequest(f.request(f.callbackPath(login), login.binding));
  const session = tokenCookie(response, SESSION);
  assert.equal((await f.browser.handleRequest(f.request('/connections/logout', session, { method: 'POST', headers: { Origin: 'https://attacker.example' } }))).status, 403);
  assert.ok(await f.browser.authenticateBrowserSession(f.request('/connections', session)));
  f.advance(900001);
  assert.equal(await f.browser.authenticateBrowserSession(f.request('/connections', session)), null);
  const second = await f.begin(), linked = await f.browser.handleRequest(f.request(f.callbackPath(second), second.binding));
  const latest = tokenCookie(linked, SESSION);
  assert.equal((await f.browser.handleRequest(f.request('/connections/logout', latest, { method: 'POST', headers: { Origin: ORIGIN } }))).status, 303);
  assert.equal(await f.browser.authenticateBrowserSession(f.request('/connections', latest)), null);
  const denied = await f.begin();
  const cancelled = await f.browser.handleRequest(f.request('/connections/callback?' + new URLSearchParams({ state: denied.state, error: 'access_denied', iss: HOST }), denied.binding));
  assert.equal(cancelled.status, 200); assert.equal(cancelled.headers.get('Location'), null); assert.match(await cancelled.text(), /Start sign-in again/);
});

test('login reservations are bounded, expire, and do not accept duplicate security parameters', async () => {
  const f = fixture({ maxPending: 1 }), first = await f.begin();
  assert.equal((await f.begin()).response.status, 503);
  assert.equal((await f.browser.handleRequest(f.request(f.callbackPath(first) + '&state=duplicate', first.binding))).status, 400);
  f.advance(300001); assert.equal((await f.begin()).response.status, 303);
  const unrelated = await f.browser.handleRequest(f.request('/mcp')); assert.equal(unrelated, null);
  const wrapper = f.browser.wrapManagement(async () => new Response('<body>Settings</body>', { headers: { 'Content-Type': 'text/html' } }));
  assert.match(await (await wrapper(f.request('/connections'))).text(), /action="\/connections\/logout"/);
});
