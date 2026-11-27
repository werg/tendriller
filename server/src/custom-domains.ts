/**
 * Per-page custom domains (`app.yourteam.com/s/<key>/`) for Team & Self-Hosted plans.
 * Supports Cloudflare for SaaS Custom Hostnames (100 free, $0.10/mo each — no Enterprise required)
 * and self-hosted DNS TXT verification via DNS-over-HTTPS when SaaS tokens are absent.
 */
import type { Env } from "./env";
import { errorResponse, HttpError, json, readBody, toErrorResponse } from "./http";
import { PAGE_KEY_RE, TENDRIL_ID_RE } from "./ids";
import { brandBase, brandMark } from "./brand";
import { serviceSession } from "./accounts/auth";
import { icon, servicePage } from "./accounts/ui";
import { getAccountEntitlements } from "./billing/entitlements";
import { requireWritesOpen } from "./service-state";
import { publicBase, type PageRoute } from "./urls";

export interface CustomDomainRow {
  hostname: string;
  account_id: string;
  tendril_id: string;
  status: "pending" | "active" | "error";
  cf_hostname_id: string | null;
  verification_txt_name: string | null;
  verification_txt_value: string | null;
  ssl_status: string | null;
  last_error: string | null;
  created_at: number;
  verified_at: number | null;
  updated_at: number;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}

function sameOrigin(req: Request, env: Env): void {
  const expected = new URL(publicBase(env)).origin;
  if (req.headers.get("Origin") !== expected) {
    throw new HttpError(403, "bad_origin", "Invalid request origin.");
  }
}

function fallbackOriginHost(env: Env): string {
  const explicit = env.CF_SAAS_FALLBACK_ORIGIN?.trim().toLowerCase();
  if (explicit) return explicit;
  return (env.PAGE_BASE_DOMAIN || new URL(publicBase(env)).hostname).toLowerCase();
}

function cfSaasConfigured(env: Env): boolean {
  return Boolean(env.CF_SAAS_ZONE_ID && env.CF_SAAS_API_TOKEN);
}

