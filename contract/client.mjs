import { assertValid, CONTRACT_VERSION, validate } from './index.mjs';
import { createPeersClient, PEER_RENDEZVOUS_PROTOCOL } from './peers.mjs';
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

/** Explicit host lifecycle and participant operations. Application execution belongs to Chronolog. */
export function createClient({ api, token }, { fetch: fetcher = globalThis.fetch, applicationId } = {}) {
  const base = api.replace(/\/+$/, '');
  async function request(path, { method = "GET", body, signal, headers = {} } = {}, responseSchema) {
    signal?.throwIfAborted();
    const response = await fetcher(base + path, {
      method, signal, headers: { ...headers, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    signal?.throwIfAborted();
    let result;
    try { result = text ? JSON.parse(text) : undefined; }
    catch { throw new ApiError(response.status, { code: "invalid_response", message: "The service returned a non-JSON response" }); }
    if (!response.ok) throw new ApiError(response.status, result?.error);
    return responseSchema ? checked(responseSchema, result, response.status) : result;
  }
  return Object.freeze({
    peers: createPeersClient({ base, applicationId, request: (path, options) => request('/' + path, options), protocols: [PEER_RENDEZVOUS_PROTOCOL, token] }),
    request,
    info: () => request('', undefined, 'objectResponse'),
    service: () => request('/service', undefined, 'serviceDescriptor'),
  });
}

export async function createPage(service, body, { fetch: fetcher = globalThis.fetch } = {}) {
  const origin = requireServiceOrigin(service);
  const response = await fetcher(origin + "/api/tendrils", {
    method: "POST", redirect: 'error', headers: { "Content-Type": "application/json" }, body: JSON.stringify(assertValid("create", body)),
  });
  let result;
  try { result = await response.json(); } catch { throw new ApiError(response.status, { code: "invalid_response", message: "The service returned a non-JSON response" }); }
  if (!response.ok) throw new ApiError(response.status, result?.error);
  const handle = checked("pageHandle", result, response.status);
  let api;
  try { api = new URL(handle.api); } catch { /* Checked below without exposing credentials. */ }
  if (!api || api.origin !== origin || api.username || api.password) {
    throw new ApiError(409, { code: 'service_origin_mismatch', message: 'The returned page handle belongs to another service. Keep the selected service origin and inspect the creation result before retrying.' });
  }
  return handle;
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
