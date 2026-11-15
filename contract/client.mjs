import { assertValid, validate } from "./index.mjs";
import { createDurabilityClient } from "./durability-client.mjs";
import { createStreamsClient } from "./streams-client.mjs";

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
export function createClient({ api, token }, { fetch: fetcher = globalThis.fetch } = {}) {
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
  return {
    ...createDurabilityClient(request),
    ...createStreamsClient(request),
    request,
    info: () => request("", undefined, "objectResponse"),
    probeDelivery: () => request("/wake/probe", { method: "POST" }, "deliveryProbe"),
    checkDeliveryProbe: nonce => request(nonce === undefined ? "/wake/probe" : `/wake/probe/${assertValid("probeNonce", nonce)}`, undefined, "deliveryProbe"),
    acknowledgeDeliveryProbe: nonce => request(`/wake/probe/${assertValid("probeNonce", nonce)}/ack`, { method: "POST" }, "deliveryProbe"),
    say: body => request("/say", { method: "POST", body: assertValid("say", body) }, "sayResult"),
    state: () => request("/state", undefined, "stateSnapshot"),
    updateState: body => request("/state", { method: "PATCH", body: assertValid("stateUpdate", body) }, "stateRevision"),
    writeFiles: body => request("/files", { method: "POST", body }, "publicationResult"),
    devices: () => request("/devices", undefined, "deviceConfiguration"),
    updateDevice: (device, body) => request(`/devices/${id(device)}`, { method: "PATCH", body: assertValid("deviceUpdate", body) }, "deviceInfo"),
    focus: body => request("/focus", { method: "POST", body: assertValid("focusRequest", body) }, "deviceConfiguration"),
    timers: () => request("/timers", undefined, "timerList"),
    createTimer: body => request("/timers", { method: "POST", body: assertValid("timerCreate", body) }, "timer"),
    updateTimer: (timer, body) => request(`/timers/${id(timer)}`, { method: "PATCH", body: assertValid("timerWrite", body) }, "timer"),
    deleteTimer: timer => request(`/timers/${id(timer)}`, { method: "DELETE" }),
    timerHistory: () => request("/timers/history", undefined, "timerHistory"),
    session: () => request("/session", undefined, "sessionSummary"),
    updateSession: body => request("/session", { method: "PUT", body: assertValid("sessionWrite", body) }, "sessionResult"),
    exportBundle: ({ includeData = false } = {}) => request(`/bundle?include_data=${includeData}`, undefined, "bundle"),
    stageBundle: body => request("/bundle/stage", { method: "POST", body: assertValid("bundle", body) }, "bundleStage"),
    publishBundle: body => request("/bundle/publish", { method: "POST", body: assertValid("bundlePublish", body) }, "publicationResult"),
    discardBundle: () => request("/bundle", { method: "DELETE" }),
    remix: body => request("/remix", { method: "POST", body: assertValid("remix", body) }, "remixResult"),
    decisions: () => request("/decisions", undefined, "decisionList"),
    createDecision: body => request("/decisions", { method: "POST", body: assertValid("decisionCreate", body) }, "decision"),
    updateDecision: (decision, body) => request(`/decisions/${id(decision)}`, { method: "PATCH", body: assertValid("decisionUpdate", body) }, "decision"),
    responses: () => request("/responses", undefined, "responseList"),
    assignments: () => request("/assignments", undefined, "assignmentList"),
    participants: () => request("/assignments/participants", undefined, "participantList"),
    createAssignment: body => request("/assignments", { method: "POST", body: assertValid("assignmentCreate", body) }, "assignment"),
    updateAssignment: (assignment, body) => request(`/assignments/${id(assignment)}`, { method: "PATCH", body: assertValid("assignmentUpdate", body) }, "assignment"),
    archives: () => request("/archives", undefined, "archiveList"),
    previewArchive: scope => request(`/archives/preview?scope=${id(assertValid("archiveScope", scope))}`, undefined, "archivePreview"),
    createArchive: body => request("/archives", { method: "POST", body: assertValid("archiveCreate", body) }, "archiveResult"),
    archive: archive => request(`/archives/${id(archive)}`, undefined, "archive"),
    deleteArchive: archive => request(`/archives/${id(archive)}`, { method: "DELETE" }),
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