function cfSaasBase(env: Env): string {
  return (env.CF_SAAS_API_BASE?.trim() || "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
}

/** Validate and normalize a user-supplied custom domain hostname. Returns null if invalid or reserved. */
export function normalizeCustomHostname(raw: string, env: Env): string | null {
  let host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  host = host.replace(/\.+$/, "");
  if (!host || host.length > 253 || host.includes(":") || IPV4_RE.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (labels.some((l) => !LABEL_RE.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (tld === "localhost" || tld === "local" || tld === "internal" || tld === "arpa" || /^\d+$/.test(tld)) return null;

  const serviceHost = new URL(publicBase(env)).hostname.toLowerCase();
  const pageBase = (env.PAGE_BASE_DOMAIN || "").toLowerCase();
  if (host === serviceHost || host.endsWith(`.${serviceHost}`)) return null;
  if (pageBase && (host === pageBase || host.endsWith(`.${pageBase}`))) return null;
  return host;
}

function randomHex(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface CfSaasResult {
  id?: string;
  status?: string;
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string;
    validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    validation_errors?: Array<{ message?: string }>;
  };
  verification_errors?: string[];
}

function parseCfResult(r: CfSaasResult): {
  status: "pending" | "active" | "error";
  sslStatus: string | null;
  txtName: string | null;
  txtValue: string | null;
  lastError: string | null;
} {
  const sslStatus = r.ssl?.status ?? null;
  const txtName = r.ownership_verification?.name ?? r.ssl?.validation_records?.[0]?.txt_name ?? null;
  const txtValue = r.ownership_verification?.value ?? r.ssl?.validation_records?.[0]?.txt_value ?? null;
  const errors = [
    ...(r.verification_errors ?? []),
    ...(r.ssl?.validation_errors?.map((e) => e.message).filter((m): m is string => Boolean(m)) ?? []),
  ];
  const lastError = errors.length ? errors.join("; ").slice(0, 400) : null;
  const isActive = r.status === "active" && (!sslStatus || sslStatus === "active");
  const isError = r.status === "moved" || r.status === "deleted" || sslStatus === "validation_timed_out";
  return {
    status: isActive ? "active" : isError ? "error" : "pending",
    sslStatus,
    txtName,
    txtValue,
    lastError,
  };
}

async function createCfSaasHostname(env: Env, hostname: string) {
  const res = await fetch(`${cfSaasBase(env)}/zones/${encodeURIComponent(env.CF_SAAS_ZONE_ID!)}/custom_hostnames`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_SAAS_API_TOKEN!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hostname, ssl: { method: "txt", type: "dv" } }),
  });
  const payload = await res.json().catch(() => null) as { success?: boolean; result?: CfSaasResult; errors?: Array<{ message?: string }> } | null;
  if (!res.ok || !payload?.success || !payload.result?.id) {
    const msg = payload?.errors?.[0]?.message || `Cloudflare Custom Hostnames API returned ${res.status}`;
    throw new HttpError(502, "saas_hostname_failed", msg);
  }
  return { cfHostnameId: payload.result.id, ...parseCfResult(payload.result) };
}

async function refreshCfSaasHostname(env: Env, cfHostnameId: string) {
  const res = await fetch(
    `${cfSaasBase(env)}/zones/${encodeURIComponent(env.CF_SAAS_ZONE_ID!)}/custom_hostnames/${encodeURIComponent(cfHostnameId)}`,
    { headers: { Authorization: `Bearer ${env.CF_SAAS_API_TOKEN!}` } },
  );
  const payload = await res.json().catch(() => null) as { success?: boolean; result?: CfSaasResult; errors?: Array<{ message?: string }> } | null;
  if (!res.ok || !payload?.success || !payload.result) {
    const msg = payload?.errors?.[0]?.message || `Could not refresh Cloudflare hostname (${res.status})`;
    throw new HttpError(502, "saas_hostname_failed", msg);
  }
  return parseCfResult(payload.result);
}

async function deleteCfSaasHostname(env: Env, cfHostnameId: string): Promise<void> {
  if (!cfSaasConfigured(env) || !cfHostnameId) return;
  try {
    await fetch(
      `${cfSaasBase(env)}/zones/${encodeURIComponent(env.CF_SAAS_ZONE_ID!)}/custom_hostnames/${encodeURIComponent(cfHostnameId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${env.CF_SAAS_API_TOKEN!}` } },
    );
  } catch { /* best-effort cleanup */ }
}

