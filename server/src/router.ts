import { routeMcp, routeMcpHttpGateway } from './mcp-gateway';
import { runtimeAsset, immutableAsset } from "./runtime-assets";
import { servicePage } from "./accounts/ui";
import { schemaDocument } from "../../contract/index.mjs";
// Worker router: authenticates nothing per-tendril itself; it routes to the Durable Object.
import type { Env } from "./env";
import { routeAuth } from "./accounts/auth";
import { routeIntegrationOAuth } from "./accounts/integration-oauth";
import { dashboard } from "./accounts/keys";
import { accountData } from "./accounts/data";
import { reportPage } from "./abuse/report";
import { adminPage, appealPage } from "./abuse/admin";
import { budgetWebhook } from "./budget";
import { redeemPageCode, routePageAuth } from "./accounts/page";
import { CORS_HEADERS, errorResponse, json, toErrorResponse, withCors } from "./http";
import { landingPage } from "./inject";
import { internalHeaders, routeAgentApi } from "./agents";
import { serviceDescriptor } from "./descriptor";
import { onboardingDescriptor, onboardingLinks } from "./onboarding";
import { capabilityCatalog } from "./capability-catalog";
import { isBranchPreview, parsePageRoute, publicBase } from "./urls";
import { serviceReadiness } from "./service-state";
import { PAGE_ACCESS_HEADER } from "./page";
import type { CacheContext } from "./immutable-cache";

function stub(env: Env, id: string): DurableObjectStub {
  return env.TENDRIL.get(env.TENDRIL.idFromName(id));
}

/** Forwards a request to the tendril's Durable Object under an internal path. */
function forward(env: Env, id: string, kind: string, req: Request, url: URL, headers: Record<string, string>): Promise<Response> {
  const h = internalHeaders(req);
  h.set("x-tendril-id", id);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const init: RequestInit = { method: req.method, headers: h, signal: req.signal, ...(kind === "mcp" || kind === "page" ? { redirect: "manual" } : {}) };
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


  if (path.startsWith('/v1/apps/')) return routeMcpHttpGateway(req, env, url);
  if (path === '/mcp' || path === '/connections' || path.startsWith('/connections/') ||
    path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')
    return routeMcp(req, env, url);
  if (path === '/.well-known/oauth-authorization-server' || path.startsWith('/oauth/')) return routeIntegrationOAuth(req, env, url);
  if (path === "/auth/page") return routePageAuth(req, env, url);
  if (path === "/report") return reportPage(req, env, url);
  if (path === "/internal/budget") return budgetWebhook(req, env);
  if (path === "/appeal" || path === "/appeal/account") return appealPage(req, env, url);
  if (path === "/admin" || path === "/admin/action" || /^\/admin\/t\/[a-z2-7]{12}$/.test(path)) return adminPage(req, env, url);
  if (path === "/auth" || path.startsWith("/auth/")) return routeAuth(req, env, url);
  if (path === "/dashboard/export" || path === "/dashboard/delete") return accountData(req, env, url);
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
    const agentResponse = await routeAgentApi(req, env, url);
    if (agentResponse) return agentResponse;
    return errorResponse(404, "not_found", "No such API route");
  } catch (err) {
    return toErrorResponse(err);
  }
}
