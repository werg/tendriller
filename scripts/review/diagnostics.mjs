// Public evidence is a closed vocabulary. Never retain URLs, headers, tokens, bodies, console/error text or traces.
const steps = new Set(['launch-browser', 'open-login', 'fill-login', 'submit-login', 'wait-dashboard', 'open-claimed-page',
  'wait-signed-page', 'verify-publication', 'open-agent-options', 'connect-hosted-mcp', 'wait-hosted-connection', 'verify-connection-after-reload',
  'authorize-account', 'initialize-browser', 'admit-agent', 'start-participant']);
const names = new Set(['Error', 'TimeoutError', 'AssertionError', 'TypeError', 'RangeError', 'AbortError', 'SyntaxError']);
const errorCodes = new Set(['quota','rate_limited','invalid_test_access','wrong_owner','owner_verification_required','account_deleting','claimed','application_not_found','forbidden','unavailable','read_only','creation_paused','not_found','invalid_code','invalid_confirmation','grant_not_found','agent_handle_in_use','member_key_proof_required','mcp_oauth_unavailable','membership_head_changed']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']);
const nativeCodes = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_ASSERTION',
  'ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'APPLICATION_SESSION_CLOSED', 'PEER_RECOVERING']);
export function reviewNativeError(log, exitCode) {
  const code = log.match(/code: ['"]([a-zA-Z0-9_]+)['"]/)?.[1];
  if (code) return nativeCodes.has(code) ? code : 'REDACTED_NATIVE_ERROR';
  return Number.isInteger(exitCode) ? 'EXIT_' + exitCode : undefined;
}
export const reviewError = error => ({ name: names.has(error?.name) ? error.name : 'Error',
  ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}),
  ...(error?.code === 'ERR_ASSERTION' ? { assertion: true } : {}) });
export function createReviewDiagnostics({ origin, pageUrl, apiUrl, now = Date.now }) {
  const startedAt = now(), history = [], responses = [], requestFailureCodes = [], counts = { pageErrors: 0, consoleErrors: 0, consoleWarnings: 0, requestFailures: 0 };
  let current, surface;
  const pending = new Set();
  const bump = key => { counts[key] = Math.min(1000000, counts[key] + 1); };
  const route = input => {
    try {
      const url = new URL(input);
      if (url.protocol === 'about:') return 'blank';
      if (url.origin === new URL(pageUrl).origin && url.pathname === new URL(pageUrl).pathname) return 'fixture-page';
      if (url.origin === new URL(pageUrl).origin && url.pathname.startsWith(new URL(pageUrl).pathname + '_tendril/mcp/')) return 'hosted-mcp';
      if (url.origin !== origin) return 'other-origin';
      if (url.pathname === '/auth/test') return 'test-login';
      if (url.pathname === '/dashboard') return 'dashboard';
      if (url.pathname.startsWith(new URL(apiUrl).pathname + '/')) return 'fixture-api';
      if (url.pathname.startsWith('/runtime/')) return 'runtime';
      if (url.pathname === '/auth/page') return 'page-auth-broker';
      if (url.pathname.startsWith('/auth')) return 'authentication';
      return 'other-service';
    } catch { return 'unknown'; }
  };
  const response = (url, status, method = 'GET') => {
    if (!Number.isInteger(status) || status < 100 || status > 599) return;
    const entry = { route: route(url), method: methods.has(method) ? method : 'other', status };
    responses.push(entry);
    if (responses.length > 24) responses.shift();
    return entry;
  };
  return {
    step(value) {
      if (!steps.has(value)) throw Error('UNKNOWN_REVIEW_DIAGNOSTIC_STEP');
      current = value; history.push({ step: value, elapsedMs: Math.max(0, now() - startedAt) }); if (history.length > 24) history.shift();
    },
    attach(context, page) {
      context.on('response', value => {
        const entry = response(value.url(), value.status(), value.request().method());
        if (!entry || entry.status < 400 || !['page-auth-broker','test-login','hosted-mcp','fixture-page'].includes(entry.route)) return;
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); });
        const task = Promise.race([Promise.resolve().then(() => value.json()).catch(() => null), timeout]).then(body => {
          const error = body?.error;
          if (errorCodes.has(error?.code)) entry.errorCode = error.code;
          if (entry.errorCode === 'quota' && Number.isSafeInteger(error.limit) && error.limit >= 0 && error.limit <= 1000000000) entry.limit = error.limit;
        }).finally(() => { clearTimeout(timer); pending.delete(task); });
        pending.add(task);
      });
      context.on('requestfailed', req => {
        bump('requestFailures');
        const text = req?.failure?.()?.errorText ?? '';
        const code = /^net::ERR_[A-Z0-9_]{1,64}$/.exec(text)?.[0];
        if (code && requestFailureCodes.length < 16) requestFailureCodes.push({ route: route(req.url()), code });
      });
      page.on('pageerror', () => { bump('pageErrors'); });
      page.on('console', value => { if (value.type() === 'error') bump('consoleErrors'); if (value.type() === 'warning') bump('consoleWarnings'); });
    },
    response,
    async capture(page) {
      await Promise.allSettled([...pending]);
      const count = async locator => { try { return await locator.count(); } catch { return null; } };
      surface = { route: route(page.url()), closed: page.isClosed(),
        loginForm: await count(page.locator('input[name=token]')),
        signedHeading: await count(page.getByRole('heading', { name: 'Review checklist', exact: true })),
        connectButtons: await count(page.getByRole('button', { name: 'Connect to this page', exact: true })),
        hostedConnections: await count(page.getByText('Connected as @', { exact: false })) };
    },
    snapshot() { return structuredClone({ step: current, elapsedMs: Math.max(0, now() - startedAt), history, counts, responses, ...(requestFailureCodes.length ? { requestFailureCodes } : {}), surface }); },
  };
}