async function verifyDnsTxtRecord(env: Env, txtName: string, expectedValue: string): Promise<boolean> {
  const base = (env.DNS_VERIFY_BASE?.trim() || "https://cloudflare-dns.com/dns-query").replace(/\/+$/, "");
  const res = await fetch(`${base}?name=${encodeURIComponent(txtName)}&type=TXT`, {
    headers: { Accept: "application/dns-json" },
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => null) as { Answer?: Array<{ type?: number; data?: string }> } | null;
  if (!Array.isArray(data?.Answer)) return false;
  return data.Answer.some((a) => {
    const cleaned = (a.data ?? "").replace(/^"|"$/g, "").replace(/"\s*"/g, "");
    return cleaned === expectedValue;
  });
}

function decodeRest(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Look up an active custom domain for an incoming Worker request on a non-service, non-pages hostname. */
export async function resolveCustomDomainRequest(
  url: URL,
  env: Env,
): Promise<{ record: CustomDomainRow; page: PageRoute | null; entitlementOk: boolean } | null> {
  if (!env.ACCOUNTS) return null;
  const host = url.hostname.toLowerCase();
  const row = await env.ACCOUNTS.prepare(
    "SELECT hostname, account_id, tendril_id, status, cf_hostname_id, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at, updated_at FROM custom_domains WHERE hostname = ? AND status = 'active'",
  ).bind(host).first<CustomDomainRow>().catch(() => null);
  if (!row) return null;

  const ent = await getAccountEntitlements(env, row.account_id).catch(() => null);
  const entitlementOk = Boolean(ent && (ent.unlimitedHost || ent.quotas.customDomain));

  const m = /^\/s\/([a-z2-7]{26})(\/.*)?$/.exec(url.pathname);
  const page: PageRoute | null = m && PAGE_KEY_RE.test(m[1]!)
    ? { id: row.tendril_id, key: m[1]!, base: `/s/${m[1]!}/`, rest: m[2] === undefined ? null : decodeRest(m[2].slice(1)) }
    : null;
  return { record: row, page, entitlementOk };
}

/** Strict allow-list check used by `/auth/page` so redirects only ever target a verified custom domain bound to this exact page. */
export async function isActiveCustomDomainForPage(env: Env, rawHost: string | null | undefined, tendrilId: string): Promise<string | null> {
  if (!env.ACCOUNTS || !rawHost) return null;
  const host = normalizeCustomHostname(rawHost, env);
  if (!host) return null;
  const row = await env.ACCOUNTS.prepare(
    "SELECT account_id FROM custom_domains WHERE hostname = ? AND tendril_id = ? AND status = 'active'",
  ).bind(host, tendrilId).first<{ account_id: string }>().catch(() => null);
  if (!row) return null;
  const ent = await getAccountEntitlements(env, row.account_id).catch(() => null);
  if (!ent || (!ent.unlimitedHost && !ent.quotas.customDomain)) return null;
  return host;
}

/** Clean up Cloudflare for SaaS custom hostname (if any) when a page is deleted. */
export async function cleanupPageCustomDomain(env: Env, tendrilId: string): Promise<void> {
  if (!env.ACCOUNTS) return;
  const row = await env.ACCOUNTS.prepare("SELECT cf_hostname_id FROM custom_domains WHERE tendril_id = ?")
    .bind(tendrilId).first<{ cf_hostname_id: string | null }>().catch(() => null);
  if (row?.cf_hostname_id) await deleteCfSaasHostname(env, row.cf_hostname_id);
}

function parseFormOrJson(req: Request, raw: string): { isJson: boolean; params: Record<string, unknown> } {
  const isJson = (req.headers.get("Content-Type") ?? "").includes("application/json");
  if (!isJson) return { isJson: false, params: Object.fromEntries(new URLSearchParams(raw)) };
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "bad_json", "Expected a JSON object.");
    }
    return { isJson: true, params: parsed as Record<string, unknown> };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "bad_json", "Request body is not valid JSON.");
  }
}

