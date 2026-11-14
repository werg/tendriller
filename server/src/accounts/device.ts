import { servicePage } from "./ui";
import type { Env } from "../env";
import { errorResponse, HttpError, json, readBody, readJson } from "../http";
import { sha256Hex } from "../ids";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";

function random(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function escape(s: string): string { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
const html = (body: string, status = 200) => servicePage("Authorize agent", body, "", status);

export async function apiDevice(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.ACCOUNTS;
  if (!db) throw new HttpError(503, "unavailable");
  if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
    throw new HttpError(429, "rate_limited", "Too many device requests");
  }
  if (url.pathname === "/api/device" && req.method === "POST") {
    const body = await readJson(req, 4096);
    const name = body.name ?? "Agent";
    if (typeof name !== "string" || !/^[A-Za-z0-9 _.@-]{1,64}$/.test(name)) throw new HttpError(400, "bad_request", "Agent name must be 1–64 plain characters");
    const deviceCode = random();
    const userCode = random(8).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase();
    if (userCode.length < 8) throw new HttpError(503, "unavailable", "Could not allocate device code");
    await db.prepare("INSERT INTO device_codes (hash, user_code, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(deviceCode), userCode, name, Date.now(), Date.now() + 10 * 60_000).run();
    return json({ device_code: deviceCode, user_code: userCode, verification_url: `${publicBase(env)}/device`, expires_in: 600, interval: 5 }, 201);
  }
  if (url.pathname === "/api/device/token" && req.method === "POST") {
    const body = await readJson(req, 4096);
    if (typeof body.device_code !== "string" || body.device_code.length > 128) throw new HttpError(400, "bad_request", "Invalid device code");
    const hash = await sha256Hex(body.device_code);
    const pending = await db.prepare("SELECT account_id, expires_at FROM device_codes WHERE hash = ?")
      .bind(hash).first<{ account_id: string | null; expires_at: number }>();
    if (!pending || pending.expires_at <= Date.now()) throw new HttpError(400, "expired_token", "Device request expired");
    if (!pending.account_id) return json({ error: { code: "authorization_pending" } }, 428);
    const approved = await db.prepare("DELETE FROM device_codes WHERE hash = ? AND account_id IS NOT NULL AND expires_at > ? RETURNING account_id, name")
      .bind(hash, Date.now()).first<{ account_id: string; name: string }>();
    if (!approved) throw new HttpError(400, "expired_token", "Device request already redeemed");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = "ak_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(key), approved.name, approved.account_id, Date.now()).run();
    return json({ key, token_type: "Bearer" });
  }
  return errorResponse(404, "not_found");
}

export async function devicePage(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env);
  if (!session || !env.ACCOUNTS) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname + url.search)}` } });
  const code = (url.searchParams.get("code") ?? "").toUpperCase();
  if (req.method === "GET") {
    const row = code ? await env.ACCOUNTS.prepare("SELECT name FROM device_codes WHERE user_code = ? AND account_id IS NULL AND expires_at > ?")
      .bind(code, Date.now()).first<{ name: string }>() : null;
    return html(`<h1>Authorize an agent</h1><p>Enter the code shown by your agent.</p><form method="get"><input name="code" value="${escape(code)}" maxlength="16" required><button>Find request</button></form>
      ${row ? `<p>Agent <strong>${escape(row.name)}</strong> wants a key that can create and manage tendrils for your account.</p><form method="post"><input type="hidden" name="code" value="${escape(code)}"><button>Approve this agent</button></form>` : code ? "<p>No pending request with this code.</p>" : ""}`);
  }
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed");
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid approval origin");
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
  const userCode = (form.get("code") ?? "").toUpperCase();
  const approved = await env.ACCOUNTS.prepare("UPDATE device_codes SET account_id = ?, approved_at = ? WHERE user_code = ? AND account_id IS NULL AND expires_at > ? RETURNING name")
    .bind(session.accountId, Date.now(), userCode, Date.now()).first<{ name: string }>();
  if (!approved) return html("<h1>Request expired or already approved</h1>", 404);
  return html(`<h1>Agent approved</h1><p>${escape(approved.name)} can now receive its key. You can revoke it on your dashboard.</p><p><a href="/dashboard">Open dashboard</a></p>`);
}
