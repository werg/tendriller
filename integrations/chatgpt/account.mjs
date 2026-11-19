import { createOAuthVerifier, OAuthError } from './auth.mjs';
import { createHostAccountBrowser } from './account-browser.mjs';
import { abortable, canonical, fail, SCOPES } from './common.mjs';

const ID = /^[a-f0-9]{64}$/;
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);
function originUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    fail('HOST_ACCOUNT_CONFIGURATION_INVALID', 'The account host must be an exact trusted HTTPS origin');
  return url;
}
async function responseObject(response) {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    await response.body?.cancel();
    fail('HOST_ACCOUNT_UNAVAILABLE', 'The configured account host could not verify current authorization', { status: 503 });
  }
  const reader = response.body?.getReader(), chunks = []; let size = 0;
  if (!reader) fail('HOST_ACCOUNT_RESPONSE_INVALID', 'The account host returned no verification result', { status: 503 });
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 32768) fail('HOST_ACCOUNT_RESPONSE_INVALID', 'The account verification response exceeded its bound', { status: 503 });
      chunks.push(value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid result');
    return value;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.code) throw error;
    fail('HOST_ACCOUNT_RESPONSE_INVALID', 'The account verification response is invalid', { status: 503 });
  } finally { reader.releaseLock(); }
}

/** Real host-backed account mapping. No token email, application claim or model
 * argument can become ownership. All destinations come from private config. */
