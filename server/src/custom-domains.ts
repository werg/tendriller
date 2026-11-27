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
import { icon, renderShell, servicePage } from "./accounts/ui";
import { copyAttrs, renderCopyText, SITE_COPY } from "./site-copy";
import { cachedAccountEntitlements, getAccountEntitlements } from "./billing/entitlements";
import { TtlCache } from "./isolate-cache";

/**
 * Active custom-domain routing rows. Revocation window: another isolate keeps
 * routing a removed or deactivated hostname for at most 20 seconds, and a newly
 * activated hostname may stay unresolved there for at most 10 seconds. The page
 * Durable Object still authenticates every request it receives.
 */
const customDomainRows = new TtlCache<CustomDomainRow | null>(20_000, 10_000, 1024);

export function invalidateCustomDomainCache(): void { customDomainRows.clear(); }
import { requireWritesOpen } from "./service-state";
import { barePageUrl, publicBase, type PageRoute } from "./urls";
import {
  checkSubdomainAvailability,
  listAccountSubdomains,
  setPageSubdomain,
  subdomainPlanAllowed,
  type PageSubdomainRow,
} from "./subdomains";

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
  const row = await customDomainRows.get(host, async () => await env.ACCOUNTS.prepare(
    "SELECT hostname, account_id, tendril_id, status, cf_hostname_id, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at, updated_at FROM custom_domains WHERE hostname = ? AND status = 'active'",
  ).bind(host).first<CustomDomainRow>(), env.ACCOUNTS).catch(() => null);
  if (!row) return null;

  const ent = await cachedAccountEntitlements(env, row.account_id).catch(() => null);
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
  const ent = await cachedAccountEntitlements(env, row.account_id).catch(() => null);
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

export interface CustomDomainsView {
  allowed: boolean;
  fallbackTarget: string;
  pageBaseDomain: string;
  domains: CustomDomainRow[];
  availablePages: Array<{ id: string }>;
  subdomains?: PageSubdomainRow[];
  subdomainAllowed?: boolean;
  subdomainLimit?: number | null;
  allPages?: Array<{ id: string; subdomain?: string | null }>;
  flash?: string | null;
  errMsg?: string | null;
  editable?: boolean;
}

