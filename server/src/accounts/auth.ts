import type { Env } from "../env";
import { errorResponse, json } from "../http";
import { sha256Hex } from "../ids";
import { publicBase } from "../urls";

type Provider = "github" | "google";
export interface AccountSession { accountId: string; email: string | null; createdAt: number }

function randomUrlToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ Location: to, "Cache-Control": "no-store" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function client(env: Env, provider: Provider): { id: string; secret: string } | null {
  const id = provider === "github" ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID;
  const secret = provider === "github" ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

function safeReturn(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/dashboard";
  return value;
}

export async function serviceSession(req: Request, env: Env): Promise<AccountSession | null> {
  if (!env.ACCOUNTS) return null;
  const cookie = /(?:^|;\s*)__Host-tendriller=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1];
  if (!cookie) return null;
  const hash = await sha256Hex(cookie);
  const row = await env.ACCOUNTS.prepare(`SELECT a.id AS accountId, a.email, a.created_at AS createdAt
    FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.hash = ? AND s.expires_at > ? AND a.suspended_at IS NULL`).bind(hash, Date.now()).first<AccountSession>();
  return row ?? null;
}

export async function routeAuth(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.ACCOUNTS;
  if (!db) return errorResponse(503, "unavailable", "Accounts database is not configured");
  const path = url.pathname;
  if (path === "/auth" && req.method === "GET") {
    const back = encodeURIComponent(safeReturn(url.searchParams.get("return_to")));
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Sign in · Tendriller</title></head><body><main><h1>Sign in to Tendriller</h1><p>Choose an account to open your tendrils.</p><a href="/auth/github?return_to=${back}">Continue with GitHub</a><br><a href="/auth/google?return_to=${back}">Continue with Google</a></main></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const begin = /^\/auth\/(link\/)?(github|google)$/.exec(path);
  if (begin && req.method === "GET") {
    const provider = begin[2] as Provider;
    const linking = !!begin[1];
    const session = linking ? await serviceSession(req, env) : null;
    if (linking && !session) return errorResponse(401, "unauthorized", "Sign in before linking an account");
    const c = client(env, provider);
    if (!c) return errorResponse(503, "unavailable", `${provider} sign-in is not configured`);
    if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
      return errorResponse(429, "rate_limited", "Too many sign-in attempts");
    }
    const state = randomUrlToken();
    const verifier = randomUrlToken();
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await db.prepare("INSERT INTO oauth_states (hash, provider, verifier, return_to, link_account, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(state), provider, verifier, safeReturn(url.searchParams.get("return_to")), session?.accountId ?? null, Date.now() + 10 * 60_000).run();
    const callback = `${publicBase(env)}/auth/callback/${provider}`;
    const auth = new URL(provider === "github" ? "https://github.com/login/oauth/authorize" : "https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", c.id);
    auth.searchParams.set("redirect_uri", callback);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("state", state);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", "S256");
    auth.searchParams.set("scope", provider === "github" ? "read:user user:email" : "openid email profile");
    return redirect(auth.toString(), `__Host-tendriller-oauth=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
  }

  const callback = /^\/auth\/callback\/(github|google)$/.exec(path);
  if (callback && req.method === "GET") {
    const provider = callback[1] as Provider;
    const c = client(env, provider);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!c || !state || !code) return errorResponse(400, "bad_request", "Missing OAuth callback fields");
    const browserState = /(?:^|;\s*)__Host-tendriller-oauth=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1];
    if (browserState !== state) return errorResponse(403, "invalid_state", "Sign-in was started in another browser");
    const hash = await sha256Hex(state);
    const pending = await db.prepare("DELETE FROM oauth_states WHERE hash = ? AND provider = ? AND expires_at > ? RETURNING verifier, return_to, link_account")
      .bind(hash, provider, Date.now()).first<{ verifier: string; return_to: string; link_account: string | null }>();
    if (!pending) return errorResponse(400, "invalid_state", "Sign-in expired or already used");
    if (pending.link_account && (await serviceSession(req, env))?.accountId !== pending.link_account) {
      return errorResponse(403, "forbidden", "Linking session changed or expired");
    }
    const tokenUrl = provider === "github" ? "https://github.com/login/oauth/access_token" : "https://oauth2.googleapis.com/token";
    const tokenRes = await fetch(tokenUrl, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, code,
        redirect_uri: `${publicBase(env)}/auth/callback/${provider}`, code_verifier: pending.verifier,
        grant_type: "authorization_code" }),
    });
    if (!tokenRes.ok) return errorResponse(502, "oauth_failed", "Token exchange failed");
    const token = await tokenRes.json() as { access_token?: string };
    if (!token.access_token) return errorResponse(502, "oauth_failed", "Provider did not issue a token");
    const profile = await providerProfile(provider, token.access_token);
    if (!profile) return errorResponse(502, "oauth_failed", "Could not verify provider identity");
    const blocked = await db.prepare("SELECT 1 FROM blocks WHERE kind = 'identity' AND value = ? AND (expires_at IS NULL OR expires_at > ?)")
      .bind(`${provider}:${profile.subject}`, Date.now()).first();
    if (blocked) return errorResponse(403, "blocked", "This identity cannot sign in");
    const existing = await db.prepare("SELECT account_id FROM identities WHERE provider = ? AND subject = ?")
      .bind(provider, profile.subject).first<{ account_id: string }>();
    if (existing) {
      const suspended = await db.prepare("SELECT suspended_at, deleting_at FROM accounts WHERE id = ?").bind(existing.account_id)
        .first<{ suspended_at: number | null; deleting_at: number | null }>();
      if (suspended?.suspended_at || suspended?.deleting_at) return errorResponse(403, "unavailable", "This account is unavailable");
    }
    if (pending.link_account && existing && pending.link_account !== existing.account_id) {
      return errorResponse(409, "identity_in_use", "That provider account belongs to another Tendriller account");
    }
    let accountId = existing?.account_id;
    if (!accountId) {
      accountId = pending.link_account ?? crypto.randomUUID();
      await db.batch([
        ...(pending.link_account ? [] : [db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(accountId, Date.now(), profile.email)]),
        db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(provider, profile.subject, accountId, profile.login, profile.email, Date.now()),
      ]);
    } else {
      await db.prepare("UPDATE identities SET login = ?, email = ? WHERE provider = ? AND subject = ?")
        .bind(profile.login, profile.email, provider, profile.subject).run();
    }
    await db.batch([
      db.prepare("DELETE FROM identity_emails WHERE provider = ? AND subject = ?").bind(provider, profile.subject),
      ...profile.emails.map((email) => db.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES (?, ?, ?)").bind(provider, profile.subject, email.toLowerCase())),
    ]);
    const session = randomUrlToken();
    await db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(session), accountId, Date.now(), Date.now() + 30 * 86_400_000).run();
    return redirect(safeReturn(pending.return_to), `__Host-tendriller=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }

  if (path === "/auth/me" && req.method === "GET") {
    const session = await serviceSession(req, env);
    return session ? json(session) : errorResponse(401, "unauthorized", "Sign in first");
  }
  if (path === "/auth/logout" && req.method === "POST") {
    if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid logout origin");
    const raw = /(?:^|;\s*)__Host-tendriller=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1];
    if (raw) await db.prepare("DELETE FROM sessions WHERE hash = ?").bind(await sha256Hex(raw)).run();
    return redirect("/", "__Host-tendriller=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  }
  return errorResponse(404, "not_found", "Unknown auth route");
}

async function providerProfile(provider: Provider, token: string): Promise<{ subject: string; login: string; email: string | null; emails: string[] } | null> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "Tendriller" };
  if (provider === "github") {
    const [userRes, emailRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers }),
      fetch("https://api.github.com/user/emails", { headers }),
    ]);
    if (!userRes.ok || !emailRes.ok) return null;
    const user = await userRes.json() as { id?: number; login?: string };
    const emails = await emailRes.json() as { email: string; verified: boolean; primary: boolean }[];
    if (!Number.isSafeInteger(user.id) || !user.login || !Array.isArray(emails)) return null;
    const verified = emails.filter((e) => e.verified && typeof e.email === "string").map((e) => e.email);
    const email = emails.find((e) => e.verified && e.primary)?.email ?? verified[0] ?? null;
    return { subject: String(user.id), login: user.login, email, emails: verified };
  }
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers });
  if (!res.ok) return null;
  const user = await res.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (!user.sub) return null;
  const email = user.email_verified ? user.email ?? null : null;
  return { subject: user.sub, login: user.name ?? user.email ?? user.sub, email, emails: email ? [email] : [] };
}
