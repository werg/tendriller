import { PAGE_LIMIT, RESIDENT_LIMIT } from "../limits";
import { accountLimits } from "../service-state";
import type { Env } from "../env";
import { errorResponse } from "../http";
import { PAGE_KEY_RE, sha256Hex, TENDRIL_ID_RE } from "../ids";
import { pageOriginForHost, pageOriginForLabel } from "../urls";
import { isActiveCustomDomainForPage } from "../custom-domains";
import { isActiveSubdomainForPage } from "../subdomains";
import { serviceSession } from "./auth";
import { authFormAction, pageSessionCookieHeader, renderAuthControls } from "./local-auth";
import { renderShell, servicePage } from "./ui";
import { copyAttrs, renderCopyText, SITE_COPY } from "../site-copy";

const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function stub(env: Env, id: string): DurableObjectStub { return env.TENDRIL.get(env.TENDRIL.idFromName(id)); }
function claimRequest(id: string, key: string, path: string, init: RequestInit = {}, bare = false): Request {
  const headers = new Headers(init.headers);
  if (bare) headers.set("x-tendril-bare", "1");
  else headers.set("x-tendril-key", key);
  return new Request(`https://tendril.internal/claim/${path}`, { ...init, headers });
}
function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
function html(body: string, status = 200, script = "", env?: Env, customOrigin?: string | null): Response {
  const response = servicePage("Open page", body, script, status, env ? { formAction: authFormAction(env, customOrigin) } : undefined);
  return response;
}

export function renderQuotaLimitBody(explanation: string, editable = false): string {
  const q = SITE_COPY.auth.pageQuota;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  return `<section class="card stack-sm"><span class="eyebrow"${c("auth.pageQuota.eyebrow", q.eyebrow)}>${renderCopyText(q.eyebrow)}</span><h1${c("auth.pageQuota.title", q.title)}>${renderCopyText(q.title)}</h1><p>${explanation} <span${c("auth.pageQuota.localSafe", q.localSafe)}>${renderCopyText(q.localSafe)}</span></p><p class="muted"${c("auth.pageQuota.hint", q.hint)}>${renderCopyText(q.hint)}</p><div class="actions"><a class="button" href="/dashboard">Manage pages</a><a class="button secondary" href="/dashboard/billing">Upgrade plan</a><a class="button ghost" href="/self-host">Self-host on Cloudflare</a></div></section>`;
}

export function renderQuotaLimitHtml(explanation: string, editable = false): string {
  return renderShell({ title: "Open page", body: renderQuotaLimitBody(explanation, editable) });
}

export function renderMissingPageBody(id: string, editable = false): string {
  const m = SITE_COPY.auth.pageMissing;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  return `<section class="card stack-sm">`
    + `<span class="eyebrow"${c("auth.pageMissing.eyebrow", m.eyebrow)}>${renderCopyText(m.eyebrow)}</span>`
    + `<h1${c("auth.pageMissing.title", m.title)}>${renderCopyText(m.title)}</h1>`
    + `<p class="lead"${c("auth.pageMissing.lead", m.lead)}>${renderCopyText(m.lead, { id })}</p>`
    + `<p${c("auth.pageMissing.localSafe", m.localSafe)}>${renderCopyText(m.localSafe)}</p>`
    + `<div class="actions">`
    + `<a class="button" href="/dashboard">Open dashboard</a>`
    + `<a class="button secondary" href="/docs/V2_MIGRATION.md">Migration &amp; export guide</a>`
    + `<a class="button ghost" href="/changelog.md">Platform changelog</a>`
    + `</div></section>`;
}

export function renderMissingPageHtml(id: string, editable = false): string {
  return renderShell({ title: "Open page", body: renderMissingPageBody(id, editable) });
}

