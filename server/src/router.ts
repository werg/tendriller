// Worker router: authenticates nothing per-tendril itself; it routes to the Durable Object.
import type { Env } from "./env";
import { routeAuth } from "./accounts/auth";
import { apiKeyAccount, dashboard } from "./accounts/keys";
import { accountData } from "./accounts/data";
import { apiDevice, devicePage } from "./accounts/device";
import { reportPage } from "./abuse/report";
import { adminPage, appealPage } from "./abuse/admin";
import { budgetWebhook } from "./budget";
import { redeemPageCode, routePageAuth } from "./accounts/page";
import { CORS_HEADERS, errorResponse, HttpError, isPlainObject, json, readBody, toErrorResponse, withCors } from "./http";
import { newTendrilId, sha256Hex, TENDRIL_ID_RE } from "./ids";
import { landingPage } from "./inject";
import { parsePageRoute, publicBase } from "./urls";
import { requireCreationOpen, reserveCreationIp } from "./service-state";

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

async function speechAsset(env: Env, name: string): Promise<Response> {
  if (!["cactus.js", "cactus.wasm", "whistle.cact"].includes(name)) return errorResponse(404, "not_found");
  const object = await env.FILES.get(`speech/4.0.0/${name}`);
  if (!object) return errorResponse(503, "unavailable", "Speech model is not installed");
  const type = name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return new Response(object.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff" } });
}

export async function route(req: Request, env: Env): Promise<Response> {
  const host = new URL(req.url).hostname.toLowerCase();
  const pagesDomain = env.PAGE_BASE_DOMAIN?.toLowerCase();
  const onPagesDomain = !!pagesDomain && (host === pagesDomain || host.endsWith(`.${pagesDomain}`));
  let res: Response;
  try { res = await routeInner(req, env, onPagesDomain); }
  catch (err) { res = toErrorResponse(err); }
  if (onPagesDomain) {
    const headers = new Headers(res.headers);
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    if (res.status === 101) return new Response(null, { status: 101, headers, webSocket: res.webSocket });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  return res;
}

async function routeInner(req: Request, env: Env, onPagesDomain: boolean): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (onPagesDomain && !parsePageRoute(url, env)) return errorResponse(404, "not_found", "Not found");
  if (!onPagesDomain && url.origin !== new URL(publicBase(env)).origin) return errorResponse(404, "not_found", "Not found");

  // Pages: P and everything under it.
  const page = parsePageRoute(url, env);
  if (page) {
    if (((req.method !== "GET" && req.method !== "HEAD") || req.headers.get("Upgrade")?.toLowerCase() === "websocket") &&
      req.headers.get("Origin") !== url.origin) {
      return errorResponse(403, "bad_origin", "Request must originate from this tendril");
    }
    if (page.rest === null) {
      const to = new URL(url);
      to.pathname = page.base;
      return Response.redirect(to.toString(), 308);
    }
    if (page.rest === "_tendril/session" && req.method === "GET") {
      return redeemPageCode(env, page.id, page.key, url.searchParams.get("code") ?? "");
    }
    const check = await stub(env, page.id).fetch(new Request("https://tendril.internal/claim/check", {
      headers: { "x-tendril-key": page.key, Cookie: req.headers.get("Cookie") ?? "",
        "x-visitor-ip": req.headers.get("CF-Connecting-IP") ?? "" },
    }));
    if (check.status === 403) return new Response("This page is unavailable pending review.", {
      status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
    if (!check.ok) {
      if (req.method === "GET" || req.method === "HEAD") {
        return new Response(null, { status: 302, headers: { Location: `${publicBase(env)}/auth/page?tendril=${page.id}&key=${page.key}`,
          "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      }
      return errorResponse(401, "unauthorized", "Page sign-in required");
    }
    const rest = page.rest;
    const speech = /^_tendril\/speech\/(cactus\.js|cactus\.wasm|whistle\.cact)$/.exec(rest);
    if (speech) return speechAsset(env, speech[1]);
    if (rest === "_tendril/tendril.js") return asset(env, url, "/_tendril/tendril.js");
    if (rest === "_tendril/speech-worker.js") return asset(env, url, "/_tendril/speech-worker.js");
    if (rest === "_tendril/sw.js") return asset(env, url, "/_tendril/sw.js", { "Service-Worker-Allowed": page.base });
    const sn = /^_tendril\/snippets\/([A-Za-z0-9_.-]+\.js)$/.exec(rest);
    if (sn) return asset(env, url, `/snippets/${sn[1]}`);
    return forward(env, page.id, "page", req, url, {
      "x-tendril-key": page.key,
      "x-tendril-origin": url.origin,
      "x-tendril-base": page.base,
      "x-tendril-rest": encodeURIComponent(rest),
    });
  }

  if (path.startsWith("/api/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    return withCors(await api(req, env, url));
  }

  if (path === "/auth/page") return routePageAuth(req, env, url);
  if (path === "/report") return reportPage(req, env, url);
  if (path === "/internal/budget") return budgetWebhook(req, env);
  if (path === "/appeal") return appealPage(req, env, url);
  if (path === "/admin" || path === "/admin/action" || /^\/admin\/t\/[a-z2-7]{12}$/.test(path)) return adminPage(req, env, url);
  if (path === "/auth" || path.startsWith("/auth/")) return routeAuth(req, env, url);
  if (path === "/device") return devicePage(req, env, url);
  if (path === "/dashboard/export" || path === "/dashboard/delete") return accountData(req, env, url);
  if (path === "/dashboard" || path.startsWith("/dashboard/")) return dashboard(req, env, url);

  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    return new Response(landingPage(publicBase(env)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (path === "/health") return json({ ok: true });
  if (path === "/status") {
    const state = await env.ACCOUNTS.prepare("SELECT mode FROM service_state WHERE id = 1").first<{ mode: string }>();
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Tendriller status</title></head><body><main><h1>Tendriller status</h1><p>${state?.mode === "open" ? "Operational" : state?.mode === "creation_paused" ? "New page creation paused" : "Read-only or unavailable"}</p></main></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (path === "/agent.md") return asset(env, url, "/agent.md", { "Content-Type": "text/markdown; charset=utf-8" });
  if (["/terms", "/privacy", "/acceptable-use", "/copyright", "/law-enforcement"].includes(path)) {
    return asset(env, url, `/legal${path}.html`, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  }
  if (/^\/snippets\/[A-Za-z0-9_.-]+\.js$/.test(path) || path === "/_tendril/tendril.js" || path === "/_tendril/sw.js") {
    return asset(env, url, path);
  }
  return errorResponse(404, "not_found", "Not found");
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  try {
    if (path === "/api/device" || path === "/api/device/token") return await apiDevice(req, env, url);
    if (path === "/api/tendrils") {
      if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST");
      await requireCreationOpen(env);
      const accountId = await apiKeyAccount(req, env);
      if (req.headers.has("Authorization") && !accountId) {
        if (env.FAILED_AUTH_RATE && !(await env.FAILED_AUTH_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
          throw new HttpError(429, "rate_limited", "Too many failed authentication attempts");
        }
        throw new HttpError(401, "unauthorized", "Invalid account key");
      }
      if (!accountId && env.CREATE_RATE && !(await env.CREATE_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
        throw new HttpError(429, "rate_limited", "Creation rate limit reached");
      }
      const body = await readBody(req, 64 * 1024);
      let createBody: unknown;
      try { createBody = JSON.parse(new TextDecoder().decode(body) || "{}"); }
      catch { throw new HttpError(400, "bad_json", "Request body is not valid JSON"); }
      if (!isPlainObject(createBody)) throw new HttpError(400, "bad_request", "Creation body must be an object");
      const lifetime = createBody.lifetime ?? "ad_hoc";
      if (lifetime !== "ad_hoc" && lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
      if (accountId && env.KEY_CREATE_RATE && !(await env.KEY_CREATE_RATE.limit({ key: accountId })).success) {
        throw new HttpError(429, "rate_limited", "Account creation rate limit reached");
      }
      const releaseIp = accountId ? async () => {} : await reserveCreationIp(env, req);
      let created = false;
      try {
        for (let i = 0; i < 3; i++) {
          const id = newTendrilId();
          const admission = !accountId ? env.ADMISSION.get(env.ADMISSION.idFromName("global")) : null;
          if (admission) {
            const allowed = await admission.fetch(new Request("https://admission.internal/reserve", { method: "POST", headers: { "x-tendril-id": id } }));
            if (!allowed.ok) return allowed;
          }
          let indexed = false;
          const cancel = async () => {
            try {
              if (indexed) await env.ACCOUNTS!.prepare("DELETE FROM tendrils WHERE id = ?").bind(id).run();
            } finally {
              if (admission) await admission.fetch(new Request("https://admission.internal/cancel", { method: "POST", headers: { "x-tendril-id": id } }));
            }
          };
          let res: Response;
          try {
            try {
              await env.ACCOUNTS.prepare("INSERT INTO tendrils (id, owner_account, creator_ip, created_at, claimed_at, lifetime) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(id, accountId, req.headers.get("CF-Connecting-IP"), Date.now(), accountId ? Date.now() : null, lifetime).run();
            } catch (err) {
              const message = String(err);
              if (message.includes("account_tendrils_full")) throw new HttpError(429, "quota", "Account tendril limit reached", { limit: 20 });
              if (message.includes("account_residents_full")) throw new HttpError(429, "quota", "Account resident tendril limit reached", { limit: 3 });
              throw err;
            }
            indexed = true;
            res = await stub(env, id).fetch(
              new Request("https://tendril.internal/create", { method: "POST", headers: {
                "x-tendril-id": id, "Content-Type": "application/json", ...(accountId ? { "x-tendril-owner-account": accountId } : {}),
              }, body }),
            );
          } catch (err) {
            await cancel();
            throw err;
          }
          if (res.status !== 409) {
            if (!res.ok) await cancel();
            else created = true;
            return res;
          }
          await cancel();
          await res.body?.cancel();
        }
        return errorResponse(500, "internal", "Could not allocate a tendril id");
      } finally {
        if (!created) await releaseIp();
      }
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
      const agentRest = safeDecode(m[2] ?? "");
      const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
      if (token && env.AGENT_RATE && !(await env.AGENT_RATE.limit({ key: await sha256Hex(token) })).success) {
        throw new HttpError(429, "rate_limited", "Agent request rate limit reached");
      }
      if (req.method === "POST" && agentRest === "eval" && env.EVAL_RATE && !(await env.EVAL_RATE.limit({ key: m[1] })).success) {
        throw new HttpError(429, "rate_limited", "Eval rate limit reached");
      }
      if (req.method === "GET" && /^(?:files|blobs)\//.test(agentRest) && env.FILE_READ_RATE &&
        !(await env.FILE_READ_RATE.limit({ key: m[1] })).success) throw new HttpError(429, "rate_limited", "File read rate limit reached");
      const res = await forward(env, m[1], "agent", req, url, { "x-tendril-rest": encodeURIComponent(agentRest) });
      if (res.status === 401 && env.FAILED_AUTH_RATE &&
        !(await env.FAILED_AUTH_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
        await res.body?.cancel();
        throw new HttpError(429, "rate_limited", "Too many failed authentication attempts");
      }
      return res;
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
