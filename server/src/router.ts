import { RESIDENT_LIMIT } from "./limits";
import { routeAccountSetup } from './account-setup';
import { ADAPTER_KEY, ASSISTANT_PROTOCOL } from './assistant-shared';
import { parseActivityTicket } from './assistant-activity';
import { routeAssistant, routeAssistantHttpGateway } from './assistant-gateway';
import { runtimeAsset, immutableAsset } from "./runtime-assets";
import { servicePage } from "./accounts/ui";
import { assertValid, schemaDocument } from "../../contract/index.mjs";
// Worker router: authenticates nothing per-tendril itself; it routes to the Durable Object.
import type { Env } from "./env";
import { routeAuth } from "./accounts/auth";
import { routeIntegrationOAuth } from "./accounts/integration-oauth";
import { dashboard } from "./accounts/keys";
import { setupDashboard } from './accounts/setups';
import { accountData } from "./accounts/data";
import { reportPage } from "./abuse/report";
import { adminPage, appealPage } from "./abuse/admin";
import { budgetWebhook } from "./budget";
import { redeemPageCode, routePageAuth } from "./accounts/page";
import { CORS_HEADERS, errorResponse, HttpError, isPlainObject, json, readBody, toErrorResponse, withCors } from "./http";
import { AGENT_TOKEN_RE, newTendrilId, sha256Hex, TENDRIL_ID_RE } from "./ids";
import { landingPage } from "./inject";
import { agentJoinDocument } from "./sharing";
import { serviceDescriptor } from "./descriptor";
import { onboardingDescriptor, onboardingLinks } from "./onboarding";
import { capabilityCatalog } from "./capability-catalog";
import { isBranchPreview, parsePageRoute, publicBase } from "./urls";
import { requireCreationOpen, reserveCreationIp, serviceReadiness } from "./service-state";
import { PAGE_ACCESS_HEADER } from "./page";
import type { CacheContext } from "./immutable-cache";

function stub(env: Env, id: string): DurableObjectStub {
  return env.TENDRIL.get(env.TENDRIL.idFromName(id));
}

