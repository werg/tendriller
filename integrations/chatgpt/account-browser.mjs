import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from './common.mjs';

const SESSION = '__Host-tendriller-integration', PENDING = '__Host-tendriller-integration-login';
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
function cookie(request, name, pattern = TOKEN) {
  const values = (request.headers.get('Cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : null;
  return value && pattern.test(value) ? value : null;
}
const setCookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function redirect(location, cookies = []) {
  const result = new Response(null, { status: 303, headers: { ...headers, Location: location } });
  for (const value of cookies) result.headers.append('Set-Cookie', value);
  return result;
}
function records(state, now) {
  const data = state.chatgptBrowser ??= { sessions: {} };
  for (const [id, value] of Object.entries(data.sessions)) if (value.expiresAt <= now) delete data.sessions[id];
  return data;
}

/** One-time, browser-bound PKCE handoff from the actual Tendriller login. */
export function createHostAccountBrowser({ origin, resourceOrigin, bridgeId, post, lookup, store, clock = Date.now,
  managementPath = '/connections', sessionTtlMs = 3600000, maxSessions = 256 } = {}) {
  if (!store?.read || !store?.transaction || typeof post !== 'function' || typeof lookup !== 'function' ||
      typeof managementPath !== 'string' || !/^\/[A-Za-z0-9/_-]+$/.test(managementPath) || managementPath.endsWith('/') ||
      managementPath.startsWith('//') || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 10000 ||
      !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60000 || sessionTtlMs > 86400000)
    fail('HOST_BROWSER_CONFIGURATION_INVALID', 'Configure a private browser-session store, local management path and bounded lifetimes');
  const paths = { login: `${managementPath}/login`, callback: `${managementPath}/callback`, logout: `${managementPath}/logout` };
  const callback = resourceOrigin + paths.callback, authenticated = new WeakMap();
  // Pending login needs no durable reservation. A restart invalidates only
  // in-flight logins. The account host consumes the actual login code once.
  const loginKey = randomBytes(32);
  function sealLogin(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', loginKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  function openLogin(request) {
    const value = cookie(request, PENDING, /^[A-Za-z0-9_-]{100,512}$/u);
    if (!value) return null;
    try {
      const bytes = Buffer.from(value, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', loginKey, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    } catch { return null; }
  }
  async function authenticateBrowserSession(request) {
    if (authenticated.has(request)) return authenticated.get(request);
    const task = (async () => {
      const token = cookie(request, SESSION);
      if (!token) return null;
      const record = (await store.read()).chatgptBrowser?.sessions?.[sha(token)];
      if (!record || record.expiresAt <= clock() || !TOKEN.test(record.managementSessionId ?? '')) return null;
      const principal = { id: record.id, issuer: record.issuer, expiresAt: record.expiresAt,
        managementSessionId: record.managementSessionId, requestSignal: request.signal };
      const result = await lookup(principal);
      return result.active === true ? principal : null;
    })();
    authenticated.set(request, task); return task;
  }
  async function handleRequest(request) {
    const url = new URL(request.url);
    if (![managementPath, ...Object.values(paths)].includes(url.pathname)) return null;
    if (url.origin !== resourceOrigin) return new Response('Not found', { status: 404, headers });
    try {
      request.signal.throwIfAborted();
      if (url.pathname === managementPath) {
        if (!['GET', 'POST'].includes(request.method)) return null;
        if (!await authenticateBrowserSession(request)) return redirect(paths.login, [setCookie(SESSION, '', 0)]);
        return null;
      }
      if (url.pathname === paths.login && request.method === 'GET') {
        const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
        const binding = sealLogin({ state, verifier, expiresAt: clock() + 300000 });
        const target = new URL('/oauth/management/login', origin);
        target.search = new URLSearchParams({ client_id: bridgeId, redirect_uri: callback, state, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
        return redirect(target.href, [setCookie(PENDING, binding, 300)]);
      }
      if (url.pathname === paths.callback && request.method === 'GET') {
        if (url.search.length > 8192 || [...url.searchParams.keys()].some(key => !['code', 'state', 'iss', 'error'].includes(key) || url.searchParams.getAll(key).length !== 1))
          fail('HOST_LOGIN_INVALID', 'Invalid login handoff', { status: 400 });
        const state = url.searchParams.get('state'), pending = openLogin(request);
        if (!TOKEN.test(state ?? '') || pending?.state !== state || pending.expiresAt <= clock() || url.searchParams.get('iss') !== origin)
          fail('HOST_LOGIN_INVALID', 'Login expired, belongs to another browser, or used a different account host', { status: 403 });
        if (url.searchParams.get('error')) return new Response(`<!doctype html><title>Sign-in cancelled</title><h1>Sign-in cancelled</h1><p>No connection permissions were changed.</p><a href="${paths.login}">Start sign-in again</a>`,
          { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': setCookie(PENDING, '', 0) } });
        const code = url.searchParams.get('code');
        if (!TOKEN.test(code ?? '')) fail('HOST_LOGIN_INVALID', 'The account host returned an invalid login code');
        const linked = await post('/oauth/management/exchange', { code, redirect_uri: callback, code_verifier: pending.verifier }, { signal: request.signal });
        if (typeof linked.id !== 'string' || !linked.id || linked.id.length > 512 || /[\x00-\x20\x7f]/.test(linked.id) ||
            linked.issuer !== origin || !TOKEN.test(linked.managementSessionId ?? '') ||
            !Number.isSafeInteger(linked.expiresAt) || linked.expiresAt <= clock() || linked.expiresAt > clock() + 86400000)
          fail('HOST_LOGIN_INVALID', 'The account host returned an invalid session proof', { status: 503 });
        const principal = { id: linked.id, issuer: linked.issuer, managementSessionId: linked.managementSessionId, requestSignal: request.signal };
        if (!(await lookup(principal)).active) fail('HOST_LOGIN_INACTIVE', 'The Tendriller account is no longer active', { status: 403 });
        const token = randomBytes(32).toString('base64url'), expiresAt = Math.min(linked.expiresAt, clock() + sessionTtlMs);
        await store.transaction(value => {
          const data = records(value, clock()), previous = cookie(request, SESSION);
          if (previous) delete data.sessions[sha(previous)];
          if (Object.keys(data.sessions).length >= maxSessions) fail('HOST_SESSION_CAPACITY', 'Browser session capacity reached', { status: 503 });
          data.sessions[sha(token)] = { id: linked.id, issuer: origin, managementSessionId: linked.managementSessionId, expiresAt };
        });
        return redirect(managementPath, [setCookie(PENDING, '', 0), setCookie(SESSION, token, Math.floor((expiresAt - clock()) / 1000))]);
      }
      if (url.pathname === paths.logout && request.method === 'POST') {
        if (request.headers.get('Origin') !== resourceOrigin) fail('HOST_LOGOUT_ORIGIN_INVALID', 'Sign out requires the management origin', { status: 403 });
        const token = cookie(request, SESSION);
        if (token) await store.transaction(value => { delete records(value, clock()).sessions[sha(token)]; });
        return redirect(paths.login, [setCookie(SESSION, '', 0)]);
      }
      return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: url.pathname === paths.logout ? 'POST' : 'GET' } });
    } catch (error) {
      return Response.json({ error: typeof error.code === 'string' ? error.code : 'HOST_LOGIN_UNAVAILABLE',
        message: 'The Tendriller connection could not be verified. Restart sign-in or check the configured account host.' },
      { status: error.status ?? 503, headers });
    }
  }
  return {
    paths: Object.freeze({ ...paths, management: managementPath }), authenticateBrowserSession, handleRequest,
    wrapManagement(handler) {
      return async request => {
        const response = await handler(request);
        if (request.method !== 'GET' || response.status !== 200 || !response.headers.get('Content-Type')?.startsWith('text/html')) return response;
        const html = (await response.text()).replace('</body>', `<form method="post" action="${paths.logout}"><button type="submit">Sign out of connection management</button></form></body>`);
        const copied = new Headers(response.headers); copied.delete('Content-Length');
        return new Response(html, { status: response.status, headers: copied });
      };
    },
  };
}
