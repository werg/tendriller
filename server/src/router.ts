// Worker router: authenticates nothing per-tendril itself; it routes to the Durable Object.
import type { Env } from "./env";
import { CORS_HEADERS, errorResponse, json, toErrorResponse, withCors } from "./http";
import { newTendrilId, safeEqual, sha256Hex, TENDRIL_ID_RE } from "./ids";
import { landingPage } from "./inject";
import { parsePageRoute, publicBase } from "./urls";

function stub(env: Env, id: string): DurableObjectStub {
  return env.TENDRIL.get(env.TENDRIL.idFromName(id));
}

/** Forwards a request to the tendril's Durable Object under an internal path. */
function forward(env: Env, id: string, kind: string, req: Request, url: URL, headers: Record<string, string>): Promise<Response> {
  const h = new Headers(req.headers);
  h.set("x-tendril-id", id);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const init: RequestInit = { method: req.method, headers: h, signal: req.signal };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
  return stub(env, id).fetch(new Request(`https://tendril.internal/${kind}${url.search}`, init));
}

async function asset(env: Env, url: URL, path: string, extra?: Record<string, string>): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin).toString(), { method: "GET" }));
  if (!res.ok) {
    await res.body?.cancel();
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-cache");
  for (const [k, v] of Object.entries(extra ?? {})) out.headers.set(k, v);
  return out;
}

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Pages: P and everything under it.
  const page = parsePageRoute(url, env);
  if (page) {
    if (page.rest === null) {
      const to = new URL(url);
      to.pathname = page.base;
      return Response.redirect(to.toString(), 308);
    }
    const rest = page.rest;
    if (rest === "_tendril/tendril.js") return asset(env, url, "/_tendril/tendril.js");
    if (rest === "_tendril/sw.js") return asset(env, url, "/_tendril/sw.js", { "Service-Worker-Allowed": page.base });
    const sn = /^_tendril\/snippets\/([A-Za-z0-9_.-]+\.js)$/.exec(rest);
    if (sn) return asset(env, url, `/snippets/${sn[1]}`);
    return forward(env, page.id, "page", req, url, {
      "x-tendril-key": page.key,
      "x-tendril-base": page.base,
      "x-tendril-rest": encodeURIComponent(rest),
    });
  }

  if (path.startsWith("/api/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    return withCors(await api(req, env, url));
  }

  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    return new Response(landingPage(publicBase(env)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (path === "/health") return json({ ok: true });
  if (path === "/agent.md") return asset(env, url, "/agent.md", { "Content-Type": "text/markdown; charset=utf-8" });
  if (/^\/snippets\/[A-Za-z0-9_.-]+\.js$/.test(path) || path === "/_tendril/tendril.js" || path === "/_tendril/sw.js") {
    return asset(env, url, path);
  }
  return errorResponse(404, "not_found", "Not found");
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  try {
    if (path === "/api/tendrils") {
      if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST");
      if (env.CREATE_KEY) {
        const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
        const ok = m && safeEqual(await sha256Hex(m[1]), await sha256Hex(env.CREATE_KEY));
        if (!ok) return errorResponse(401, "unauthorized", "Creating tendrils needs Authorization: Bearer <CREATE_KEY>");
      }
      const body = await req.arrayBuffer();
      for (let i = 0; i < 3; i++) {
        const id = newTendrilId();
        const res = await stub(env, id).fetch(
          new Request("https://tendril.internal/create", { method: "POST", headers: { "x-tendril-id": id, "Content-Type": "application/json" }, body }),
        );
        if (res.status !== 409) return res;
        await res.body?.cancel();
      }
      return errorResponse(500, "internal", "Could not allocate a tendril id");
    }

    if (path === "/api/adopt") {
      if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST");
      const text = await req.text();
      let code = "";
      try {
        code = String(JSON.parse(text || "{}").code ?? "").trim();
      } catch {
        return errorResponse(400, "bad_json", "Request body is not valid JSON");
      }
      const m = /^([a-z2-7]{12})-(\d{6})$/.exec(code);
      if (!m) return errorResponse(400, "invalid_code", "Adopt codes look like <tendril id>-<6 digits>");
      return stub(env, m[1]).fetch(
        new Request("https://tendril.internal/adopt", { method: "POST", headers: { "x-tendril-id": m[1], "Content-Type": "application/json" }, body: JSON.stringify({ code }) }),
      );
    }

    const m = /^\/api\/t\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (m) {
      if (!TENDRIL_ID_RE.test(m[1])) return errorResponse(404, "not_found", "No such tendril");
      return forward(env, m[1], "agent", req, url, { "x-tendril-rest": encodeURIComponent(safeDecode(m[2] ?? "")) });
    }
    return errorResponse(404, "not_found", "No such API route");
  } catch (err) {
    return toErrorResponse(err);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