export function renderPageAuthPromptBody(options: {
  role: "owner" | "guest";
  expected: string | null;
  controlsHtml: string;
  editable?: boolean;
}): string {
  const editable = Boolean(options.editable);
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const isGuest = options.role === "guest";
  const copy = isGuest ? SITE_COPY.auth.pageGuest : SITE_COPY.auth.pageOwner;
  const prefix = isGuest ? "auth.pageGuest" : "auth.pageOwner";
  const expectedLine = options.expected
    ? `${isGuest ? "Invited email" : "Intended owner"}: ${escape(options.expected)}`
    : `<span${c("auth.pageGuest.privateNote", SITE_COPY.auth.pageGuest.privateNote)}>${renderCopyText(SITE_COPY.auth.pageGuest.privateNote)}</span>`;
  return `<section class="card"><span class="eyebrow"${c(`${prefix}.eyebrow`, copy.eyebrow)}>${renderCopyText(copy.eyebrow)}</span><h1${c(`${prefix}.title`, copy.title)}>${renderCopyText(copy.title)}</h1><p class="lead"${c(`${prefix}.lead`, copy.lead)}>${renderCopyText(copy.lead)}</p><p class="muted">${expectedLine}</p>${options.controlsHtml}</section><p class="muted" style="margin-top:1rem;font-size:.86rem"><span${c("auth.pageOwner.privacyNote", SITE_COPY.auth.pageOwner.privacyNote)}>${renderCopyText(SITE_COPY.auth.pageOwner.privacyNote)}</span> By continuing, you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>`;
}

export function renderPageAuthPromptHtml(options: {
  role: "owner" | "guest";
  expected: string | null;
  returnTo?: string;
  editable?: boolean;
}): string {
  const back = encodeURIComponent(options.returnTo ?? "/dashboard");
  const controlsHtml = `<div class="actions"><a class="button lg" href="/auth/github?return_to=${back}">Continue with GitHub</a><a class="button secondary lg" href="/auth/google?return_to=${back}">Continue with Google</a></div>`;
  return renderShell({
    title: "Open page",
    body: renderPageAuthPromptBody({
      role: options.role,
      expected: options.expected,
      controlsHtml,
      editable: options.editable,
    }),
  });
}

/** A browser claim must explain a capacity stop, rather than displaying an API error as a sign-in failure. */
async function claimFailure(req: Request, env: Env, response: Response, accountId?: string | null): Promise<Response> {
  if (!req.headers.get('Accept')?.includes('text/html') || ![413, 429].includes(response.status)) return response;
  const body = await response.clone().json().catch(() => null) as { error?: { code?: string; limit?: number; message?: string; quota?: string; plan?: string } } | null;
  if (body?.error?.code !== 'quota' && body?.error?.code !== 'quota_exceeded') return response;
  const limit = body.error.limit;
  const limits = await accountLimits(env, accountId);
  const residentCap = limits.residents ?? RESIDENT_LIMIT;
  const pageCap = limits.pages ?? PAGE_LIMIT;
  const isResident = body.error.quota === 'residents' || (response.status === 429 && (body.error.message?.toLowerCase().includes('resident') || limit === residentCap));
  const explanation = isResident
    ? `Your account can keep up to ${limit ?? residentCap} resident pages on its current plan.`
    : response.status === 429 ? `Your account can keep up to ${limit ?? pageCap} active pages on its current plan.`
    : response.status === 413 ? 'Your account has reached its published asset storage allowance.' : 'Your account has reached its page allowance.';
  return html(renderQuotaLimitBody(explanation), response.status);
}

function resolvedPageBase(env: Env, id: string, key: string, verifiedHost?: string | null, bare = false): string {
  const origin = verifiedHost ? pageOriginForHost(env, verifiedHost) : pageOriginForLabel(env, id);
  return bare ? `${origin}/` : `${origin}/s/${key}/`;
}

async function resolveVerifiedPageHost(env: Env, rawHost: string | null | undefined, id: string): Promise<string | null> {
  if (!rawHost) return null;
  const sub = await isActiveSubdomainForPage(env, rawHost, id);
  if (sub) return sub;
  return await isActiveCustomDomainForPage(env, rawHost, id);
}

