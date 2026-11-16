import { createCloudflareApplicationBackend, applicationSelection } from "./application.mjs";
import { connectPeer, validatePeerBootstrap } from "./peers.mjs";
import { assertValid, validate, CONTRACT_VERSION } from "./index.mjs";
import { createDurabilityClient } from "./durability-client.mjs";
import { createStreamsClient } from "./streams-client.mjs";
import { createBlobClient } from "./blobs-client.mjs";
import { createRecordLogClient } from "./records.mjs";

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

/** A small fetch client. No global state, framework or automatic event consumption. */
export function createClient({ api, token }, { fetch: fetcher = globalThis.fetch, recordLogHints } = {}) {
  const base = api.replace(/\/+$/, "");
  const id = value => encodeURIComponent(String(value));
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
  async function raw(path, { method = "GET", body, signal, headers = {} } = {}) {
    const response = await fetcher(base + path, { method, signal,
      headers: { ...headers, Authorization: `Bearer ${token}` }, body,
    });
    if (!response.ok) {
      let parsed;
      try { parsed = await response.json(); } catch { /* Binary errors are not JSON. */ }
      throw new ApiError(response.status, parsed?.error || { code: "http_error", message: `HTTP ${response.status}` });
    }
    return response;
  }
  return {
    async application() {
      const selection = applicationSelection((await request("/application")).selection);
      if (selection.kind !== "cloudflare") throw new ApiError(409, { code: "application_backend", message: "Connect to this page's selected peer backend" });
      return createCloudflareApplicationBackend({ id: selection.id, request: (path, options) => request("/" + path, options) });
    },
    peers: {
      bootstrap: async () => validatePeerBootstrap(await request("/peers/bootstrap")),
      setBootstrap: async hints => validatePeerBootstrap(await request("/peers/bootstrap", { method: "PUT", body: validatePeerBootstrap(hints) })),
      connect(channel, peerId, options = {}) {
        if (![channel, peerId].every(value => /^[A-Za-z0-9_.:-]{1,160}$/.test(value))) throw new TypeError("Invalid peer channel or identity");
        const url = new URL(base + "/peers/socket"); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("channel", channel); url.searchParams.set("peerId", peerId);
        return connectPeer({ url: url.href, route: "relay" }, { ...options, protocols: ["tendriller.peer.v1", token], relayHandshake: true });
      },
    },
    records: createRecordLogClient({ base, headers: () => ({ Authorization: `Bearer ${token}` }), fetch: fetcher, subscribeHints: recordLogHints }),
    ...createBlobClient(request, raw),
    ...createDurabilityClient(request),
    ...createStreamsClient(request),
    request,
    info: () => request("", undefined, "objectResponse"),
    probeDelivery: () => request("/wake/probe", { method: "POST" }, "deliveryProbe"),
    checkDeliveryProbe: nonce => request(nonce === undefined ? "/wake/probe" : `/wake/probe/${assertValid("probeNonce", nonce)}`, undefined, "deliveryProbe"),
    acknowledgeDeliveryProbe: nonce => request(`/wake/probe/${assertValid("probeNonce", nonce)}/ack`, { method: "POST" }, "deliveryProbe"),
    say: body => request("/say", { method: "POST", body: assertValid("say", body) }, "sayResult"),
    // Push works without a browser tab. Consent and server registrations are
    // managed by the authored page, never by this agent token.
    notificationStatus: () => request("/notify"),
    notify: body => request("/notify", { method: "POST", body }),
    state: () => request("/state", undefined, "stateSnapshot"),
    updateState: body => request("/state", { method: "PATCH", body: assertValid("stateUpdate", body) }, "stateRevision"),
    devices: () => request("/devices", undefined, "deviceConfiguration"),
    updateDevice: (device, body) => request(`/devices/${id(device)}`, { method: "PATCH", body: assertValid("deviceUpdate", body) }, "deviceInfo"),
    focus: body => request("/focus", { method: "POST", body: assertValid("focusRequest", body) }, "deviceConfiguration"),
    timers: () => request("/timers", undefined, "timerList"),
    createTimer: body => request("/timers", { method: "POST", body: assertValid("timerCreate", body) }, "timer"),
    updateTimer: (timer, body) => request(`/timers/${id(timer)}`, { method: "PATCH", body: assertValid("timerWrite", body) }, "timer"),
    deleteTimer: (timer, body) => request(`/timers/${id(timer)}`, { method: "DELETE", body: assertValid("timerDelete", body) }, "timerDeleted"),
    timerHistory: () => request("/timers/history", undefined, "timerHistory"),
    session: () => request("/session", undefined, "sessionSummary"),
    updateSession: body => request("/session", { method: "PUT", body: assertValid("sessionWrite", body) }, "sessionResult"),
    exportBundle: ({ includeData = false } = {}) => request(`/bundle?include_data=${includeData}`, undefined, "bundle"),
    stageBundle: body => request("/bundle", { method: "PUT", body: assertValid("bundle", body) }, "bundleStage"),
    publishBundle: body => request("/bundle/publish", { method: "POST", body: assertValid("bundlePublish", body) }, "bundleReceipt"),
    discardBundle: () => request("/bundle", { method: "DELETE" }),
    remix: body => request("/remix", { method: "POST", body: assertValid("remix", body) }, "remixResult"),
    service: () => request("/service", undefined, "serviceDescriptor"),
    scopes: () => request("/scopes", undefined, "scopeList"),
    putScope: (scope, body) => request(`/scopes/${id(scope)}`, { method: "PUT", body: assertValid("scopeWrite", body) }, "scopeDescriptor"),
    rotateScope: (scope, body) => request(`/scopes/${id(scope)}/rotate`, { method: "POST", body }),
    retireScope: (scope, body) => request(`/scopes/${id(scope)}`, { method: "DELETE", body }),
    send: body => request("/events", { method: "POST", body: assertValid("command", body) }),
    workflow: (module, operation, body) => request(`/workflows/${id(module)}/${id(operation)}`, { method: "POST", body: assertValid("command", body) }),
    readEvents: ({ after, wait = 0, signal }) => {
      if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("readEvents requires an explicit nonnegative after cursor");
      if (!Number.isInteger(wait) || wait < 0 || wait > 300) throw new TypeError("wait must be 0..300 seconds");
      const query = new URLSearchParams({ after: String(after), wait: String(wait) });
      return request(`/events?${query}`, { signal }, "eventBatch");
    },
  };
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

export function requireService(descriptor, { contract = CONTRACT_VERSION, workflows = {} } = {}) {
  if (descriptor.contract !== contract) throw new ApiError(409, { code: "contract_mismatch", message: `Core contract ${contract} required; service has ${descriptor.contract}` });
  for (const [id, required] of Object.entries(workflows)) {
    const installed = descriptor.workflows.find(module => module.id === id);
    if (!installed || installed.interface_version !== required.interface_version || installed.schema_version !== required.schema_version)
      throw new ApiError(409, { code: "workflow_mismatch", message: `Required workflow interface/schema is unavailable: ${id}` });
  }
  return descriptor;
}