/** Forwards a request to the tendril's Durable Object under an internal path. */
function forward(env: Env, id: string, kind: string, req: Request, url: URL, headers: Record<string, string>): Promise<Response> {
  const h = new Headers(req.headers);
  h.set("x-tendril-id", id);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const init: RequestInit = { method: req.method, headers: h, signal: req.signal, ...(kind === "assistant" || kind === "page" ? { redirect: "manual" } : {}) };
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

export async function route(req: Request, env: Env, context?: CacheContext): Promise<Response> {
  const host = new URL(req.url).hostname.toLowerCase();
  const pagesDomain = env.PAGE_BASE_DOMAIN?.toLowerCase();
  const serviceHost = new URL(publicBase(env)).hostname.toLowerCase();
  const onPagesDomain = host !== serviceHost && !!pagesDomain && (host === pagesDomain || host.endsWith(`.${pagesDomain}`));
  let res: Response;
  try { res = await routeInner(req, env, onPagesDomain, context); }
  catch (err) { res = toErrorResponse(err); }
  const preview = isBranchPreview(env);
  if (onPagesDomain || preview) {
    const headers = new Headers(res.headers);
    if (onPagesDomain) headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    if (preview) headers.set("X-Robots-Tag", "noindex, nofollow");
    if (res.status === 101) return new Response(null, { status: 101, headers, webSocket: res.webSocket });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  return res;
}

async function routeInner(req: Request, env: Env, onPagesDomain: boolean, context?: CacheContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const rootRuntime = /^\/_tendril\/runtime\/([a-f0-9]{64})\/([A-Za-z0-9_./-]+)$/.exec(path);
  const rootBrand = path === '/favicon.ico' || /^\/_tendril\/brand\/(logo\.(png|webp)|icon-(64|180)\.png|favicon\.ico)$/.test(path);
  const publicRead = (req.method === 'GET' || req.method === 'HEAD') && req.headers.get('Upgrade')?.toLowerCase() !== 'websocket';
  if (onPagesDomain && !parsePageRoute(url, env)) {
    // Old runtime releases missing from the static deployment still resolve
    // through R2 at the same public root URL. Reuse the page-host validator so
    // foreign preview labels and nested/unrecognised subdomains remain invalid.
    const probe = new URL(url);
    probe.pathname = `/s/${'a'.repeat(26)}/`;
    if (!publicRead || !(rootRuntime || rootBrand) || !parsePageRoute(probe, env))
      return errorResponse(404, "not_found", "Not found");
  }
  if (!onPagesDomain && url.origin !== new URL(publicBase(env)).origin) return errorResponse(404, "not_found", "Not found");

  if (publicRead && rootRuntime) return runtimeAsset(env, req, rootRuntime[1], rootRuntime[2], context);
  if (publicRead && rootBrand) {
    const response = await asset(env, url, path === '/favicon.ico' ? '/_tendril/brand/favicon.ico' : path);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') { await response.body?.cancel(); return new Response(null, response); }
    return response;
  }

  // Pages: P and everything under it.
  const page = parsePageRoute(url, env);
  if (page) {
    const shareTargetFallback = page.rest === "_tendril/share-target" && req.method === "POST";
    if (!shareTargetFallback && ((req.method !== "GET" && req.method !== "HEAD") || req.headers.get("Upgrade")?.toLowerCase() === "websocket") &&
      req.headers.get("Origin") !== url.origin) {
      return errorResponse(403, "bad_origin", "Request must originate from this tendril");
    }
    if (page.rest === null) {
      const to = new URL(url);
      to.pathname = page.base;
      return Response.redirect(to.toString(), 308);
    }
    if (page.rest === "_tendril/auth/session" && req.method === "GET") {
      return redeemPageCode(env, page.id, page.key, url.searchParams.get("code") ?? "");
    }
    const rest = page.rest;
    // These platform bytes are already public on the service origin. Fetching
    // them on a valid page origin must not wake that page or query its account.
    const runtime = /^_tendril\/runtime\/([a-f0-9]{64})\/([A-Za-z0-9_./-]+)$/.exec(rest);
    const brand = /^_tendril\/brand\/(icon-(64|180)\.png|favicon\.ico)$/.test(rest);
    if ((req.method === "GET" || req.method === "HEAD") && req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      if (runtime && !runtime[2].split("/").includes("..")) return runtimeAsset(env, req, runtime[1], runtime[2], context);
      if (brand) return asset(env, url, `/${rest}`);
    }
    const resource = /^_tendril\/assets\/([a-f0-9]{64})\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,199})$/.exec(rest);
    // Optional resources and the scoped service worker keep their existing
    // access gate; authored files and page APIs authenticate in their one DO call.
    if (resource || rest === "_tendril/sw.js") {
      const check = await stub(env, page.id).fetch(new Request("https://tendril.internal/claim/check", {
        headers: { "x-tendril-key": page.key, Cookie: req.headers.get("Cookie") ?? "",
          "x-visitor-ip": req.headers.get("CF-Connecting-IP") ?? "" },
      }));
      if (!check.ok && ![401, 403, 404].includes(check.status)) return check;
      await check.body?.cancel();
      if (!check.ok) return pageAdmissionFailure(req, env, page, check.status === 403);
      if (resource) return immutableAsset(env, req, resource[1], resource[2], context);
      return asset(env, url, "/_tendril/sw.js", { "Service-Worker-Allowed": page.base });
    }
    const response = await forward(env, page.id, "page", req, url, {
      "x-tendril-key": page.key,
      "x-tendril-origin": url.origin,
      "x-tendril-base": page.base,
      "x-tendril-rest": encodeURIComponent(rest),
      "x-visitor-ip": req.headers.get("CF-Connecting-IP") ?? "",
    });
    const denied = response.headers.get(PAGE_ACCESS_HEADER);
    if (denied === "signin" || denied === "unavailable") {
      await response.body?.cancel();
      return pageAdmissionFailure(req, env, page, denied === "unavailable");
    }
    return response;
  }

  if (path.startsWith("/api/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    return withCors(await api(req, env, url));
  }


  if (path.startsWith('/v1/apps/')) return routeAssistantHttpGateway(req, env, url);
  if (path === '/mcp' || path === '/connections' || path.startsWith('/connections/') ||
    path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
    return routeAssistant(req, env, url);
  if (path === '/.well-known/oauth-authorization-server' || path.startsWith('/oauth/')) return routeIntegrationOAuth(req, env, url);
  if (path === "/auth/page") return routePageAuth(req, env, url);
  if (path === "/report") return reportPage(req, env, url);
  if (path === "/internal/budget") return budgetWebhook(req, env);
  if (path === "/appeal" || path === "/appeal/account") return appealPage(req, env, url);
  if (path === "/admin" || path === "/admin/action" || /^\/admin\/t\/[a-z2-7]{12}$/.test(path)) return adminPage(req, env, url);
  if (path === "/auth" || path.startsWith("/auth/")) return routeAuth(req, env, url);
  if (path === "/dashboard/export" || path === "/dashboard/delete") return accountData(req, env, url);
  if (path === '/dashboard/setups' || path.startsWith('/dashboard/setups/')) return setupDashboard(req,env,url);
  if (path === "/dashboard" || path.startsWith("/dashboard/")) return dashboard(req, env, url);

  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    return new Response(req.method === "HEAD" ? null : landingPage(publicBase(env)), {
      headers: { "Content-Type": "text/html; charset=utf-8", Link: onboardingLinks(publicBase(env)) },
    });
  }
  if (path === "/.well-known/tendriller.json" && publicRead) {
    const response = json(onboardingDescriptor(publicBase(env)), 200, { Link: onboardingLinks(publicBase(env)) });
    return req.method === "HEAD" ? new Response(null, response) : response;
  }
  if (path === "/.well-known/tendriller-capabilities.json" && publicRead) {
    const response = json(capabilityCatalog(publicBase(env)), 200, { Link: onboardingLinks(publicBase(env)) });
    return req.method === "HEAD" ? new Response(null, response) : response;
  }
  if (path === "/downloads/tendriller-first-app.tgz" && publicRead) {
    const response = await asset(env, url, path, {
      "Content-Type": "application/gzip", "Content-Disposition": 'attachment; filename="tendriller-first-app.tgz"',
      "X-Content-Type-Options": "nosniff", Link: onboardingLinks(publicBase(env)),
    });
    if (req.method === "HEAD") { await response.body?.cancel(); return new Response(null, response); }
    return response;
  }
  if (path === "/join/agent" && publicRead) {
    if (url.origin !== publicBase(env)) return errorResponse(404, "not_found");
    const response = agentJoinDocument(url, publicBase(env));
    return req.method === "HEAD" ? new Response(null, response) : response;
  }
  if (path === "/favicon.ico") return asset(env, url, "/_tendril/brand/favicon.ico");
  if (/^\/_tendril\/brand\/(logo\.(png|webp)|icon-(64|180)\.png|favicon\.ico)$/.test(path)) return asset(env, url, path);
  if (path === "/health") {
    const preview = isBranchPreview(env) && /^[a-f0-9]{40}$/.test(env.BRANCH_PREVIEW_SHA ?? "")
      ? { branch: env.BRANCH_PREVIEW_BRANCH, commit: env.BRANCH_PREVIEW_SHA } : undefined;
    return json(preview ? { ok: true, preview } : { ok: true });
  }
  if (path === "/status") {
    const state = await env.ACCOUNTS.prepare("SELECT mode FROM service_state WHERE id = 1").first<{ mode: string }>();
    const mode = state?.mode === "open" ? ["ok", "Operational", "Pages, sign-in and new page creation are available."]
      : state?.mode === "creation_paused" ? ["warn", "New page creation paused", "Existing pages keep working. New pages cannot be created right now."]
      : ["danger", "Read-only or unavailable", "Existing pages may be read-only. Changes are paused until service resumes."];
    return servicePage("Status", `<section class="hero"><span class="eyebrow">Service</span><h1>Tendriller status</h1><p class="lead">${mode[2]}</p><div class="actions"><span class="badge ${mode[0]}">${mode[1]}</span></div></section>`);
  }
  if (path === "/agent.md" || path === "/AGENTS.md" || path === "/llms.txt" || path === "/llms-full.txt" || /^\/docs\/(?:tools\/)?[A-Z0-9_-]+\.md$/.test(path)) {
    if (!publicRead) return errorResponse(405, "method_not_allowed", "Documentation is read-only");
    const guide = await asset(env, url, path);
    if (!guide.ok) return guide;
    const body = (await guide.text()).replaceAll("https://tendriller.dev", publicBase(env));
    return new Response(req.method === "HEAD" ? null : body, {
      headers: { "Content-Type": path.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Link: onboardingLinks(publicBase(env)) },
    });
  }
  if (/^\/docs\/assets\/app-patterns-(desktop|phone|states)\.png$/.test(path)) {
    if (!publicRead) return errorResponse(405, "method_not_allowed", "Documentation images are read-only");
    const response = await asset(env, url, path, {
      "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") { await response.body?.cancel(); return new Response(null, response); }
    return response;
  }
  if (path === "/contract/v3.json") return json(schemaDocument);
  if (["/terms", "/privacy", "/acceptable-use", "/copyright", "/law-enforcement"].includes(path)) {
    return asset(env, url, `/legal${path}.html`, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  }
  const runtime = /^\/_tendril\/runtime\/([a-f0-9]{64})\/([A-Za-z0-9_./-]+)$/.exec(path);
  if (runtime) return runtimeAsset(env, req, runtime[1], runtime[2], context);
  return errorResponse(404, "not_found", "Not found");
}

function pageAdmissionFailure(req: Request, env: Env, page: { id: string; key: string }, unavailable: boolean): Response {
  if (unavailable) return new Response("This page is unavailable pending review.", {
    status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
  if (req.method === "GET" || req.method === "HEAD") {
    return new Response(null, { status: 302, headers: { Location: `${publicBase(env)}/auth/page?tendril=${page.id}&key=${page.key}`,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return errorResponse(401, "unauthorized", "Page sign-in required");
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  try {
    if (path === "/api/service" && req.method === "GET")
      return json(serviceDescriptor(), 200, { Link: onboardingLinks(publicBase(env)) });
    if (path === "/api/readiness") {
      if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'Readiness is read-only');
      const readiness = await serviceReadiness(env);
      const response = json(readiness, readiness.mode === 'unavailable' ? 503 : 200, { Link: onboardingLinks(publicBase(env)) });
      return req.method === 'HEAD' ? new Response(null, response) : response;
    }
    if (path === "/api/setup") return routeAccountSetup(req, env);
    if (path === "/api/tendrils") {
      if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST");
      await requireCreationOpen(env);
      if (req.headers.has("Authorization")) throw new HttpError(400, "bad_request", "Creation uses an owner email, not an account key");
      if (env.CREATE_RATE && !(await env.CREATE_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
        throw new HttpError(429, "rate_limited", "Creation rate limit reached");
      }
      const body = await readBody(req, 64 * 1024);
      let createBody: unknown;
      try { createBody = JSON.parse(new TextDecoder().decode(body) || "{}"); }
      catch { throw new HttpError(400, "bad_json", "Request body is not valid JSON"); }
      if (!isPlainObject(createBody)) throw new HttpError(400, "bad_request", "Creation body must be an object");
      const lifetime = createBody.lifetime ?? "ad_hoc";
      if (lifetime !== "ad_hoc" && lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
      if (typeof createBody.owner !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(createBody.owner) || createBody.owner.length > 254)
        throw new HttpError(400, "bad_request", "owner must be a verified email address");
      if (lifetime === "resident") throw new HttpError(400, "bad_request", "Create an ad_hoc page; the agent can make it resident after the owner opens it");
      assertValid("create", createBody);
      const releaseIp = await reserveCreationIp(env, req);
      let created = false;
      try {
        for (let i = 0; i < 3; i++) {
          const id = newTendrilId();
          const admission = env.ADMISSION.get(env.ADMISSION.idFromName("global"));
          const allowed = await admission.fetch(new Request("https://admission.internal/reserve", { method: "POST", headers: { "x-tendril-id": id } }));
          if (!allowed.ok) return allowed;
          await allowed.body?.cancel();
          let indexed = false;
          const cancel = async () => {
            try {
              if (indexed) await env.ACCOUNTS!.prepare("DELETE FROM tendrils WHERE id = ?").bind(id).run();
            } finally {
              const cancelled = await admission.fetch(new Request("https://admission.internal/cancel", { method: "POST", headers: { "x-tendril-id": id } }));
              await cancelled.body?.cancel();
            }
          };
          let res: Response;
          try {
            try {
              await env.ACCOUNTS.prepare("INSERT INTO tendrils (id, owner_account, creator_ip, created_at, claimed_at, lifetime) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(id, null, req.headers.get("CF-Connecting-IP"), Date.now(), null, lifetime).run();
            } catch (err) {
              const message = String(err);
              if (message.includes("account_tendrils_full")) throw new HttpError(429, "quota", "Account tendril limit reached", { limit: 20 });
              if (message.includes("account_residents_full")) throw new HttpError(429, "quota", "Account resident tendril limit reached", { limit: RESIDENT_LIMIT });
              throw err;
            }
            indexed = true;
            res = await stub(env, id).fetch(
              new Request("https://tendril.internal/create", { method: "POST", headers: {
                "x-tendril-id": id, "Content-Type": "application/json",
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
      if (req.method === 'GET') return json({ schemaVersion: 1, serviceOrigin: publicBase(env),
        delegation: { applicationBound: true, nonReplacing: true, responseRecovery: false } }, 200, { 'Cache-Control': 'no-store' });
      if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST");
      const text = new TextDecoder().decode(await readBody(req, 4096));
      let code = "";
      let expectedMode: 'delegate' | undefined, applicationId: string | undefined;
      try {
        const input = JSON.parse(text || "{}");
        if (!isPlainObject(input) || typeof input.code !== 'string' ||
          input.expectedMode !== undefined && input.expectedMode !== 'delegate' ||
          input.applicationId !== undefined && (typeof input.applicationId !== 'string' || !/^[a-f0-9]{64}$/.test(input.applicationId)))
          return errorResponse(400, 'invalid_adoption_request', 'Provide a code and, for reviewed delegation, its application identity and expectedMode delegate.');
        code = input.code.trim(); expectedMode = input.expectedMode as 'delegate' | undefined; applicationId = input.applicationId as string | undefined;
      } catch {
        return errorResponse(400, "bad_json", "Request body is not valid JSON");
      }
      const m = /^([a-z2-7]{12})-(\d{6})$/.exec(code);
      if (!m) return errorResponse(400, "invalid_code", "Adopt codes look like <tendril id>-<6 digits>");
      return stub(env, m[1]).fetch(
        new Request("https://tendril.internal/adopt", { method: "POST", headers: { "x-tendril-id": m[1], "Content-Type": "application/json" }, body: JSON.stringify({ code, expectedMode, applicationId }) }),
      );
    }

    const m = /^\/api\/t\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (m) {
      if (!TENDRIL_ID_RE.test(m[1])) return errorResponse(404, "not_found", "No such tendril");
      const agentRest = safeDecode(m[2] ?? "");
      if (agentRest === 'assistant/activity') {
        if (url.origin !== publicBase(env) || !await parseActivityTicket(env, req, m[1])) throw new HttpError(401, 'activity_ticket_expired');
        return forward(env, m[1], 'assistant-activity', req, url, {});
      }
      if (agentRest === 'assistant/adapter') {
        const protocols = req.headers.get('Sec-WebSocket-Protocol')?.split(',').map(item => item.trim()) ?? [];
        if (!protocols.includes(ASSISTANT_PROTOCOL) || !protocols.some(item => ADAPTER_KEY.test(item)))
          throw new HttpError(401, 'adapter_not_approved');
        if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: 'assistant-adapter:' + (req.headers.get('CF-Connecting-IP') ?? 'unknown') })).success)
          throw new HttpError(429, 'rate_limited');
        return forward(env, m[1], 'assistant-adapter', req, url, {});
      }

      // Node's dependency-free WebSocket client cannot set Authorization. Keep the
      // private token in a TLS-protected subprotocol header, never in the URL.
      const peerSocket = agentRest === "peers/rendezvous" && req.headers.get("Upgrade")?.toLowerCase() === "websocket";
      const invitationSocket = agentRest === "peers/invitations" && req.headers.get("Upgrade")?.toLowerCase() === "websocket";
      const relaySocket = agentRest === "peers/relay" && req.headers.get("Upgrade")?.toLowerCase() === "websocket";
      const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
      const discoverySocket = agentRest === 'peers/discovery/watch' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      const setupSocket = agentRest === 'setup/watch' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      const socketToken = discoverySocket && protocols.includes('tendriller.discovery.v1') || setupSocket && protocols.includes('tendriller.setup.v1') || peerSocket && protocols.includes("tendriller.rendezvous.v1") ||
        invitationSocket && protocols.includes("tendriller.invitations.v1") || relaySocket && protocols.includes("tendriller.relay.v1")
        ? protocols.find((s) => AGENT_TOKEN_RE.test(s)) : undefined;
      const token = socketToken || /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
      if (token && env.AGENT_RATE && !(await env.AGENT_RATE.limit({ key: await sha256Hex(token) })).success) {
        throw new HttpError(429, "rate_limited", "Agent request rate limit reached");
      }
      const res = await forward(env, m[1], "agent", req, url, { "x-tendril-rest": encodeURIComponent(agentRest),
        ...(socketToken ? { Authorization: `Bearer ${socketToken}` } : {}) });
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
