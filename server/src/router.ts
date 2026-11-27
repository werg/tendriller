import { routeMcp, routeMcpHttpGateway } from './mcp-gateway';
import { runtimeAsset, immutableAsset } from "./runtime-assets";
import { renderShell, servicePage } from "./accounts/ui";
import { copyAttrs, renderCopyText, SITE_COPY } from "./site-copy";
import { schemaDocument } from "../../contract/index.mjs";
// Worker router: authenticates nothing per-tendril itself; it routes to the Durable Object.
import type { Env } from "./env";
import { routeAuth, serviceSession } from "./accounts/auth";
import { routeIntegrationOAuth } from "./accounts/integration-oauth";
import { handleOutboundCallback, routeOutboundOAuthApi } from "./oauth-outbound/routes";
import { routeGroupsApi } from "./groups/org-groups";
import { dashboard } from "./accounts/keys";
import { accountData } from "./accounts/data";
import { reportPage } from "./abuse/report";
import { adminAccount, adminPage, appealPage } from "./abuse/admin";
import { ADMIN_API_PREFIX, routeAdministration } from "./admin/routes";
import { checkBroadcastAdminToken, createBroadcast, fleetVersionSummary, getChangelog, listActiveBroadcasts, listAllBroadcastsForAdmin, publicBroadcastKeys, revokeBroadcast, validAudienceParam } from "./broadcasts";
import { budgetWebhook } from "./budget";
import { polarWebhookRoute, pricingPage, routeBillingDashboard, selfHostPage } from "./billing/routes";
import { resolveCustomDomainRequest, routeCustomDomains } from "./custom-domains";
import { resolveSubdomainRequest } from "./subdomains";
import { redeemPageCode, routePageAuth } from "./accounts/page";
import { CORS_HEADERS, errorResponse, json, readJson, toErrorResponse, withCors } from "./http";
import { escapeHtml, landingPage } from "./inject";
import { etagMatches } from "./immutable-cache";
import { BROADCAST_ID_RE, TENDRIL_ID_RE } from "./ids";
import { agentPlatformHtml, agentPlatformIndexHtml, agentPlatformIndexMd, agentPlatformMd } from "./agent-platforms";
import { internalHeaders, routeAgentApi } from "./agents";
import { serviceDescriptor } from "./descriptor";
import { hostAttestationKey } from "./host-attestation";
import { onboardingDescriptor, onboardingLinks } from "./onboarding";
import { capabilityCatalog } from "./capability-catalog";
import { isBranchPreview, parseBarePagePath, parseKeyedPagePath, parsePageHostLabel, publicBase, type PageRoute } from "./urls";
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
  const reqUrl = new URL(req.url);
  const host = reqUrl.hostname.toLowerCase();
  const pagesDomain = env.PAGE_BASE_DOMAIN?.toLowerCase();
  const serviceHost = new URL(publicBase(env)).hostname.toLowerCase();
  const onStandardPagesDomain = host !== serviceHost && !!pagesDomain && (host === pagesDomain || host.endsWith(`.${pagesDomain}`));
  const customSubdomain = onStandardPagesDomain
    ? await resolveSubdomainRequest(reqUrl, env)
    : null;
  const customDomain = !onStandardPagesDomain && host !== serviceHost
    ? await resolveCustomDomainRequest(reqUrl, env)
    : null;
  const onPagesDomain = onStandardPagesDomain || Boolean(customDomain);
  let res: Response;
  try { res = await routeInner(req, env, onPagesDomain, customSubdomain, customDomain, context); }
  catch (err) { res = toErrorResponse(err); }
  const preview = isBranchPreview(env);
  if (onPagesDomain || preview) {
    const headers = new Headers(res.headers);
    if (onPagesDomain && reqUrl.protocol === "https:") {
      headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    if (preview) headers.set("X-Robots-Tag", "noindex, nofollow");
    if (res.status === 101) return new Response(null, { status: 101, headers, webSocket: res.webSocket });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  return res;
}

async function routeInner(
  req: Request,
  env: Env,
  onPagesDomain: boolean,
  customSubdomain: Awaited<ReturnType<typeof resolveSubdomainRequest>>,
  customDomain: Awaited<ReturnType<typeof resolveCustomDomainRequest>>,
  context?: CacheContext,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const rootRuntime = /^\/_tendril\/runtime\/([a-f0-9]{64})\/([A-Za-z0-9_./-]+)$/.exec(path);
  const rootBrand = path === '/favicon.ico' || /^\/_tendril\/brand\/(logo\.(png|webp)|icon-(64|180|192|512)\.png|favicon\.ico)$/.test(path);
  const publicRead = (req.method === 'GET' || req.method === 'HEAD') && req.headers.get('Upgrade')?.toLowerCase() !== 'websocket';

  let pageHost: { id: string; customHost: string | null; hostKind: "custom_domain" | "subdomain" | "id" } | null = null;
  if (customDomain) {
    if (!customDomain.entitlementOk) {
      return errorResponse(402, "plan_required", "This custom domain is paused because the account is no longer on the Team plan. Open the page from your Tendriller dashboard.");
    }
    pageHost = { id: customDomain.record.tendril_id, customHost: customDomain.record.hostname, hostKind: "custom_domain" };
  } else if (customSubdomain) {
    if (!customSubdomain.entitlementOk) {
      return errorResponse(402, "plan_required", "This named subdomain is paused because the account is no longer on a paid plan. Open the page from your Tendriller dashboard.");
    }
    pageHost = { id: customSubdomain.record.tendril_id, customHost: customSubdomain.host, hostKind: "subdomain" };
  } else if (onPagesDomain) {
    const label = parsePageHostLabel(url, env);
    if (!label || !TENDRIL_ID_RE.test(label)) {
      return errorResponse(404, "not_found", "Not found");
    }
    pageHost = { id: label, customHost: null, hostKind: "id" };
  }
  if (!onPagesDomain && url.origin !== new URL(publicBase(env)).origin) return errorResponse(404, "not_found", "Not found");

  if (path === ADMIN_API_PREFIX || path.startsWith(`${ADMIN_API_PREFIX}/`)) {
    if (onPagesDomain) return errorResponse(404, "not_found");
    return routeAdministration(req, env, url);
  }

  if (publicRead && rootRuntime) return runtimeAsset(env, req, rootRuntime[1], rootRuntime[2], context);
  if (publicRead && rootBrand) {
    const response = await asset(env, url, path === '/favicon.ico' ? '/_tendril/brand/favicon.ico' : path);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') { await response.body?.cancel(); return new Response(null, response); }
    return response;
  }

  // Pages: keyed `/s/<key>/` or bare root `/` on standard subdomain, named subdomain, or verified custom domain.
  let page: PageRoute | null = null;
  const customHost = pageHost?.customHost ?? null;
  if (pageHost) {
    const keyed = parseKeyedPagePath(url, pageHost.id);
    if (keyed) {
      page = keyed;
    } else {
      // For standard gibberish IDs, verify the page exists in D1 before opening bare-domain routing
      // so probes against unknown IDs fail closed with 404 and zero DO invocations.
      if (pageHost.hostKind === "id") {
        const exists = env.ACCOUNTS
          ? await env.ACCOUNTS.prepare("SELECT 1 FROM tendrils WHERE id = ?").bind(pageHost.id).first().catch(() => null)
          : null;
        if (!exists) return errorResponse(404, "not_found", "Not found");
      }
      page = parseBarePagePath(url, pageHost.id);
    }
  }
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
      return redeemPageCode(env, page.id, page.key, url.searchParams.get("code") ?? "", customHost, Boolean(page.bare));
    }
    const rest = page.rest;
    // These platform bytes are already public on the service origin. Fetching
    // them on a valid page origin must not wake that page or query its account.
    const runtime = /^_tendril\/runtime\/([a-f0-9]{64})\/([A-Za-z0-9_./-]+)$/.exec(rest);
    const brand = /^_tendril\/brand\/(icon-(64|180|192|512)\.png|favicon\.ico)$/.test(rest);
    if ((req.method === "GET" || req.method === "HEAD") && req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      if (runtime && !runtime[2].split("/").includes("..")) return runtimeAsset(env, req, runtime[1], runtime[2], context);
      if (brand) return asset(env, url, `/${rest}`);
    }
    const resource = /^_tendril\/assets\/([a-f0-9]{64})\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,199})$/.exec(rest);
    // Optional resources and the scoped service worker keep their existing
    // access gate; authored files and page APIs authenticate in their one DO call.
    if (resource || rest === "_tendril/sw.js") {
      const check = await stub(env, page.id).fetch(new Request("https://tendril.internal/claim/check", {
        headers: { "x-tendril-key": page.key, ...(page.bare ? { "x-tendril-bare": "1" } : {}), Cookie: req.headers.get("Cookie") ?? "",
          "x-visitor-ip": req.headers.get("CF-Connecting-IP") ?? "" },
      }));
      if (!check.ok && ![401, 403, 404].includes(check.status)) return check;
      await check.body?.cancel();
      if (!check.ok) return pageAdmissionFailure(req, env, page, check.status === 403, customHost);
      if (resource) return immutableAsset(env, req, resource[1], resource[2], context);
      return asset(env, url, "/_tendril/sw.js", { "Service-Worker-Allowed": page.base, "Cache-Control": "private, max-age=300" });
    }
    const response = await forward(env, page.id, "page", req, url, {
      "x-tendril-key": page.key,
      ...(page.bare ? { "x-tendril-bare": "1" } : {}),
      "x-tendril-origin": url.origin,
      "x-tendril-base": page.base,
      "x-tendril-rest": encodeURIComponent(rest),
      "x-visitor-ip": req.headers.get("CF-Connecting-IP") ?? "",
    });
    const denied = response.headers.get(PAGE_ACCESS_HEADER);
    if (denied === "signin" || denied === "unavailable") {
      await response.body?.cancel();
      return pageAdmissionFailure(req, env, page, denied === "unavailable", customHost);
    }
    return response;
  }

  if (path === "/api/webhooks/polar") return polarWebhookRoute(req, env);
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
  if (path === "/admin" || path === "/admin/action" || path === "/admin/broadcast" || path === "/admin/broadcast/revoke" || /^\/admin\/t\/[a-z2-7]{12}$/.test(path)) return adminPage(req, env, url);
  const outboundCb = /^\/auth\/outbound\/callback\/([^/]{2,96})$/.exec(path);
  if (outboundCb && req.method === "GET") return handleOutboundCallback(req, env, url, decodeURIComponent(outboundCb[1]!));
  if (path === "/auth" || path.startsWith("/auth/")) return routeAuth(req, env, url);
  if (path === "/pricing") {
    const accept = req.headers.get("Accept") ?? "";
    if (publicRead && accept.includes("text/markdown") && !accept.includes("text/html")) {
      const guide = await asset(env, url, "/docs/PRICING.md");
      if (guide.ok) {
        const body = (await guide.text()).replaceAll("https://tendriller.dev", publicBase(env));
        return new Response(req.method === "HEAD" ? null : body, {
          headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Accept", Link: onboardingLinks(publicBase(env)) },
        });
      }
    }
    return pricingPage(req, env);
  }
  if (path === "/pricing.md" || path === "/self-host.md" || path === "/changelog.md") {
    if (!publicRead) return errorResponse(405, "method_not_allowed", "Documentation is read-only");
    const docPath = path === "/pricing.md" ? "/docs/PRICING.md" : path === "/self-host.md" ? "/docs/SELF_HOSTING.md" : "/docs/CHANGELOG.md";
    const guide = await asset(env, url, docPath);
    if (!guide.ok) return guide;
    const body = (await guide.text()).replaceAll("https://tendriller.dev", publicBase(env));
    return new Response(req.method === "HEAD" ? null : body, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Link: onboardingLinks(publicBase(env)) },
    });
  }
  if (path === "/self-host") return selfHostPage(req, env);
  if (path === "/dashboard/domains" || path.startsWith("/dashboard/domains/")) return routeCustomDomains(req, env, url);
  if (path === "/dashboard/billing" || path.startsWith("/dashboard/billing/")) return routeBillingDashboard(req, env, url);
  if (path === "/dashboard/export" || path === "/dashboard/delete") return accountData(req, env, url);
  if (path === "/dashboard" || path.startsWith("/dashboard/")) return dashboard(req, env, url);

  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    const explicitHome = url.searchParams.has("home");
    const session = env.ACCOUNTS ? await serviceSession(req, env, true).catch(() => null) : null;
    if (session && !explicitHome) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/dashboard", "Cache-Control": "private, no-store", Vary: "Cookie" },
      });
    }
    return new Response(req.method === "HEAD" ? null : landingPage(publicBase(env), { signedIn: Boolean(session) }), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": session ? "private, no-store" : "public, max-age=60",
        Vary: "Cookie",
        Link: onboardingLinks(publicBase(env)),
      },
    });
  }
  if (path === "/agents" || path === "/agents/") {
    if (!publicRead) return errorResponse(405, "method_not_allowed", "Platform guides are read-only");
    return new Response(req.method === "HEAD" ? null : agentPlatformIndexHtml(publicBase(env)), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Link: onboardingLinks(publicBase(env)) },
    });
  }
  if (path === "/agents.md") {
    if (!publicRead) return errorResponse(405, "method_not_allowed", "Platform guides are read-only");
    return new Response(req.method === "HEAD" ? null : agentPlatformIndexMd(publicBase(env)), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Link: onboardingLinks(publicBase(env)) },
    });
  }
  const agentPlatformRoute = /^\/agents\/([a-z0-9-]+)(\.md)?$/.exec(path);
  if (agentPlatformRoute) {
    if (!publicRead) return errorResponse(405, "method_not_allowed", "Platform guides are read-only");
    const [, slug, isMd] = agentPlatformRoute;
    const body = isMd ? agentPlatformMd(slug, publicBase(env)) : agentPlatformHtml(slug, publicBase(env));
    if (!body) return errorResponse(404, "not_found", "Not found");
    return new Response(req.method === "HEAD" ? null : body, {
      headers: {
        "Content-Type": isMd ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...(isMd ? { "X-Content-Type-Options": "nosniff" } : {}),
        Link: onboardingLinks(publicBase(env)),
      },
    });
  }
  if (path === "/.well-known/tendriller.json" && publicRead) {
    const keys = await publicBroadcastKeys(env).then(r => r.keys).catch(() => []);
    const response = json({ ...onboardingDescriptor(publicBase(env)), attestationKey: hostAttestationKey(env), ...(keys.length ? { broadcast_keys: keys } : {}) }, 200, { Link: onboardingLinks(publicBase(env)) });
    return req.method === "HEAD" ? new Response(null, response) : response;
  }
  if (path === "/.well-known/tendriller-broadcast-keys.json" && publicRead) {
    const response = withCors(json(await publicBroadcastKeys(env), 200, { "Cache-Control": "public, max-age=300", Link: onboardingLinks(publicBase(env)) }));
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
  if (/^\/_tendril\/brand\/(logo\.(png|webp)|icon-(64|180|192|512)\.png|favicon\.ico)$/.test(path)) return asset(env, url, path);
  if (path === "/health") {
    const preview = isBranchPreview(env) && /^[a-f0-9]{40}$/.test(env.BRANCH_PREVIEW_SHA ?? "")
      ? { branch: env.BRANCH_PREVIEW_BRANCH, commit: env.BRANCH_PREVIEW_SHA } : undefined;
    return json(preview ? { ok: true, preview } : { ok: true });
  }
  if (path === "/status") {
    const [state, feed] = await Promise.all([
      env.ACCOUNTS.prepare("SELECT mode FROM service_state WHERE id = 1").first<{ mode: string }>(),
      listActiveBroadcasts(env, { audiences: ["dashboard", "page_all"] }),
    ]);
    return servicePage("Status", renderStatusBody({
      mode: state?.mode === "open" ? "open" : state?.mode === "creation_paused" ? "creation_paused" : "unavailable",
      broadcasts: feed.broadcasts.map(({ payload }) => ({
        kind: payload.kind,
        severity: payload.severity,
        title: payload.title,
        summary: payload.summary,
        docs_url: payload.docs_url ?? null,
      })),
    }));
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
    const raw = await asset(env, url, `/legal${path}.html`, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    if (!raw.ok) return raw;
    const source = await raw.text();
    const title = (/<title>([^<]+)<\/title>/i.exec(source)?.[1] ?? "Legal · Tendriller").replace(/\s*·\s*Tendriller\s*$/i, "");
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(source)?.[1];
    if (!main) return new Response(req.method === "HEAD" ? null : source, { headers: raw.headers });
    const legalLinks: readonly [string, string][] = [
      ["/terms", "Terms"],
      ["/privacy", "Privacy"],
      ["/acceptable-use", "Acceptable use"],
      ["/copyright", "Copyright"],
      ["/law-enforcement", "Law-enforcement"],
    ];
    const subnav = `<nav class="prose-subnav" aria-label="Legal policies">${legalLinks.map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join("")}</nav>`;
    const wrapped = servicePage(title, `${subnav}<article class="card prose">${main}</article>`);
    return req.method === "HEAD" ? new Response(null, { status: wrapped.status, headers: wrapped.headers }) : wrapped;
  }
  const runtime = /^\/_tendril\/runtime\/([a-f0-9]{64})\/([A-Za-z0-9_./-]+)$/.exec(path);
  if (runtime) return runtimeAsset(env, req, runtime[1], runtime[2], context);
  return errorResponse(404, "not_found", "Not found");
}

export function renderStatusBody(options: {
  mode: "open" | "creation_paused" | "unavailable";
  broadcasts?: Array<{ kind: string; severity: string; title: string; summary: string; docs_url?: string | null }>;
  editable?: boolean;
}): string {
  const editable = Boolean(options.editable);
  const st = SITE_COPY.status;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const tone = options.mode === "open" ? "ok" : options.mode === "creation_paused" ? "warn" : "danger";
  const m = st.modes[options.mode];
  const broadcasts = options.broadcasts ?? [];
  const noticesHtml = broadcasts.length
    ? `<section class="card"><h2${c("status.noticesTitle", st.noticesTitle)}>${renderCopyText(st.noticesTitle)}</h2><ul class="list">${broadcasts.map((payload) => {
        const badge = payload.severity === "critical" || payload.severity === "urgent" ? "danger" : payload.severity === "recommended" ? "warn" : "";
        return `<li class="list-item"><div class="list-item-main"><div class="list-item-title"><span class="badge ${badge}">${escapeHtml(payload.kind)} · ${escapeHtml(payload.severity)}</span> ${escapeHtml(payload.title)}</div><p class="list-item-sub">${escapeHtml(payload.summary)}${payload.docs_url ? ` · <a href="${escapeHtml(payload.docs_url)}" rel="noopener">Details</a>` : ""}</p></div></li>`;
      }).join("")}</ul></section>`
    : "";
  return `<div class="stack"><section class="hero"><span class="eyebrow"${c("status.eyebrow", st.eyebrow)}>${renderCopyText(st.eyebrow)}</span><h1${c("status.title", st.title)}>${renderCopyText(st.title)}</h1><p class="lead"${c(`status.modes.${options.mode}.lead`, m.lead)}>${renderCopyText(m.lead)}</p><div class="actions"><span class="badge ${tone}"${c(`status.modes.${options.mode}.badge`, m.badge)}>${renderCopyText(m.badge)}</span></div></section>${noticesHtml}</div>`;
}

export function renderStatusPageHtml(options: {
  mode?: "open" | "creation_paused" | "unavailable";
  broadcasts?: Array<{ kind: string; severity: string; title: string; summary: string; docs_url?: string | null }>;
  editable?: boolean;
} = {}): string {
  return renderShell({
    title: "Status",
    body: renderStatusBody({
      mode: options.mode ?? "open",
      broadcasts: options.broadcasts,
      editable: options.editable,
    }),
  });
}

function pageAdmissionFailure(req: Request, env: Env, page: { id: string; key: string; bare?: boolean }, unavailable: boolean, customHost?: string | null): Response {
  if (unavailable) return new Response("This page is unavailable pending review.", {
    status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
  if (req.method === "GET" || req.method === "HEAD") {
    const hostParam = customHost ? `&host=${encodeURIComponent(customHost)}` : "";
    const query = page.bare ? `tendril=${page.id}&bare=1${hostParam}` : `tendril=${page.id}&key=${page.key}${hostParam}`;
    return new Response(null, { status: 302, headers: { Location: `${publicBase(env)}/auth/page?${query}`,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return errorResponse(401, "unauthorized", "Page sign-in required");
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  try {
    if (path === "/api/service" && req.method === "GET")
      return json(serviceDescriptor(env), 200, { Link: onboardingLinks(publicBase(env)) });
    if (path === "/api/readiness") {
      if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'Readiness is read-only');
      const readiness = await serviceReadiness(env);
      const response = json(readiness, readiness.mode === 'unavailable' ? 503 : 200, { Link: onboardingLinks(publicBase(env)) });
      return req.method === 'HEAD' ? new Response(null, response) : response;
    }
    if (path === "/api/changelog") {
      if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'Changelog is read-only');
      const accept = req.headers.get('Accept') ?? '';
      if (accept.includes('text/markdown') && !accept.includes('application/json')) {
        const guide = await asset(env, url, '/docs/CHANGELOG.md');
        if (guide.ok) {
          const body = (await guide.text()).replaceAll('https://tendriller.dev', publicBase(env));
          return new Response(req.method === 'HEAD' ? null : body, {
            headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept', Link: onboardingLinks(publicBase(env)) },
          });
        }
      }
      const limitRaw = url.searchParams.get('limit');
      if (limitRaw !== null && !/^\d+$/.test(limitRaw)) return errorResponse(400, 'bad_request', 'limit must be a positive integer');
      const data = getChangelog(env, {
        since: url.searchParams.get('since'),
        sinceCore: url.searchParams.get('since_core'),
        category: url.searchParams.get('category'),
        ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
      });
      const response = withCors(json(data, 200, { 'Cache-Control': 'public, max-age=60', Link: onboardingLinks(publicBase(env)) }));
      return req.method === 'HEAD' ? new Response(null, response) : response;
    }
    if (path === "/api/broadcasts") {
      if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'Broadcasts feed is read-only');
      const audience = validAudienceParam(url.searchParams.get('audience'));
      const sinceRaw = url.searchParams.get('since');
      if (sinceRaw !== null && !/^\d+$/.test(sinceRaw)) return errorResponse(400, 'bad_request', 'since must be a non-negative integer');
      const since = sinceRaw !== null ? Number(sinceRaw) : 0;
      const feed = await listActiveBroadcasts(env, { audience, since });
      if (etagMatches(req.headers.get('If-None-Match'), feed.etag)) {
        return new Response(null, { status: 304, headers: { ETag: feed.etag, 'Cache-Control': 'public, max-age=60' } });
      }
      const response = json({
        issuer: feed.issuer,
        keys: feed.keys,
        latest_seq: feed.latest_seq,
        broadcasts: feed.broadcasts,
      }, 200, { ETag: feed.etag, 'Cache-Control': 'public, max-age=60', Link: onboardingLinks(publicBase(env)) });
      return req.method === 'HEAD' ? new Response(null, response) : response;
    }
    if (path === "/api/admin/broadcasts" || /^\/api\/admin\/broadcasts\/[^/]+$/.test(path)) {
      const tokenAdmin = await checkBroadcastAdminToken(req, env);
      const sessionAdmin = tokenAdmin ? null : await adminAccount(req, env);
      const actor = tokenAdmin ? 'broadcast_admin_token' : sessionAdmin;
      if (!actor) return errorResponse(404, 'not_found', 'Not found');
      if (path === "/api/admin/broadcasts") {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const [broadcasts, fleet, keysInfo] = await Promise.all([
            listAllBroadcastsForAdmin(env, 100),
            fleetVersionSummary(env),
            publicBroadcastKeys(env),
          ]);
          const response = json({ issuer: keysInfo.issuer, keys: keysInfo.keys, fleet, broadcasts }, 200, { 'Cache-Control': 'no-store' });
          return req.method === 'HEAD' ? new Response(null, response) : response;
        }
        if (req.method === 'POST') {
          const input = await readJson(req, 32 * 1024);
          const created = await createBroadcast(env, actor, input);
          return json(created, 201, { 'Cache-Control': 'no-store' });
        }
        return errorResponse(405, 'method_not_allowed');
      }
      const id = path.slice('/api/admin/broadcasts/'.length);
      if (!BROADCAST_ID_RE.test(id)) return errorResponse(404, 'not_found');
      if (req.method === 'DELETE') {
        const reason = url.searchParams.get('reason')?.trim() || 'Revoked via admin API';
        const revoked = await revokeBroadcast(env, actor, id, reason);
        if (!revoked) return errorResponse(404, 'not_found', 'No active broadcast with that id');
        return json({ revoked: true, id }, 200, { 'Cache-Control': 'no-store' });
      }
      return errorResponse(405, 'method_not_allowed');
    }
    const outboundResponse = await routeOutboundOAuthApi(req, env, url);
    if (outboundResponse) return outboundResponse;
    const groupsResponse = await routeGroupsApi(req, env, url);
    if (groupsResponse) return groupsResponse;
    const agentResponse = await routeAgentApi(req, env, url);
    if (agentResponse) return agentResponse;
    return errorResponse(404, "not_found", "No such API route");
  } catch (err) {
    return toErrorResponse(err);
  }
}
