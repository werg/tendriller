import type { Env } from "../env";
import { errorResponse, readBody } from "../http";
import { PAGE_KEY_RE, sha256Hex, TENDRIL_ID_RE } from "../ids";
import { pageUrl, publicBase } from "../urls";
import { serviceSession } from "./auth";

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
function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open tendril · Tendriller</title></head><body><main>${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
}

async function issuePageCode(env: Env, id: string, key: string, accountId: string, role: "owner" | "guest" = "owner"): Promise<Response> {
  const code = randomToken();
  await env.ACCOUNTS!.prepare("INSERT INTO page_codes (hash, tendril_id, account_id, role, key_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(code), id, accountId, role, await sha256Hex(key), Date.now() + 60_000).run();
  return redirect(`${pageUrl(env, id, key)}_tendril/session?code=${encodeURIComponent(code)}`);
}

export async function routePageAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ACCOUNTS) return errorResponse(503, "unavailable", "Accounts database is not configured");
  const id = url.searchParams.get("tendril") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!TENDRIL_ID_RE.test(id) || !PAGE_KEY_RE.test(key)) return errorResponse(400, "bad_request", "Invalid page link");
  const infoRes = await stub(env, id).fetch(claimRequest(id, key, "info"));
  if (!infoRes.ok) return infoRes;
  const info = await infoRes.json() as { claimed: boolean; expected: string | null; role: string };
  if (info.role !== "owner" && info.role !== "guest") return errorResponse(403, "forbidden", "This link cannot be claimed");
  const session = await serviceSession(req, env);
  const returnTo = `/auth/page?tendril=${id}&key=${key}`;
  if (!session) {
    if (req.method !== "GET") return errorResponse(401, "unauthorized", "Sign in first");
    return html(`<h1>An AI agent made this page for you</h1><p>Sign in with GitHub or Google to open it.</p>
      <p>Expected owner: ${escape(info.expected ?? "first person to claim")}</p>
      <p><a href="/auth/github?return_to=${encodeURIComponent(returnTo)}">Sign in with GitHub</a></p>
      <p><a href="/auth/google?return_to=${encodeURIComponent(returnTo)}">Sign in with Google</a></p>
      <p>Review the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>`);
  }
  const deleting = await env.ACCOUNTS.prepare("SELECT deleting_at FROM accounts WHERE id = ?").bind(session.accountId)
    .first<{ deleting_at: number | null }>();
  if (deleting?.deleting_at) return errorResponse(403, "account_deleting", "Account deletion is in progress");
  const owner = await env.ACCOUNTS.prepare("SELECT owner_account FROM tendrils WHERE id = ?").bind(id).first<{ owner_account: string | null }>();
  if (!owner) return errorResponse(404, "not_found", "No such tendril");
  if (info.role === "owner" && owner.owner_account === session.accountId) return issuePageCode(env, id, key, session.accountId);
  if (info.role === "owner" && owner.owner_account) return html("<h1>This page belongs to another account</h1>", 403);
  if (info.role === "guest" && !owner.owner_account) return html("<h1>Waiting for the owner to claim this page</h1>", 403);
  if (req.method === "GET") {
    const nonce = randomToken();
    await env.ACCOUNTS.prepare("INSERT INTO claim_intents (hash, tendril_id, key_hash, account_id, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(nonce), id, await sha256Hex(key), session.accountId, Date.now() + 10 * 60_000).run();
    return html(`<h1>${info.role === "guest" ? "You've been invited to a tendril" : "An AI agent made this page for you"}</h1><p>Expected owner: ${escape(info.expected ?? "anyone with this link")}</p>
      <p>Tendriller never asks for passwords in a page. The agent can still change this page after you claim it; you can disconnect it later.</p>
      <form method="post"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">${info.role === "guest" ? "Join page" : "Claim and open page"}</button></form>
      <p>By claiming, you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>`);
  }
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use GET or POST");
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid claim origin");
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
  const nonce = form.get("nonce");
  if (typeof nonce !== "string") return errorResponse(400, "bad_request", "Missing claim token");
  const intent = await env.ACCOUNTS.prepare(`DELETE FROM claim_intents WHERE hash = ? AND tendril_id = ? AND key_hash = ?
    AND account_id = ? AND expires_at > ? RETURNING hash`)
    .bind(await sha256Hex(nonce), id, await sha256Hex(key), session.accountId, Date.now()).first();
  if (!intent) return errorResponse(403, "invalid_claim", "Claim expired or already used");
  const identities = await env.ACCOUNTS.prepare(`SELECT i.provider, i.login, e.email FROM identities i
    LEFT JOIN identity_emails e ON e.provider = i.provider AND e.subject = i.subject WHERE i.account_id = ?`)
    .bind(session.accountId).all<{ provider: string; login: string; email: string | null }>();
  const grouped = new Map<string, { provider: string; login: string; emails: string[] }>();
  for (const row of identities.results) {
    const item = grouped.get(row.provider) ?? { provider: row.provider, login: row.login, emails: [] };
    if (row.email) item.emails.push(row.email);
    grouped.set(row.provider, item);
  }
  const claim = await stub(env, id).fetch(claimRequest(id, key, info.role === "guest" ? "guest" : "owner", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: session.accountId, identities: [...grouped.values()] }),
  }));
  if (!claim.ok) return claim;
  if (info.role === "guest" && !(await claim.json() as { approved: boolean }).approved) {
    return html("<h1>Waiting for the owner's approval</h1><p>Ask the owner to approve your invitation, then open the link again.</p>");
  }
  return issuePageCode(env, id, key, session.accountId, info.role);
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
  return redirect(pageUrl(env, id, key), `__Host-tendril=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
