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
    const response = await fetcher(base + path, {
      method, signal, headers: { ...headers, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
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
  const response = await fetcher(service.replace(/\/+$/, "") + "/api/tendrils", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(assertValid("create", body)),
  });
  let result;
  try { result = await response.json(); } catch { throw new ApiError(response.status, { code: "invalid_response", message: "The service returned a non-JSON response" }); }
  if (!response.ok) throw new ApiError(response.status, result?.error);
  return checked("pageHandle", result, response.status);
}

/** Check capabilities before a tool creates a page or writes application data. */
export async function describeService(service, { fetch: fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(service.replace(/\/+$/, "") + "/api/service");
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
