import type { Env } from "../env";
import { errorResponse, readBody } from "../http";
import { PAGE_KEY_RE, sha256Hex, TENDRIL_ID_RE } from "../ids";
import { pageUrl, publicBase } from "../urls";
import { serviceSession } from "./auth";
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
function html(body: string, status = 200, script = ""): Response {
  const response = servicePage("Open page", body, script);
  return status === 200 ? response : new Response(response.body, { status, headers: response.headers });
}
function waitingPage(): Response {
  return html(`<section class="hero"><span class="eyebrow">Invitation requested</span><h1>Waiting for the owner</h1><p>Your request is in the page owner's control panel. This page will open automatically when they approve it.</p><p id="claim-status" class="notice" role="status">Checking for approval…</p></section><p class="muted">You can leave this tab open, or return to this invitation link later.</p>`, 200,
    `<script>const target=new URL(location.href);target.searchParams.set('status','1');async function check(){try{const r=await fetch(target,{cache:'no-store'});if(r.status===401){location.reload();return}if(!r.ok)throw Error();const d=await r.json();if(d.status==='approved'){location.href=location.pathname+location.search.replace(/([?&])status=1(&|$)/,'$1').replace(/[?&]$/,'');return}if(d.status==='declined'){document.querySelector('#claim-status').textContent='The owner declined this invitation.';return}document.querySelector('#claim-status').textContent='Still waiting for approval.'}catch{document.querySelector('#claim-status').textContent='Could not check right now. Retrying…'}setTimeout(check,4000)}check()</script>`);
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
    return html(`<section class="hero"><span class="eyebrow">${info.role === "guest" ? "Guest invitation" : "A page made for you"}</span><h1>${info.role === "guest" ? "You're invited in." : "Your agent made a page for you."}</h1><p>Sign in to open it. Your page lives on its own address, and you can control connected agents after you claim it.</p><p class="muted">${info.expected ? `Intended owner: ${escape(info.expected)}` : "Keep this invitation link private."}</p><div class="actions"><a class="button" href="/auth/github?return_to=${encodeURIComponent(returnTo)}">Continue with GitHub</a><a class="button secondary" href="/auth/google?return_to=${encodeURIComponent(returnTo)}">Continue with Google</a></div></section><p class="muted">Signing in lets Tendriller recognize you. Your agent never receives your sign-in credentials.</p>`);
  }
  const deleting = await env.ACCOUNTS.prepare("SELECT deleting_at FROM accounts WHERE id = ?").bind(session.accountId)
    .first<{ deleting_at: number | null }>();
  if (deleting?.deleting_at) return errorResponse(403, "account_deleting", "Account deletion is in progress");
  const owner = await env.ACCOUNTS.prepare("SELECT owner_account FROM tendrils WHERE id = ?").bind(id).first<{ owner_account: string | null }>();
  if (!owner) return errorResponse(404, "not_found", "No such tendril");
  if (info.role === "owner" && owner.owner_account === session.accountId) return issuePageCode(env, id, key, session.accountId);
  if (info.role === "owner" && owner.owner_account) return html("<h1>This page belongs to another account</h1>", 403);
  if (info.role === "guest" && !owner.owner_account) return html("<h1>Waiting for the owner to claim this page</h1>", 403);
  if (info.role === "guest" && req.method === "GET") {
    const statusRes = await stub(env, id).fetch(claimRequest(id, key, "guest-status", { headers: { "x-account-id": session.accountId } }));
    if (!statusRes.ok) return statusRes;
    const { status } = await statusRes.json() as { status: string };
    if (url.searchParams.get("status") === "1") return new Response(JSON.stringify({ status }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    if (status === "approved") return issuePageCode(env, id, key, session.accountId, "guest");
    if (status === "pending") return waitingPage();
    if (status === "declined") return html("<section class=\"hero\"><h1>Invitation declined</h1><p>The owner did not approve this request.</p></section>", 403);
  }
  if (req.method === "GET") {
    const nonce = randomToken();
    await env.ACCOUNTS.prepare("INSERT INTO claim_intents (hash, tendril_id, key_hash, account_id, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(nonce), id, await sha256Hex(key), session.accountId, Date.now() + 10 * 60_000).run();
    return html(`<section class="hero"><span class="eyebrow">${info.role === "guest" ? "Guest invitation" : "Ready to claim"}</span><h1>${info.role === "guest" ? "Join this page" : "Make this page yours"}</h1><p>${info.role === "guest" ? "The owner may need to approve your request. This screen will update when they do." : "Your agent can update the page after you claim it. You can disconnect it from the page's controls at any time."}</p><p class="muted">${info.expected ? `Intended owner: ${escape(info.expected)}` : "Keep this link private."}</p><form method="post"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">${info.role === "guest" ? "Request access" : "Claim and open page"}</button></form></section><p class="muted">By continuing, you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>`);
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
    return waitingPage();
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