export function renderCustomDomainsBody(view: CustomDomainsView): string {
  const editable = Boolean(view.editable);
  const dCopy = SITE_COPY.domains;
  const vars = { pageDomain: view.pageBaseDomain, fallbackTarget: view.fallbackTarget };
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const txt = (t: string) => renderCopyText(t, vars);

  const alerts: string[] = [];
  if (view.flash === "added") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Custom domain added. Point your DNS records below, then click <strong>Verify DNS</strong>.</span></p>`);
  if (view.flash === "verified") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Custom domain verified and active!</span></p>`);
  if (view.flash === "pending") alerts.push(`<p class="notice warn" role="status">${icon("clock")}<span>DNS verification is still pending. Check your CNAME and TXT records and try again in a minute.</span></p>`);
  if (view.flash === "removed") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Custom domain removed.</span></p>`);
  if (view.flash === "subdomain_saved") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Named subdomain saved! Your page is now live at its new address (the original generated link continues working as a fallback).</span></p>`);
  if (view.flash === "subdomain_reassigned") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Named subdomain moved atomically to the selected page! The previous page stays accessible at its generated address.</span></p>`);
  if (view.flash === "subdomain_swapped") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Named subdomains swapped atomically between both pages!</span></p>`);
  if (view.flash === "subdomain_removed") alerts.push(`<p class="notice" role="status">${icon("check")}<span>Named subdomain removed. Your page remains accessible at its generated address.</span></p>`);
  if (view.errMsg) alerts.push(`<p class="notice danger" role="alert">${icon("x")}<span>${escape(view.errMsg)}</span></p>`);

  const subdomains = view.subdomains ?? [];
  const subAllowed = Boolean(view.subdomainAllowed);
  const subLimit = view.subdomainLimit ?? null;
  const subPages: Array<{ id: string; subdomain?: string | null }> = view.allPages ?? view.availablePages;
  const subQuotaLabel = subLimit === null ? `${subdomains.length} used · Unlimited` : `${subdomains.length} / ${subLimit}`;
  const subRows = subdomains.map((s) => {
    const fullHost = `${s.subdomain}.${view.pageBaseDomain}`;
    const href = `https://${fullHost}/`;
    const badge = subAllowed
      ? `<span class="badge ok">Active</span>`
      : `<span class="badge warn">Paused · upgrade to resume</span>`;
    const otherPages = subPages.filter((p) => p.id !== s.tendril_id);
    const reassignForm = subAllowed && otherPages.length > 0
      ? `<form class="inline-form" method="post" action="/dashboard/domains/subdomains" style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-top:.45rem">
          <input type="hidden" name="subdomain" value="${escape(s.subdomain)}">
          <input type="hidden" name="reassign" value="1">
          <input type="hidden" name="swap" value="1">
          <label class="sr-only" for="move-${escape(s.subdomain)}">Move ${escape(s.subdomain)} to another page</label>
          <select id="move-${escape(s.subdomain)}" name="tendril_id" style="width:auto;min-height:2rem;padding:.25rem .55rem;font-size:.82rem">${otherPages.map((p) => `<option value="${escape(p.id)}">${escape(p.id)}${p.subdomain ? ` (swap with ${escape(p.subdomain)})` : ""}</option>`).join("")}</select>
          <button class="secondary sm" type="submit">Move / swap page</button>
        </form>`
      : "";
    return `<li class="list-item" style="align-items:flex-start">
      <div class="list-item-main">
        <div class="list-item-title">${icon("link")} <a href="${escape(href)}" target="_blank" rel="noopener"><code>${escape(fullHost)}</code></a> ${badge}</div>
        <p class="list-item-sub">Bound to page <code>${escape(s.tendril_id)}</code> · Fallback <code>${escape(s.tendril_id)}.${escape(view.pageBaseDomain)}</code> still works.</p>
        ${reassignForm}
      </div>
      <div class="actions tight">
        <form class="inline-form" method="post" action="/dashboard/domains/subdomains/delete"><input type="hidden" name="tendril_id" value="${escape(s.tendril_id)}"><button class="danger sm" type="submit">Remove</button></form>
      </div>
    </li>`;
  }).join("");

  const subdomainSection = subAllowed
    ? `<section class="card stack-sm" id="subdomains">
        <div class="card-head"><div><span class="eyebrow">Named subdomains</span><h2>Replace random subdomains with unique names</h2><p>Give any existing page a memorable address like <code>my-app.${escape(view.pageBaseDomain)}</code>. Public pages and signed-in owners can open the bare domain directly; the original generated link keeps working as a fallback.</p></div><span class="badge ok">${escape(subQuotaLabel)}</span></div>
        ${subPages.length > 0
          ? `<form method="post" action="/dashboard/domains/subdomains" class="stack-sm">
              <div class="field-row">
                <div class="field"><label class="field-label" for="sub-page">Page</label><select id="sub-page" name="tendril_id" required>${subPages.map((p) => `<option value="${escape(p.id)}">${escape(p.id)}${p.subdomain ? ` (${escape(p.subdomain)})` : ""}</option>`).join("")}</select></div>
                <div class="field"><label class="field-label" for="sub-name">Unique subdomain name</label><input id="sub-name" name="subdomain" type="text" required minlength="3" maxlength="45" pattern="[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])" placeholder="my-app" autocomplete="off"><span class="field-hint">Becomes <code>&lt;name&gt;.${escape(view.pageBaseDomain)}</code> (3–45 lowercase letters, numbers, or single hyphens).</span></div>
              </div>
              <div class="actions tight"><button type="submit" class="sm">${icon("plus")} Save named subdomain</button></div>
            </form>`
          : `<p class="empty">Create a page first to assign a named subdomain.</p>`}
        ${subRows ? `<ul class="list">${subRows}</ul>` : `<p class="empty">No named subdomains assigned yet.</p>`}
      </section>`
    : `<section class="card stack-sm" id="subdomains">
        <div class="card-head"><div><span class="eyebrow">Pro &amp; Team feature</span><h2>Named page subdomains</h2><p>Replace random page subdomains with memorable unique names like <code>my-app.${escape(view.pageBaseDomain)}</code> (25 on Pro, 100 on Team, unlimited when self-hosting).</p></div><span class="badge">Pro, Team &amp; Self-Hosted</span></div>
        <div class="actions tight"><a class="button sm" href="/dashboard/billing">${icon("sparkles")} Upgrade to Pro — $12/mo</a><a class="button secondary sm" href="/pricing">Compare plans</a><a class="button ghost sm" href="/self-host">Self-host free</a></div>
        ${subRows ? `<ul class="list" style="margin-top:.5rem">${subRows}</ul>` : ""}
      </section>`;

  const domainRows = view.domains.map((d) => {
    const badge = d.status === "active"
      ? `<span class="badge ok">Active</span>`
      : d.status === "error"
        ? `<span class="badge danger">Error</span>`
        : `<span class="badge warn">Pending DNS</span>`;
    const dnsHelp = d.status !== "active"
      ? `<div class="stack-sm" style="margin-top:.55rem;padding:.7rem .85rem;border-radius:10px;background:var(--surface-2);border:1px solid var(--line);font-size:.82rem">
          <div><strong>1. CNAME record:</strong> <code>${escape(d.hostname)}</code> → <code>${escape(view.fallbackTarget)}</code></div>
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

  const addSection = view.allowed
    ? `<section class="card stack-sm">
        <div class="card-head"><div><span class="eyebrow"${c("domains.add.eyebrow", dCopy.add.eyebrow)}>${txt(dCopy.add.eyebrow)}</span><h2${c("domains.add.title", dCopy.add.title)}>${txt(dCopy.add.title)}</h2><p${c("domains.add.lead", dCopy.add.lead)}>${txt(dCopy.add.lead)}</p></div></div>
        ${view.availablePages.length > 0
          ? `<form method="post" action="/dashboard/domains" class="stack-sm">
              <div class="field-row">
                <div class="field"><label class="field-label" for="domain-page">Page</label><select id="domain-page" name="tendril_id" required>${view.availablePages.map((p) => `<option value="${escape(p.id)}">${escape(p.id)}</option>`).join("")}</select></div>
                <div class="field"><label class="field-label" for="domain-host">Custom hostname</label><input id="domain-host" name="hostname" type="text" required maxlength="253" placeholder="tracker.yourteam.com" autocomplete="off"></div>
              </div>
              <p class="fine"${c("domains.add.dnsHint", dCopy.add.dnsHint)}>${txt(dCopy.add.dnsHint)}</p>
              <div class="actions tight"><button type="submit" class="sm">${icon("plus")} Add custom domain</button></div>
            </form>`
          : `<p class="empty"${c("domains.add.emptyPages", dCopy.add.emptyPages)}>${txt(dCopy.add.emptyPages)}</p>`}
      </section>`
    : `<section class="card stack-sm">
        <div class="card-head"><div><span class="eyebrow"${c("domains.upsell.eyebrow", dCopy.upsell.eyebrow)}>${txt(dCopy.upsell.eyebrow)}</span><h2${c("domains.upsell.title", dCopy.upsell.title)}>${txt(dCopy.upsell.title)}</h2><p${c("domains.upsell.lead", dCopy.upsell.lead)}>${txt(dCopy.upsell.lead)}</p></div><span class="badge">Team &amp; Self-Hosted</span></div>
        <div class="actions tight"><a class="button sm" href="/dashboard/billing">${icon("sparkles")} Upgrade to Team — $39/mo</a><a class="button secondary sm" href="/pricing">Compare plans</a><a class="button ghost sm" href="/self-host">Self-host free</a></div>
      </section>`;

  return `<a class="back-link" href="/dashboard">← Back to dashboard</a>
    <section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("link")} <span${c("domains.hero.eyebrow", dCopy.hero.eyebrow)}>${txt(dCopy.hero.eyebrow)}</span></span><h1${c("domains.hero.title", dCopy.hero.title)}>${txt(dCopy.hero.title)}</h1><p class="lead"${c("domains.hero.lead", dCopy.hero.lead)}>${txt(dCopy.hero.lead)}</p></div></div></section>
    ${alerts.join("")}
    ${subdomainSection}
    ${addSection}
    <section class="card stack-sm">
      <div class="card-head"><div><span class="eyebrow"${c("domains.list.eyebrow", dCopy.list.eyebrow)}>${txt(dCopy.list.eyebrow)}</span><h2${c("domains.list.title", dCopy.list.title)}>${txt(dCopy.list.title)}</h2></div><span class="badge">${view.domains.length}</span></div>
      ${domainRows ? `<ul class="list">${domainRows}</ul>` : `<p class="empty"${c("domains.list.empty", dCopy.list.empty)}>${txt(dCopy.list.empty)}</p>`}
    </section>`;
}

export function renderCustomDomainsHtml(view: CustomDomainsView): string {
  return renderShell({
    title: "Custom domains",
    body: renderCustomDomainsBody(view),
    width: "medium",
    brand: brandMark(brandBase, "/?home=1"),
  });
}

async function renderDomainsPage(env: Env, url: URL, accountId: string): Promise<Response> {
  const [ent, domainsRes, subdomains, pagesRes] = await Promise.all([
    getAccountEntitlements(env, accountId),
    env.ACCOUNTS.prepare(
      "SELECT hostname, account_id, tendril_id, status, cf_hostname_id, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at, updated_at FROM custom_domains WHERE account_id = ? ORDER BY created_at DESC",
    ).bind(accountId).all<CustomDomainRow>(),
    listAccountSubdomains(env, accountId),
    env.ACCOUNTS.prepare(
      "SELECT id, created_at FROM tendrils WHERE owner_account = ? AND state = 'active' ORDER BY created_at DESC",
    ).bind(accountId).all<{ id: string; created_at: number }>(),
  ]);

  const boundPageIds = new Set(domainsRes.results.map((d) => d.tendril_id));
  const subByPage = new Map(subdomains.map((s) => [s.tendril_id, s.subdomain]));
  const body = renderCustomDomainsBody({
    allowed: ent.unlimitedHost || ent.quotas.customDomain,
    fallbackTarget: fallbackOriginHost(env),
    pageBaseDomain: env.PAGE_BASE_DOMAIN || "tendriller.dev",
    domains: domainsRes.results,
    availablePages: pagesRes.results.filter((p) => !boundPageIds.has(p.id)),
    subdomains,
    subdomainAllowed: subdomainPlanAllowed(ent),
    subdomainLimit: ent.unlimitedHost ? null : ent.quotas.customSubdomains,
    allPages: pagesRes.results.map((p) => ({ id: p.id, subdomain: subByPage.get(p.id) ?? null })),
    flash: url.searchParams.get("status"),
    errMsg: url.searchParams.get("error"),
  });

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
        const [ent, rows, subdomains] = await Promise.all([
          getAccountEntitlements(env, session.accountId),
          env.ACCOUNTS.prepare(
            "SELECT hostname, tendril_id, status, verification_txt_name, verification_txt_value, ssl_status, last_error, created_at, verified_at FROM custom_domains WHERE account_id = ? ORDER BY created_at DESC",
          ).bind(session.accountId).all(),
          listAccountSubdomains(env, session.accountId),
        ]);
        return json({
          domains: rows.results,
          subdomains: subdomains.map((s) => ({
            subdomain: s.subdomain,
            tendril_id: s.tendril_id,
            bare_url: barePageUrl(env, s.tendril_id, s.subdomain),
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
          subdomain_quota: {
            allowed: subdomainPlanAllowed(ent),
            used: subdomains.length,
            limit: ent.unlimitedHost ? null : ent.quotas.customSubdomains,
          },
          fallback_origin: fallbackOriginHost(env),
        });
      }
      return await renderDomainsPage(env, url, session.accountId);
    }

    if (url.pathname === "/dashboard/domains/subdomains/check" && req.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const tendrilId = url.searchParams.get("tendril_id");
      return json(await checkSubdomainAvailability(env, name, tendrilId && TENDRIL_ID_RE.test(tendrilId) ? tendrilId : null));
    }

    if (url.pathname === "/dashboard/domains/subdomains" && req.method === "POST") {
      sameOrigin(req, env);
      await requireWritesOpen(env);
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { params } = parseFormOrJson(req, raw);
      const tendrilId = String(params.tendril_id ?? "").trim();
      const subRaw = params.subdomain === null ? null : String(params.subdomain ?? "").trim();
      const reassign = params.reassign === true || params.reassign === "1" || params.reassign === "true";
      const swap = params.swap === true || params.swap === "1" || params.swap === "true";
      const result = await setPageSubdomain(env, session.accountId, tendrilId, subRaw, `owner:${session.accountId}`, { reassign, swap });
      if (wantsJson) return json(result, 200);
      const flash = !result.subdomain
        ? "subdomain_removed"
        : result.swapped_subdomain
          ? "subdomain_swapped"
          : result.previous_tendril_id
            ? "subdomain_reassigned"
            : "subdomain_saved";
      return redirect(`/dashboard/domains?status=${flash}`, 303);
    }

    if (url.pathname === "/dashboard/domains/subdomains/delete" && req.method === "POST") {
      sameOrigin(req, env);
      await requireWritesOpen(env);
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { params } = parseFormOrJson(req, raw);
      const tendrilId = String(params.tendril_id ?? "").trim();
      const result = await setPageSubdomain(env, session.accountId, tendrilId, null, `owner:${session.accountId}`);
      if (wantsJson) return json(result, 200);
      return redirect("/dashboard/domains?status=subdomain_removed", 303);
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
      customDomainRows.delete(hostname);

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
      customDomainRows.delete(hostname);

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
      customDomainRows.delete(hostname);
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