async function renderDomainsPage(env: Env, url: URL, accountId: string): Promise<Response> {
  const [ent, domainsRes, pagesRes] = await Promise.all([
    getAccountEntitlements(env, accountId),
    env.ACCOUNTS.prepare(
      "SELECT hostname, account_id, tendril_id, status, cf_hostname_id, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at, updated_at FROM custom_domains WHERE account_id = ? ORDER BY created_at DESC",
    ).bind(accountId).all<CustomDomainRow>(),
    env.ACCOUNTS.prepare(
      "SELECT id, created_at FROM tendrils WHERE owner_account = ? AND state = 'active' ORDER BY created_at DESC",
    ).bind(accountId).all<{ id: string; created_at: number }>(),
  ]);

  const allowed = ent.unlimitedHost || ent.quotas.customDomain;
  const fallbackTarget = fallbackOriginHost(env);
  const boundPageIds = new Set(domainsRes.results.map((d) => d.tendril_id));
  const availablePages = pagesRes.results.filter((p) => !boundPageIds.has(p.id));

  const alerts: string[] = [];
  const flash = url.searchParams.get("status");
  if (flash === "added") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Custom domain added. Point your DNS records below, then click <strong>Verify DNS</strong>.</span></p>`);
  if (flash === "verified") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Custom domain verified and active!</span></p>`);
  if (flash === "pending") alerts.push(`<p class="notice warn" role="status">${icon("clock")}<span>DNS verification is still pending. Check your CNAME and TXT records and try again in a minute.</span></p>`);
  if (flash === "removed") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Custom domain removed.</span></p>`);
  const errMsg = url.searchParams.get("error");
  if (errMsg) alerts.push(`<p class="notice danger" role="alert">${icon("x")}<span>${escape(errMsg)}</span></p>`);

  const domainRows = domainsRes.results.map((d) => {
    const badge = d.status === "active"
      ? `<span class="badge ok">Active</span>`
      : d.status === "error"
        ? `<span class="badge danger">Error</span>`
        : `<span class="badge warn">Pending DNS</span>`;
    const dnsHelp = d.status !== "active"
      ? `<div class="stack-sm" style="margin-top:.55rem;padding:.7rem .85rem;border-radius:10px;background:var(--surface-2);border:1px solid var(--line);font-size:.82rem">
          <div><strong>1. CNAME record:</strong> <code>${escape(d.hostname)}</code> → <code>${escape(fallbackTarget)}</code></div>
          ${d.verification_txt_name && d.verification_txt_value ? `<div><strong>2. TXT record:</strong> <code>${escape(d.verification_txt_name)}</code> = <code>${escape(d.verification_txt_value)}</code></div>` : ""}
          ${d.last_error ? `<div style="color:var(--danger)">Last check: ${escape(d.last_error)}</div>` : ""}
        </div>`
      : `<p class="list-item-sub">Routes <code>https://${escape(d.hostname)}/s/&lt;key&gt;/</code> to page <code>${escape(d.tendril_id)}</code>${d.ssl_status ? ` · TLS ${escape(d.ssl_status)}` : ""}.</p>`;
    return `<li class="list-item" style="align-items:flex-start">
      <div class="list-item-main">
        <div class="list-item-title">${icon("link")} <span>${escape(d.hostname)}</span> ${badge}</div>
        ${d.status === "active" ? dnsHelp : `<p class="list-item-sub">Bound to page <code>${escape(d.tendril_id)}</code></p>${dnsHelp}`}
      </div>
      <div class="actions tight">
        ${d.status !== "active" ? `<form class="inline-form" method="post" action="/dashboard/domains/verify"><input type="hidden" name="hostname" value="${escape(d.hostname)}"><button class="secondary sm" type="submit">Verify DNS</button></form>` : ""}
        <form class="inline-form" method="post" action="/dashboard/domains/delete"><input type="hidden" name="hostname" value="${escape(d.hostname)}"><button class="danger sm" type="submit">Remove</button></form>
      </div>
    </li>`;
  }).join("");

  const addSection = allowed
    ? `<section class="card stack-sm">
        <div class="card-head"><div><span class="eyebrow">Connect a hostname</span><h2>Add a custom page domain</h2><p>Give any page its own branded domain (for example, <code>tracker.yourteam.com</code>). Your existing <code>*.${escape(env.PAGE_BASE_DOMAIN || "tendriller.dev")}</code> link keeps working too.</p></div></div>
        ${availablePages.length > 0
          ? `<form method="post" action="/dashboard/domains" class="stack-sm">
              <div class="field-row">
                <div class="field"><label class="field-label" for="domain-page">Page</label><select id="domain-page" name="tendril_id" required>${availablePages.map((p) => `<option value="${escape(p.id)}">${escape(p.id)}</option>`).join("")}</select></div>
                <div class="field"><label class="field-label" for="domain-host">Custom hostname</label><input id="domain-host" name="hostname" type="text" required maxlength="253" placeholder="tracker.yourteam.com" autocomplete="off"></div>
              </div>
              <p class="fine">After adding, point a <code>CNAME</code> record to <code>${escape(fallbackTarget)}</code> and add the ownership <code>TXT</code> record.</p>
              <div class="actions tight"><button type="submit" class="sm">${icon("plus")} Add custom domain</button></div>
            </form>`
          : `<p class="empty">Create a page first (or remove an existing domain binding) to connect a custom hostname.</p>`}
      </section>`
    : `<section class="card stack-sm">
        <div class="card-head"><div><span class="eyebrow">Team feature</span><h2>Custom page domains</h2><p>Serve your Tendriller pages on your own domain (e.g. <code>tracker.yourteam.com</code>) with automatic TLS on the <strong>Team</strong> plan or when self-hosting.</p></div><span class="badge">Team &amp; Self-Hosted</span></div>
        <div class="actions tight"><a class="button sm" href="/dashboard/billing">${icon("sparkles")} Upgrade to Team — $39/mo</a><a class="button secondary sm" href="/pricing">Compare plans</a><a class="button ghost sm" href="/self-host">Self-host free</a></div>
      </section>`;

  const body = `<a class="back-link" href="/dashboard">← Back to dashboard</a>
    <section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("link")} Branded origins</span><h1>Custom domains</h1><p class="lead">Serve individual pages on your own domain while preserving per-page origin isolation and signed OAuth access.</p></div></div></section>
    ${alerts.join("")}
    ${addSection}
    <section class="card stack-sm">
      <div class="card-head"><div><span class="eyebrow">Configured</span><h2>Your custom domains</h2></div><span class="badge">${domainsRes.results.length}</span></div>
      ${domainRows ? `<ul class="list">${domainRows}</ul>` : `<p class="empty">No custom domains connected yet.</p>`}
    </section>`;

  return servicePage("Custom domains", body, "", 200, {
    medium: true,
    brand: brandMark(brandBase, "/?home=1"),
  });
}

