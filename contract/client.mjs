import { assertValid, CONTRACT_VERSION, validate } from './index.mjs';
import { createPeersClient, PEER_RENDEZVOUS_PROTOCOL } from './peers.mjs';
import { createAgentHub } from './hub.mjs';
export { createAgentHub, HUB_PROTOCOL, HUB_LIMITS, HUB_PATHS, HubError, validateHubPath } from './hub.mjs';
export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message || `HTTP ${status}`);
    this.name = "TendrilApiError";
    this.status = status;
    this.code = error?.code || "http_error";
    this.details = error?.details;
    this.error = error;
  }
}


function checked(schema, value, status) {
  const details = validate(schema, value);
  if (details.length) throw new ApiError(status, { code: "invalid_response", message: `The service response does not match ${schema}`, details });
  return value;
}

const AGENT_TOKEN = /^ta_[a-z2-7]{32}$/;
const PAGE_ID = /^[a-z2-7]{12}$/;
const parse = async response => {
  const text = await response.text();
  try { return text ? JSON.parse(text) : undefined; }
  catch { throw new ApiError(response.status, { code: "invalid_response", message: "The service returned a non-JSON response" }); }
};

/** Unauthenticated agent registration. The owner claims the agent by signing in to a page it created. */
export async function registerAgent(service, body, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  return credential(service, '/api/agents', assertValid('agentRegistration', body), fetcher, signal);
}
/** Join the inviting account with a one-time dashboard code. */
export async function joinAgent(service, body, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  return credential(service, '/api/agents/join', assertValid('agentJoin', body), fetcher, signal);
}
/** The host answers {agent, token}; callers keep the flat {id, name, token, account_state}. */
export function agentCredential(result) {
  const agent = result?.agent;
  return agent && typeof agent === 'object'
    ? { id: agent.id, name: agent.name, token: result.token, account_state: agent.claimed ? 'claimed' : 'unclaimed' }
    : result;
}
async function credential(service, path, body, fetcher, signal) {
  const origin = requireServiceOrigin(service);
  const response = await fetcher(origin + path, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await parse(response);
  if (!response.ok) throw new ApiError(response.status, result?.error);
  return checked('agentCredential', agentCredential(result), response.status);
}

/** One account-level agent credential for every granted page. Construction performs no network work. */
export function createAgentClient({ service, token }, { fetch: fetcher = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket, hub: hubOptions = {} } = {}) {
  const origin = requireServiceOrigin(service);
  if (typeof token !== 'string' || !AGENT_TOKEN.test(token)) throw new ApiError(400, { code: 'invalid_agent_token', message: 'Supply the retained ta_ agent token.' });
  async function call(url, { method = "GET", body, signal, headers = {} } = {}, responseSchema) {
    signal?.throwIfAborted();
    const response = await fetcher(url, {
      method, signal, redirect: 'error', headers: { ...headers, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await parse(response);
    signal?.throwIfAborted();
    if (!response.ok) throw new ApiError(response.status, result?.error);
    return responseSchema ? checked(responseSchema, result, response.status) : result;
  }
  const request = (path, options, schema) => call(origin + '/api/agent' + path, options, schema);
  let hub;
  const getHub = () => hub ??= createAgentHub({ service: origin, token, WebSocket: Socket,
    probe: ({ signal }) => request('', { signal }), ...hubOptions });
  const pages = new Map();
  function page(id, { applicationId } = {}) {
    if (typeof id !== 'string' || !PAGE_ID.test(id)) throw new ApiError(400, { code: 'invalid_page', message: 'Expected a page identity.' });
    const key = id + ':' + (applicationId ?? '');
    if (pages.has(key)) return pages.get(key);
    const base = `${origin}/api/agent/pages/${id}`;
    const pageRequest = (path, options, schema) => call(base + path, options, schema);
    // Control streams share the hub; relay lanes carry application data and stay direct.
    const socket = (path, protocols = []) => getHub().socket(id, path, protocols);
    const peerSocket = (url, protocols) => {
      const target = new URL(url);
      const path = target.pathname.slice(new URL(base).pathname.length + 1) + target.search;
      if (path.startsWith('peers/relay?')) return new Socket(url, [...protocols, token]);
      return socket(path, protocols);
    };
    // A raw authenticated transport for helpers that take a fetch (pairing); confined to this page.
    const pageFetch = (url, init = {}) => {
      // A Request would carry its own method, headers and body; helpers pass a URL and init.
      if (typeof url !== 'string' && !(url instanceof URL))
        return Promise.reject(new ApiError(400, { code: 'invalid_page_route', message: 'Pass the page transport a URL and init.' }));
      const target = new URL(url);
      if (target.origin !== origin || !(target.pathname === new URL(base).pathname || target.pathname.startsWith(new URL(base).pathname + '/')))
        return Promise.reject(new ApiError(400, { code: 'invalid_page_route', message: 'The page transport only reaches this page.' }));
      const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
      return fetcher(target.href, { ...init, headers, redirect: 'error' });
    };
    const value = Object.freeze({
      id, base, fetch: pageFetch,
      peers: createPeersClient({ base, applicationId, request: (path, options) => pageRequest('/' + path, options), protocols: [PEER_RENDEZVOUS_PROTOCOL], socket: peerSocket }),
      request: pageRequest,
      socket,
      info: () => pageRequest('', undefined, 'objectResponse'),
      service: () => pageRequest('/service', undefined, 'serviceDescriptor'),
    });
    pages.set(key, value);
    return value;
  }
  return Object.freeze({
    service: origin,
    request,
    self: options => request('', options, 'objectResponse'),
    pages: Object.freeze({
      list: ({ cursor, signal } = {}) => request('/pages' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { signal }, 'agentPageList'),
      async *all({ signal } = {}) {
        let cursor;
        do {
          const result = await this.list({ cursor, signal });
          yield* result.pages;
          cursor = result.next_cursor;
        } while (cursor);
      },
      create: (body = {}, { signal } = {}) => request('/pages', { method: 'POST', body: assertValid('agentPageCreate', body), signal }, 'agentPage'),
    }),
    page,
    get hub() { return getHub(); },
    close() { hub?.close(); },
  });
}

/** Check capabilities before a tool creates a page or writes application data. */
export async function describeService(service, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const response = await fetcher(requireServiceOrigin(service) + "/api/service", { signal, redirect: 'error', cache: 'no-store' });
  let result;
  try { result = await response.json(); }
  catch { throw new ApiError(response.status, { code: "invalid_response", message: "Service descriptor is not JSON" }); }
  if (!response.ok) throw new ApiError(response.status, result?.error);
  return checked("serviceDescriptor", result, response.status);
}

export function requireService(descriptor, { contract = CONTRACT_VERSION } = {}) {
  if (descriptor.contract !== contract) throw new ApiError(409, { code: 'contract_mismatch', message: `Core contract ${contract} required; service has ${descriptor.contract}` });
  return descriptor;
}

/** An origin is a deployment boundary, not a default to replace on failure. */
export function requireServiceOrigin(service) {
  let url;
  try { url = new URL(service); } catch { /* Report a safe message below. */ }
  if (!url || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new ApiError(400, { code: 'invalid_service_origin', message: 'Supply an HTTPS service origin without credentials, path, query or fragment (HTTP is allowed only for loopback development).' });
  }
  return url.origin;
}

function checkedReadiness(value, origin, status) {
  if (value?.serviceOrigin !== origin) {
    throw new ApiError(409, { code: 'service_origin_mismatch', message: 'Readiness identifies another service. Continue only with the selected connector service origin.' });
  }
  const mode = value.mode, creation = value.creation, writes = value.writes, environment = value.environment, build = value.build;
  if (value.schemaVersion !== 1 || !['open', 'creation_paused', 'read_only', 'unavailable'].includes(mode) ||
      environment?.id !== origin || typeof environment.label !== 'string' || !environment.label ||
      !['deployment', 'preview', 'local'].includes(environment.kind) ||
      typeof build?.coreRelease !== 'string' || !build.coreRelease || !/^[a-f0-9]{64}$/.test(build.runtimeId ?? '') ||
      !(build.sourceCommit === null || typeof build.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(build.sourceCommit)) ||
      !(build.compositionId === undefined || build.compositionId === null || typeof build.compositionId === 'string' && /^[a-f0-9]{64}$/.test(build.compositionId)) ||
      typeof creation?.available !== 'boolean' || creation.available !== (mode === 'open') ||
      creation.code !== (mode === 'open' ? null : mode === 'unavailable' ? 'unavailable' : 'creation_paused') ||
      typeof creation.message !== 'string' || typeof creation.nextAction !== 'string' ||
      typeof writes?.available !== 'boolean' || writes.available !== (mode === 'open' || mode === 'creation_paused') ||
      writes.code !== (mode === 'read_only' ? 'read_only' : mode === 'unavailable' ? 'unavailable' : null) ||
      typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) ||
      value.readinessUrl !== origin + '/api/readiness' || value.statusUrl !== origin + '/status') {
    throw new ApiError(status, { code: 'readiness_invalid', message: 'The service returned an incompatible readiness document. Upgrade or repair this service before creating a page.' });
  }
  return value;
}

/** Anonymous operational preflight, separate from the strict service contract. */
export async function describeReadiness(service, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const origin = requireServiceOrigin(service);
  let response;
  try { response = await fetcher(origin + '/api/readiness', { signal, redirect: 'error', cache: 'no-store' }); }
  catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw Object.assign(new ApiError(503, { code: 'readiness_unavailable', message: 'Could not verify creation readiness at the selected service. Check its status and retry this preflight; do not switch origins or create a page yet.' }), { cause });
  }
  if (response.status === 404) throw new ApiError(404, { code: 'readiness_unsupported', message: 'This service does not expose /api/readiness. Upgrade the selected service before creating a page; do not fall back to another origin.' });
  let result;
  try { result = await response.json(); }
  catch { throw new ApiError(response.status, { code: 'readiness_invalid', message: 'Readiness is not JSON. Check the selected service status before creating a page.' }); }
  if (!response.ok && !(response.status === 503 && result?.mode === 'unavailable')) {
    throw new ApiError(response.status, { code: 'readiness_unavailable', message: 'Creation readiness is unavailable at the selected service. Check its status before creating a page.' });
  }
  return checkedReadiness(result, origin, response.status);
}

/** A successful preflight is advisory; creation still enforces current mode. */
export function requireCreationReady(readiness, { service = readiness?.serviceOrigin } = {}) {
  const origin = requireServiceOrigin(service);
  checkedReadiness(readiness, origin, 200);
  if (!readiness.creation.available) throw new ApiError(503, { code: readiness.creation.code,
    message: `${readiness.creation.message} ${readiness.creation.nextAction}` });
  return readiness;
}
