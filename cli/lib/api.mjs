// Tiny HTTP client for the agent API (fetch, Node >= 18).

export class ApiError extends Error {
  constructor(status, body) {
    const e = body && body.error;
    super(e ? `${e.code}: ${e.message || ""}`.trim() : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function request(url, { method = "GET", token, json, body, headers = {}, raw = false, signal } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = body;
  if (json !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(json); }
  const res = await fetch(url, { method, headers: h, body: payload, signal });
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { text }; } }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function client(cfg) {
  const call = (path, opts = {}) => request(cfg.api + path, { token: cfg.token, ...opts });
  return {
    get: (p, o) => call(p, o),
    post: (p, json, o) => call(p, { method: "POST", json, ...o }),
    put: (p, json, o) => call(p, { method: "PUT", json, ...o }),
    patch: (p, json, o) => call(p, { method: "PATCH", json, ...o }),
    del: (p, o) => call(p, { method: "DELETE", ...o }),
    raw: call,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