/** Route `/dashboard/domains*` for signed-in accounts. */
export async function routeCustomDomains(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env, true);
  if (!session || !env.ACCOUNTS) {
    return redirect(`/auth?return_to=${encodeURIComponent(url.pathname)}`, 302);
  }
  if (session.suspendedAt) {
    return errorResponse(403, "suspended", "Custom domains are unavailable while the account is suspended.");
  }

  const wantsJson = (req.headers.get("Accept") ?? "").includes("application/json") ||
    (req.headers.get("Content-Type") ?? "").includes("application/json");

  try {
    if (url.pathname === "/dashboard/domains" && req.method === "GET") {
      if (wantsJson) {
        const rows = await env.ACCOUNTS.prepare(
          "SELECT hostname, tendril_id, status, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at FROM custom_domains WHERE account_id = ? ORDER BY created_at DESC",
        ).bind(session.accountId).all();
        return json({ domains: rows.results, fallback_origin: fallbackOriginHost(env) });
      }
      return await renderDomainsPage(env, url, session.accountId);
    }

    if (url.pathname === "/dashboard/domains" && req.method === "POST") {
      sameOrigin(req, env);
      await requireWritesOpen(env);
      const ent = await getAccountEntitlements(env, session.accountId);
      if (!ent.unlimitedHost && !ent.quotas.customDomain) {
        throw new HttpError(402, "plan_required", "Custom page domains require the Team plan or a self-hosted deployment.");
      }
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { params } = parseFormOrJson(req, raw);
      const tendrilId = String(params.tendril_id ?? "").trim();
      const rawHost = String(params.hostname ?? "");
      if (!TENDRIL_ID_RE.test(tendrilId)) {
        throw new HttpError(400, "invalid_page", "Select a valid page.");
      }
      const hostname = normalizeCustomHostname(rawHost, env);
      if (!hostname) {
        throw new HttpError(400, "invalid_hostname", "Enter a valid domain name (for example, app.yourteam.com).");
      }

      const page = await env.ACCOUNTS.prepare(
        "SELECT id FROM tendrils WHERE id = ? AND owner_account = ? AND state = 'active'",
      ).bind(tendrilId, session.accountId).first<{ id: string }>();
      if (!page) throw new HttpError(404, "not_found", "Page not found in your account.");

      const existingHost = await env.ACCOUNTS.prepare("SELECT hostname FROM custom_domains WHERE hostname = ?")
        .bind(hostname).first();
      if (existingHost) throw new HttpError(409, "hostname_in_use", "That domain is already connected.");

      const existingPage = await env.ACCOUNTS.prepare("SELECT hostname FROM custom_domains WHERE tendril_id = ?")
        .bind(tendrilId).first<{ hostname: string }>();
      if (existingPage) {
        throw new HttpError(409, "page_already_bound", `That page is already bound to ${existingPage.hostname}. Remove it first.`);
      }

      const now = Date.now();
      let status: "pending" | "active" | "error" = "pending";
      let cfHostnameId: string | null = null;
      let txtName: string | null = `_tendriller-verify.${hostname}`;
      let txtValue: string | null = `tendriller-verify=${randomHex(16)}`;
      let sslStatus: string | null = null;
      let lastError: string | null = null;

      if (cfSaasConfigured(env)) {
        const created = await createCfSaasHostname(env, hostname);
        cfHostnameId = created.cfHostnameId;
        status = created.status;
        sslStatus = created.sslStatus;
        txtName = created.txtName ?? txtName;
        txtValue = created.txtValue ?? txtValue;
        lastError = created.lastError;
      }

      await env.ACCOUNTS.prepare(`INSERT INTO custom_domains
        (hostname, account_id, tendril_id, status, cf_hostname_id, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          hostname, session.accountId, tendrilId, status, cfHostnameId,
          txtName, txtValue, sslStatus, lastError, now, status === "active" ? now : null, now,
        ).run();

      if (wantsJson) {
        return json({
          hostname,
          tendril_id: tendrilId,
          status,
          cname_target: fallbackOriginHost(env),
          verification_txt_name: txtName,
          verification_txt_value: txtValue,
          ssl_status: sslStatus,
        }, 201);
      }
      return redirect(`/dashboard/domains?status=${status === "active" ? "verified" : "added"}`, 303);
    }

    if (url.pathname === "/dashboard/domains/verify" && req.method === "POST") {
      sameOrigin(req, env);
      await requireWritesOpen(env);
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { params } = parseFormOrJson(req, raw);
      const hostname = normalizeCustomHostname(String(params.hostname ?? ""), env);
      if (!hostname) throw new HttpError(400, "invalid_hostname", "Invalid hostname.");

      const row = await env.ACCOUNTS.prepare(
        "SELECT hostname, account_id, tendril_id, status, cf_hostname_id, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at, updated_at FROM custom_domains WHERE hostname = ? AND account_id = ?",
      ).bind(hostname, session.accountId).first<CustomDomainRow>();
      if (!row) throw new HttpError(404, "not_found", "Custom domain not found.");

      const now = Date.now();
      let status: "pending" | "active" | "error" = row.status;
      let sslStatus = row.ssl_status;
      let txtName = row.verification_txt_name;
      let txtValue = row.verification_txt_value;
      let lastError: string | null = null;

      if (row.cf_hostname_id && cfSaasConfigured(env)) {
        const refreshed = await refreshCfSaasHostname(env, row.cf_hostname_id);
        status = refreshed.status;
        sslStatus = refreshed.sslStatus;
        txtName = refreshed.txtName ?? txtName;
        txtValue = refreshed.txtValue ?? txtValue;
        lastError = refreshed.lastError;
      } else if (txtName && txtValue) {
        const ok = await verifyDnsTxtRecord(env, txtName, txtValue);
        status = ok ? "active" : "pending";
        lastError = ok ? null : "Matching TXT record not found yet.";
      }

      await env.ACCOUNTS.prepare(`UPDATE custom_domains
        SET status = ?, ssl_status = ?, verification_txt_name = ?, verification_txt_value = ?,
            last_error = ?, verified_at = COALESCE(verified_at, ?), updated_at = ?
        WHERE hostname = ? AND account_id = ?`)
        .bind(status, sslStatus, txtName, txtValue, lastError, status === "active" ? now : null, now, hostname, session.accountId)
        .run();

      if (wantsJson) {
        return json({ hostname, status, ssl_status: sslStatus, last_error: lastError });
      }
      return redirect(`/dashboard/domains?status=${status === "active" ? "verified" : "pending"}`, 303);
    }

    if (url.pathname === "/dashboard/domains/delete" && req.method === "POST") {
      sameOrigin(req, env);
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { params } = parseFormOrJson(req, raw);
      const hostname = String(params.hostname ?? "").trim().toLowerCase();
      const row = await env.ACCOUNTS.prepare(
        "SELECT cf_hostname_id FROM custom_domains WHERE hostname = ? AND account_id = ?",
      ).bind(hostname, session.accountId).first<{ cf_hostname_id: string | null }>();
      if (!row) throw new HttpError(404, "not_found", "Custom domain not found.");
      if (row.cf_hostname_id) await deleteCfSaasHostname(env, row.cf_hostname_id);
      await env.ACCOUNTS.prepare("DELETE FROM custom_domains WHERE hostname = ? AND account_id = ?")
        .bind(hostname, session.accountId).run();
      if (wantsJson) return json({ ok: true, hostname });
      return redirect("/dashboard/domains?status=removed", 303);
    }

    return errorResponse(404, "not_found");
  } catch (err) {
    if (!wantsJson && err instanceof HttpError && err.status >= 400 && err.status < 500) {
      return redirect(`/dashboard/domains?error=${encodeURIComponent(err.message)}`, 303);
    }
    return toErrorResponse(err);
  }
}