export function createTendrillerAccountAdapter({ origin, resource, bridgeId, bridgeSecret, applications = [],
  fetch: fetcher = globalThis.fetch, clock = Date.now, requestTimeoutMs = 10000,
  ...browserOptions } = {}) {
  const host = originUrl(origin), resourceUrl = new URL(resource);
  if (resourceUrl.protocol !== 'https:' || resourceUrl.username || resourceUrl.password || resourceUrl.search || resourceUrl.hash ||
      !boundedText(bridgeId) || typeof bridgeSecret !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(bridgeSecret) ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000 ||
      !Array.isArray(applications) || applications.length > 128)
    fail('HOST_ACCOUNT_CONFIGURATION_INVALID', 'Configure the exact MCP resource, registered bridge credential and bounded page mappings');
  const mapped = new Map(), lifetime = new AbortController();
  for (const app of applications) {
    if (!ID.test(app.id) || !boundedText(app.pageId) || mapped.has(app.id))
      fail('HOST_ACCOUNT_CONFIGURATION_INVALID', 'Each application needs its actual unique application ID and page ID');
    for (const name of ['allowedQueries', 'allowedCommands', 'allowedEvents'])
      if (app[name] !== undefined && (!Array.isArray(app[name]) || app[name].length > 128 || app[name].some(value => !boundedText(value))))
        fail('HOST_ACCOUNT_CONFIGURATION_INVALID', 'Application permissions must be explicit bounded name lists');
    mapped.set(app.id, structuredClone({ id: app.id, pageId: app.pageId, label: String(app.label ?? app.id).slice(0, 200),
      queries: app.allowedQueries ?? [], commands: app.allowedCommands ?? [], events: app.allowedEvents ?? [],
      allowEventDetails: app.allowEventDetails === true }));
  }
  async function post(path, body, { signal, form = false } = {}) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetcher(new URL(path, host).href, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${bridgeSecret}`, Accept: 'application/json',
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(body) : JSON.stringify(body) });
    } catch {
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      fail('HOST_ACCOUNT_UNAVAILABLE', 'Current account authorization could not be reached', { status: 503 });
    }
    const result = await responseObject(response); signal?.throwIfAborted(); return result;
  }
  function validPrincipal(principal) {
    return principal?.issuer === origin && boundedText(principal.id) &&
      (principal.expiresAt === undefined || Number.isFinite(principal.expiresAt) && principal.expiresAt > clock());
  }
  async function lookup(principal, applicationId) {
    if (!validPrincipal(principal)) return { active: false, access: false, owner: false, oauthAuthorized: false };
    const app = applicationId === undefined ? undefined : mapped.get(applicationId);
    if (applicationId !== undefined && !app) return { active: false, access: false, owner: false, oauthAuthorized: false };
    const result = await post('/oauth/account-access', { issuer: origin, subject: principal.id,
      ...(app ? { applicationId: app.id, pageId: app.pageId } : {}),
      ...(principal.oauthGrantId ? { grantId: principal.oauthGrantId } : {}),
      ...(principal.managementSessionId ? { managementSessionId: principal.managementSessionId } : {}),
    }, { signal: principal.requestSignal });
    if (typeof result.active !== 'boolean' || typeof result.access !== 'boolean' || typeof result.owner !== 'boolean' ||
        result.active && (result.account?.id !== principal.id || result.account?.issuer !== origin) ||
        app && (result.applicationId !== app.id || result.pageId !== app.pageId))
      fail('HOST_ACCOUNT_RESPONSE_INVALID', 'The account result does not match the configured identity and page', { status: 503 });
    return result;
  }
  const grantCurrent = (principal, result) => boundedText(principal.oauthGrantId) && result.oauthAuthorized === true &&
    Array.isArray(principal.scopes) && Array.isArray(result.scopes) && principal.scopes.every(scope => result.scopes.includes(scope));
  const verifier = createOAuthVerifier({ issuer: origin, resource, jwksUri: `${origin}/oauth/jwks`, scopesSupported: SCOPES, clock,
    fetch: (url, options = {}) => fetcher(url, { ...options, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(requestTimeoutMs), ...(options.signal ? [options.signal] : [])]) }),
  });
  const auth = { ...verifier, async authenticate(request, requiredScopes = []) {
    request.signal.throwIfAborted();
    const principal = await abortable(verifier.authenticate(request, requiredScopes), request.signal);
    const token = request.headers.get('Authorization').slice(7);
    const result = await post('/oauth/introspect', { token, token_type_hint: 'access_token' }, { signal: request.signal, form: true });
    const currentScopes = typeof result.scope === 'string' ? [...new Set(result.scope.split(' ').filter(Boolean))].sort() : null;
    if (result.active !== true || result.sub !== principal.id || result.iss !== origin || result.aud !== resource ||
        result.exp * 1000 !== principal.expiresAt || !boundedText(result.sid) ||
        canonical(currentScopes) !== canonical([...principal.scopes].sort()))
      throw new OAuthError('invalid_token', 'The Tendriller OAuth grant is no longer active', { challenge: verifier.challenge() });
    return { ...principal, oauthGrantId: result.sid };
  } };
  return {
    auth,
    close() { lifetime.abort(); },
    metadata: Object.freeze({ origin, resource, bridgeId }),
    async checkHostConfiguration({ signal, management = true } = {}) {
      const result = await post('/oauth/bridge-status', {}, { signal });
      const callback = resourceUrl.origin + (browserOptions.managementPath ?? '/connections') + '/callback';
      if (result.authorizationServerReady !== true || result.bridgeId !== bridgeId || result.resource !== resource ||
          !Array.isArray(result.applicationIds) || [...mapped.keys()].some(id => !result.applicationIds.includes(id)) ||
          management && (!Array.isArray(result.managementRedirectUris) || !result.managementRedirectUris.includes(callback)))
        fail('HOST_ACCOUNT_MAPPING_INCOMPLETE', 'Register this exact bridge, MCP resource, application IDs and management callback in the account host', { status: 503 });
      return { ready: true, authorizationServerReady: true, issuer: origin, resource, bridgeId, applications: [...mapped.keys()],
        managementCallback: management ? callback : null, liveChatGptVerified: false };
    },
    async authorizeAccountAccess(principal, applicationId) {
      const result = await lookup(principal, applicationId);
      return result.active === true && result.access === true && grantCurrent(principal, result);
    },
    async authorizeOwner(principal, applicationId) {
      const result = await lookup(principal, applicationId);
      return result.active === true && result.owner === true && (!principal.oauthGrantId || grantCurrent(principal, result));
    },
    async ownerEmailForPrincipal(principal) {
      const result = await lookup(principal);
      return result.active && grantCurrent(principal, result) && typeof result.account?.email === 'string' ? result.account.email : null;
    },
    async applicationsForPrincipal(principal) {
      const catalog = [];
      for (const app of mapped.values()) {
        const result = await lookup(principal, app.id);
        if (result.active && result.owner && (!principal.oauthGrantId || grantCurrent(principal, result))) catalog.push({ applicationId: app.id, label: app.label,
          queries: app.queries, commands: app.commands, events: app.events, allowEventDetails: app.allowEventDetails });
      }
      return catalog;
    },
    // The browser flow below shares this same fixed-origin credential and
    // current-account lookup; the credential is never sent to the browser.
    createBrowser: options => createHostAccountBrowser({ ...browserOptions, ...options, post, lookup, clock, origin, resourceOrigin: resourceUrl.origin, bridgeId }),
  };
}
