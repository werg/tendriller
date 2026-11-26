import { PAGE_LIMIT, RESIDENT_LIMIT } from "../limits";
import { accountLimits } from "../service-state";
import type { Env } from "../env";
import { errorResponse } from "../http";
import { PAGE_KEY_RE, sha256Hex, TENDRIL_ID_RE } from "../ids";
import { pageUrl } from "../urls";
import { serviceSession } from "./auth";
import { authFormAction, pageSessionCookieHeader, renderAuthControls } from "./local-auth";
import { servicePage } from "./ui";

const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function stub(env: Env, id: string): DurableObjectStub { return env.TENDRIL.get(env.TENDRIL.idFromName(id)); }
function claimRequest(id: string, key: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-tendril-key", key);
  return new Request(`https://tendril.internal/claim/${path}`, { ...init, headers });
}
function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
function html(body: string, status = 200, script = "", env?: Env): Response {
  const response = servicePage("Open page", body, script, status, env ? { formAction: authFormAction(env) } : undefined);
  return response;
}

/** A browser claim must explain a capacity stop, rather than displaying an API error as a sign-in failure. */
async function claimFailure(req: Request, env: Env, response: Response): Promise<Response> {
  if (!req.headers.get('Accept')?.includes('text/html') || ![413, 429].includes(response.status)) return response;
  const body = await response.clone().json().catch(() => null) as { error?: { code?: string; limit?: number; message?: string } } | null;
  if (body?.error?.code !== 'quota') return response;
  const limit = body.error.limit;
  const limits = await accountLimits(env);
  const residentCap = limits.residents ?? RESIDENT_LIMIT;
  const pageCap = limits.pages ?? PAGE_LIMIT;
  const isResident = response.status === 429 && (body.error.message?.toLowerCase().includes('resident') || limit === residentCap);
  const explanation = isResident
    ? `Your account can keep up to ${limit ?? residentCap} resident pages.`
    : response.status === 429 ? `Your account can keep up to ${limit ?? pageCap} pages.`
    : response.status === 413 ? 'Your account has reached its page storage allowance.' : 'Your account has reached its page allowance.';
  return html(`<h1>Your account is at its page limit</h1><p>${explanation}</p><p>Open your dashboard to remove a page you no longer need, then return to this page link. Your prepared app has not been claimed.</p><p><a class="button" href="/dashboard">Open dashboard</a></p>`, response.status);
}

async function issuePageCode(env: Env, id: string, key: string, accountId: string, role: "owner" | "guest" = "owner"): Promise<Response> {
  const code = randomToken();
  await env.ACCOUNTS!.prepare("INSERT INTO page_codes (hash, tendril_id, account_id, role, key_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(code), id, accountId, role, await sha256Hex(key), Date.now() + 60_000).run();
  return redirect(`${pageUrl(env, id, key)}_tendril/auth/session?code=${encodeURIComponent(code)}`);
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

export async function routePageAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ACCOUNTS) return errorResponse(503, "unavailable", "Accounts database is not configured");
  const id = url.searchParams.get("tendril") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!TENDRIL_ID_RE.test(id) || !PAGE_KEY_RE.test(key)) return errorResponse(400, "bad_request", "Invalid page link");
  const infoRes = await stub(env, id).fetch(claimRequest(id, key, "info"));
  if (!infoRes.ok) return infoRes;
  const info = await infoRes.json() as { claimed: boolean; expected: string | null; role: string };
  if (info.role !== "owner" && info.role !== "guest") return errorResponse(403, "forbidden", "This link cannot be opened");
  const session = await serviceSession(req, env);
  const returnTo = `/auth/page?tendril=${id}&key=${key}`;
  if (!session) {
    if (req.method !== "GET") return errorResponse(401, "unauthorized", "Sign in first");
    const expectedLine = info.expected
      ? `${info.role === "guest" ? "Invited email" : "Intended owner"}: ${escape(info.expected)}`
      : "Keep this invitation link private.";
    return html(`<section class="card"><span class="eyebrow">${info.role === "guest" ? "Guest invitation" : "A page made for you"}</span><h1>${info.role === "guest" ? "You're invited in." : "Your agent made a page for you."}</h1><p class="lead">Sign in to open it.</p><p class="muted">${expectedLine}</p>${renderAuthControls(env, returnTo, { expectedEmail: info.expected })}</section><p class="muted" style="margin-top:1rem;font-size:.86rem">Signing in lets Tendriller recognize you. Your agent never receives your sign-in credentials. By continuing, you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>`, 200, "", env);
  }
  const deleting = await env.ACCOUNTS.prepare("SELECT deleting_at FROM accounts WHERE id = ?").bind(session.accountId)
    .first<{ deleting_at: number | null }>();
  if (deleting?.deleting_at) return errorResponse(403, "account_deleting", "Account deletion is in progress");
  const owner = await env.ACCOUNTS.prepare("SELECT owner_account FROM tendrils WHERE id = ?").bind(id).first<{ owner_account: string | null }>();
  if (!owner) return errorResponse(404, "not_found", "No such tendril");
  if (info.role === "owner" && owner.owner_account === session.accountId) return issuePageCode(env, id, key, session.accountId);
  if (info.role === "owner" && owner.owner_account) {
    const orgClaim = await stub(env, id).fetch(claimRequest(id, key, "org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: session.accountId }),
    }));
    if (orgClaim.ok) {
      await orgClaim.body?.cancel();
      return issuePageCode(env, id, key, session.accountId, "guest");
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
    if (!claim.ok) return claimFailure(req, env, claim);
    return issuePageCode(env, id, key, session.accountId);
  }
  const identities = await verifiedIdentities(env, session.accountId);
  const claim = await stub(env, id).fetch(claimRequest(id, key, "guest", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: session.accountId, identities }),
  }));
  if (!claim.ok) {
    if (claim.status === 403) {
      const err = await claim.clone().json().catch(() => null) as { error?: { code?: string } } | null;
      if (err?.error?.code === "wrong_guest_email") {
        return html(`<section class="card"><span class="eyebrow">Guest invitation</span><h1>This invitation is for another email address</h1><p class="lead">${info.expected ? `This link is restricted to <code>${escape(info.expected)}</code>.` : "Your signed-in account does not match the invited email address."} Sign in with a matching account to join.</p>${renderAuthControls(env, returnTo, { expectedEmail: info.expected, compact: true })}</section>`, 403, "", env);
      }
      if (err?.error?.code === "declined") {
        return html(`<section class="card"><span class="eyebrow">Guest invitation</span><h1>Invitation unavailable</h1><p class="lead">This invitation was revoked.</p></section>`, 403);
      }
    }
    return claim;
  }
  return issuePageCode(env, id, key, session.accountId, "guest");
}

export async function redeemPageCode(env: Env, id: string, key: string, code: string): Promise<Response> {
  if (!env.ACCOUNTS) return errorResponse(503, "unavailable", "Accounts database is not configured");
  const row = await env.ACCOUNTS.prepare(`DELETE FROM page_codes WHERE hash = ? AND tendril_id = ? AND key_hash = ? AND expires_at > ?
    RETURNING account_id, role`).bind(await sha256Hex(code), id, await sha256Hex(key), Date.now())
    .first<{ account_id: string; role: string }>();
  if (!row) return errorResponse(403, "invalid_code", "Page sign-in expired or already used");
  const token = randomToken();
  const res = await stub(env, id).fetch(claimRequest(id, key, "session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: row.account_id, role: row.role, hash: await sha256Hex(token) }),
  }));
  if (!res.ok) return res;
  return redirect(pageUrl(env, id, key), pageSessionCookieHeader(token, env));
}
