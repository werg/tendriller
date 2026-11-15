import { assertValid } from "./index.mjs";

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

/** A small fetch client. No global state, framework or automatic event consumption. */
export function createClient({ api, token }, { fetch: fetcher = globalThis.fetch } = {}) {
  const base = api.replace(/\/+$/, "");
  const id = value => encodeURIComponent(String(value));
  async function request(path, { method = "GET", body, signal } = {}) {
    const response = await fetcher(base + path, {
      method, signal, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : undefined; }
    catch { throw new ApiError(response.status, { code: "invalid_response", message: "The service returned a non-JSON response" }); }
    if (!response.ok) throw new ApiError(response.status, result?.error);
    return result;
  }
  return {
    request,
    info: () => request(""),
    say: body => request("/say", { method: "POST", body: assertValid("say", body) }),
    state: () => request("/state"),
    updateState: body => request("/state", { method: "PATCH", body: assertValid("stateUpdate", body) }),
    writeFiles: body => request("/files", { method: "POST", body }),
    devices: () => request("/devices"),
    updateDevice: (device, body) => request(`/devices/${id(device)}`, { method: "PATCH", body: assertValid("deviceUpdate", body) }),
    focus: body => request("/focus", { method: "POST", body: assertValid("focusRequest", body) }),
    timers: () => request("/timers"),
    createTimer: body => request("/timers", { method: "POST", body: assertValid("timerCreate", body) }),
    updateTimer: (timer, body) => request(`/timers/${id(timer)}`, { method: "PATCH", body: assertValid("timerWrite", body) }),
    deleteTimer: timer => request(`/timers/${id(timer)}`, { method: "DELETE" }),
    timerHistory: () => request("/timers/history"),
    session: () => request("/session"),
    updateSession: body => request("/session", { method: "PUT", body: assertValid("sessionWrite", body) }),
    exportBundle: ({ includeData = false } = {}) => request(`/bundle?include_data=${includeData}`),
    stageBundle: body => request("/bundle/stage", { method: "POST", body: assertValid("bundle", body) }),
    publishBundle: body => request("/bundle/publish", { method: "POST", body: assertValid("bundlePublish", body) }),
    discardBundle: () => request("/bundle", { method: "DELETE" }),
    remix: body => request("/remix", { method: "POST", body: assertValid("remix", body) }),
    decisions: () => request("/decisions"),
    createDecision: body => request("/decisions", { method: "POST", body: assertValid("decisionCreate", body) }),
    updateDecision: (decision, body) => request(`/decisions/${id(decision)}`, { method: "PATCH", body: assertValid("decisionUpdate", body) }),
    responses: () => request("/responses"),
    readEvents: ({ after, wait = 0, signal }) => {
      if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("readEvents requires an explicit nonnegative after cursor");
      if (!Number.isInteger(wait) || wait < 0 || wait > 300) throw new TypeError("wait must be 0..300 seconds");
      const query = new URLSearchParams({ after: String(after), wait: String(wait) });
      return request(`/events?${query}`, { signal });
    },
  };
}

export async function createPage(service, body, { fetch: fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(service.replace(/\/+$/, "") + "/api/tendrils", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(assertValid("create", body)),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result?.error);
  return result;
}