async function issuePageCode(env: Env, id: string, key: string, accountId: string, role: "owner" | "guest" = "owner", customHost?: string | null, bare = false): Promise<Response> {
  const code = randomToken();
  const keyHash = bare ? "bare" : await sha256Hex(key);
  await env.ACCOUNTS!.prepare("INSERT INTO page_codes (hash, tendril_id, account_id, role, key_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(code), id, accountId, role, keyHash, Date.now() + 60_000).run();
  const baseUrl = resolvedPageBase(env, id, key, customHost, bare);
  return redirect(`${baseUrl}_tendril/auth/session?code=${encodeURIComponent(code)}`);
}

async function verifiedIdentities(env: Env, accountId: string): Promise<{ provider: string; login: string; emails: string[] }[]> {
  const rows = await env.ACCOUNTS.prepare(`SELECT i.provider, i.login, e.email FROM identities i
    LEFT JOIN identity_emails e ON e.provider = i.provider AND e.subject = i.subject WHERE i.account_id = ?`)
    .bind(accountId).all<{ provider: string; login: string; email: string | null }>();
  const grouped = new Map<string, { provider: string; login: string; emails: string[] }>();
  for (const row of rows.results) {
    const item = grouped.get(row.provider) ?? { provider: row.provider, login: row.login, emails: [] };
    if (row.email) item.emails.push(row.email);
    grouped.set(row.provider, item);
  }
  return [...grouped.values()];
}

function missingPageTransition(req: Request, id: string): Response | null {
  if (!req.headers.get("Accept")?.includes("text/html")) return null;
  return html(renderMissingPageBody(id), 404);
}

export async function routePageAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ACCOUNTS) return errorResponse(503, "unavailable", "Accounts database is not configured");
  const id = url.searchParams.get("tendril") ?? "";
  const bare = url.searchParams.get("bare") === "1";
  const key = url.searchParams.get("key") ?? "";
  if (!TENDRIL_ID_RE.test(id) || (!bare && !PAGE_KEY_RE.test(key))) return errorResponse(400, "bad_request", "Invalid page link");

  const verifiedHost = await resolveVerifiedPageHost(env, url.searchParams.get("host"), id);
  const customOrigin = verifiedHost ? pageOriginForHost(env, verifiedHost) : null;

  if (bare) {
    const infoRes = await stub(env, id).fetch(claimRequest(id, "", "bare-info", {}, true));
    if (!infoRes.ok) {
      if (infoRes.status === 404) {
        const transition = missingPageTransition(req, id);
        if (transition) {
          await infoRes.body?.cancel();
          return transition;
        }
      }
      return infoRes;
    }
    const info = await infoRes.json() as { claimed: boolean; open_readers?: boolean };
    if (!info.claimed) {
      return html("<section class=\"card\"><h1>Page not yet claimed</h1><p class=\"lead\">Open this page using its full setup link to claim it first.</p></section>", 403);
    }
    const returnTo = `/auth/page?tendril=${id}&bare=1${verifiedHost ? `&host=${encodeURIComponent(verifiedHost)}` : ""}`;
    const session = await serviceSession(req, env);
    if (!session) {
      if (req.method !== "GET") return errorResponse(401, "unauthorized", "Sign in first");
      return html(
        renderPageAuthPromptBody({
          role: "owner",
          expected: null,
          controlsHtml: renderAuthControls(env, returnTo),
        }),
        200,
        "",
        env,
        customOrigin,
      );
    }
    const deleting = await env.ACCOUNTS.prepare("SELECT deleting_at FROM accounts WHERE id = ?").bind(session.accountId)
      .first<{ deleting_at: number | null }>();
    if (deleting?.deleting_at) return errorResponse(403, "account_deleting", "Account deletion is in progress");
    const owner = await env.ACCOUNTS.prepare("SELECT owner_account FROM tendrils WHERE id = ?").bind(id).first<{ owner_account: string | null }>();
    if (!owner) return missingPageTransition(req, id) ?? errorResponse(404, "not_found", "No such tendril");
    if (owner.owner_account === session.accountId) {
      return issuePageCode(env, id, "", session.accountId, "owner", verifiedHost, true);
    }
    return html("<section class=\"card\"><h1>This page belongs to another account</h1></section>", 403);
  }

  const infoRes = await stub(env, id).fetch(claimRequest(id, key, "info"));
  if (!infoRes.ok) {
    if (infoRes.status === 404) {
      const transition = missingPageTransition(req, id);
      if (transition) {
        await infoRes.body?.cancel();
        return transition;
      }
    }
    return infoRes;
  }
  const info = await infoRes.json() as { claimed: boolean; expected: string | null; role: string };
  if (info.role !== "owner" && info.role !== "guest") return errorResponse(403, "forbidden", "This link cannot be opened");
  const session = await serviceSession(req, env);
  const customHost = verifiedHost;
  const returnTo = `/auth/page?tendril=${id}&key=${key}${customHost ? `&host=${encodeURIComponent(customHost)}` : ""}`;
  if (!session) {
    if (req.method !== "GET") return errorResponse(401, "unauthorized", "Sign in first");
    return html(
      renderPageAuthPromptBody({
        role: info.role,
        expected: info.expected,
        controlsHtml: renderAuthControls(env, returnTo, { expectedEmail: info.expected }),
      }),
      200,
      "",
      env,
      customOrigin,
    );
  }
  const deleting = await env.ACCOUNTS.prepare("SELECT deleting_at FROM accounts WHERE id = ?").bind(session.accountId)
    .first<{ deleting_at: number | null }>();
  if (deleting?.deleting_at) return errorResponse(403, "account_deleting", "Account deletion is in progress");
  const owner = await env.ACCOUNTS.prepare("SELECT owner_account FROM tendrils WHERE id = ?").bind(id).first<{ owner_account: string | null }>();
  if (!owner) return missingPageTransition(req, id) ?? errorResponse(404, "not_found", "No such tendril");
  if (info.role === "owner" && owner.owner_account === session.accountId) return issuePageCode(env, id, key, session.accountId, "owner", customHost);
  if (info.role === "owner" && owner.owner_account) {
    const orgClaim = await stub(env, id).fetch(claimRequest(id, key, "org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: session.accountId }),
    }));
    if (orgClaim.ok) {
      await orgClaim.body?.cancel();
      return issuePageCode(env, id, key, session.accountId, "guest", customHost);
    }
    await orgClaim.body?.cancel();
    return html("<section class=\"card\"><h1>This page belongs to another account</h1></section>", 403);
  }
  if (info.role === "guest" && !owner.owner_account) return html("<section class=\"card\"><h1>Waiting for the owner to claim this page</h1></section>", 403);
  if (req.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET");
  if (info.role === "owner") {
    const identities = await verifiedIdentities(env, session.accountId);
    const claim = await stub(env, id).fetch(claimRequest(id, key, "owner", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: session.accountId, identities }),
    }));
    if (!claim.ok) return claimFailure(req, env, claim, session.accountId);
    return issuePageCode(env, id, key, session.accountId, "owner", customHost);
  }
  const identities = await verifiedIdentities(env, session.accountId);
  const claim = await stub(env, id).fetch(claimRequest(id, key, "guest", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: session.accountId, identities }),
  }));
  if (!claim.ok) {
    if (claim.status === 403) {
      const err = await claim.clone().json().catch(() => null) as { error?: { code?: string } } | null;
      if (err?.error?.code === "wrong_guest_email") {
        return html(`<section class="card"><span class="eyebrow">Guest invitation</span><h1>This invitation is for another email address</h1><p class="lead">${info.expected ? `This link is restricted to <code>${escape(info.expected)}</code>.` : "Your signed-in account does not match the invited email address."} Sign in with a matching account to join.</p>${renderAuthControls(env, returnTo, { expectedEmail: info.expected, compact: true })}</section>`, 403, "", env, customOrigin);
      }
      if (err?.error?.code === "declined") {
        return html(`<section class="card"><span class="eyebrow">Guest invitation</span><h1>Invitation unavailable</h1><p class="lead">This invitation was revoked.</p></section>`, 403);
      }
    }
    return claim;
  }
  return issuePageCode(env, id, key, session.accountId, "guest", customHost);
}

export async function redeemPageCode(env: Env, id: string, key: string, code: string, customHost?: string | null, bare = false): Promise<Response> {
  if (!env.ACCOUNTS) return errorResponse(503, "unavailable", "Accounts database is not configured");
  const keyHash = bare ? "bare" : await sha256Hex(key);
  const row = await env.ACCOUNTS.prepare(`DELETE FROM page_codes WHERE hash = ? AND tendril_id = ? AND key_hash = ? AND expires_at > ?
    RETURNING account_id, role`).bind(await sha256Hex(code), id, keyHash, Date.now())
    .first<{ account_id: string; role: string }>();
  if (!row) return errorResponse(403, "invalid_code", "Page sign-in expired or already used");
  const token = randomToken();
  const res = await stub(env, id).fetch(claimRequest(id, key, "session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: row.account_id, role: row.role, hash: await sha256Hex(token) }),
  }, bare));
  if (!res.ok) return res;
  const target = resolvedPageBase(env, id, key, customHost, bare);
  return redirect(target, pageSessionCookieHeader(token, env));
}
