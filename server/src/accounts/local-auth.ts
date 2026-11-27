import type { Env } from "../env";
import { errorResponse, readBody } from "../http";
import { safeEqual } from "../ids";
import { publicBase } from "../urls";

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const HASH_RE = /^pbkdf2_sha256\$([1-9][0-9]{4,6})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,128})$/;
const MAX_PBKDF2_ITERATIONS = 100_000;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True only for loopback origins (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** Plain HTTP loopback uses a non-Secure cookie name so Safari/WebKit also accepts it locally. */
function usesPlainHttpLoopback(env: Env): boolean {
  const base = publicBase(env);
  return base.startsWith("http://") && isLoopbackOrigin(base);
}

/** CSP `form-action` for sign-in pages so Chromium allows the post-login redirect to the page subdomain or verified custom domain. */
export function authFormAction(env: Env, customOrigin?: string | null): string {
  const extra = customOrigin ? ` ${customOrigin}` : "";
  const domain = (env.PAGE_BASE_DOMAIN ?? "").trim().toLowerCase();
  if (!domain || /[^a-z0-9.-]/.test(domain)) return `'self'${extra}`;
  if (usesPlainHttpLoopback(env)) {
    const port = new URL(publicBase(env)).port;
    return `'self' http://*.${domain}${port ? `:${port}` : ""}${extra}`;
  }
  return `'self' https://*.${domain}${extra}`;
}

export function sessionCookieHeader(value: string, maxAgeSeconds: number, env: Env): string {
  if (usesPlainHttpLoopback(env)) {
    return `tendriller_local=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  }
  return `__Host-tendriller=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function readSessionCookie(req: Request, env: Env): string | null {
  const header = req.headers.get("Cookie") ?? "";
  const secure = /(?:^|;\s*)__Host-tendriller=([^;]+)/.exec(header)?.[1];
  if (secure) return secure;
  if (usesPlainHttpLoopback(env)) {
    return /(?:^|;\s*)tendriller_local=([^;]+)/.exec(header)?.[1] ?? null;
  }
  return null;
}

export function pageSessionCookieHeader(token: string, env: Env): string {
  if (usesPlainHttpLoopback(env)) {
    return `tendril_local=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
  }
  return `__Host-tendril=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

export function readPageSessionCookie(req: Request, env: Env): string | null {
  const header = req.headers.get("Cookie") ?? "";
  const secure = /(?:^|;\s*)__Host-tendril=([^;]+)/.exec(header)?.[1];
  if (secure) return secure;
  if (usesPlainHttpLoopback(env)) {
    return /(?:^|;\s*)tendril_local=([^;]+)/.exec(header)?.[1] ?? null;
  }
  return null;
}

/** Loopback-only passwordless sign-in: requires BOTH `LOCAL_DEV_AUTH=1` AND a loopback `PUBLIC_BASE`. */
export function localDevAuthEnabled(env: Env): boolean {
  return env.LOCAL_DEV_AUTH === "1" && isLoopbackOrigin(publicBase(env));
}

export function passwordAuthConfig(env: Env): { hash: string; email: string } | null {
  const hash = env.LOCAL_PASSWORD_HASH?.trim() ?? "";
  const email = env.LOCAL_OWNER_EMAIL?.trim().toLowerCase() ?? "";
  if (!hash || !HASH_RE.test(hash) || !email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return { hash, email };
}

export interface AuthProviders {
  github: boolean;
  google: boolean;
  password: { email: string } | null;
  localDev: { defaultEmail: string } | null;
}

export function configuredAuthProviders(env: Env): AuthProviders {
  const pw = passwordAuthConfig(env);
  const defaultLocalEmail = (env.LOCAL_OWNER_EMAIL?.trim().toLowerCase() || "dev@local.dev");
  return {
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    password: pw ? { email: pw.email } : null,
    localDev: localDevAuthEnabled(env)
      ? { defaultEmail: EMAIL_RE.test(defaultLocalEmail) ? defaultLocalEmail : "dev@local.dev" }
      : null,
  };
}

/** Pure Web Crypto PBKDF2-SHA256 hash generator (usable in Workers and Node). */
export async function hashPassword(password: string, iterations = MAX_PBKDF2_ITERATIONS): Promise<string> {
  const bounded = Math.min(Math.max(10_000, iterations), MAX_PBKDF2_ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: bounded }, key, 256));
  return `pbkdf2_sha256$${bounded}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

/** Constant-time PBKDF2-SHA256 verification. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = HASH_RE.exec(encoded);
  if (!m) return false;
  const iterations = Number(m[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || iterations > MAX_PBKDF2_ITERATIONS) return false;
  const salt = fromBase64Url(m[2]);
  const expected = m[3];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  return safeEqual(toBase64Url(derived), expected);
}

/** Renders the configured sign-in methods uniformly for `/auth` and `/auth/page`. */
export function renderAuthControls(
  env: Env,
  returnTo: string,
  options?: { error?: string | null; expectedEmail?: string | null; compact?: boolean },
): string {
  const providers = configuredAuthProviders(env);
  const back = encodeURIComponent(returnTo);
  const parts: string[] = [];

  if (options?.error === "invalid_password") {
    parts.push(`<p class="notice danger" role="alert">Incorrect password. Please try again.</p>`);
  } else if (options?.error === "invalid_email") {
    parts.push(`<p class="notice danger" role="alert">Enter a valid email address to continue locally.</p>`);
  }

  const oauthButtons: string[] = [];
  if (providers.github) {
    oauthButtons.push(`<a class="button${options?.compact ? "" : " lg"}" href="/auth/github?return_to=${back}">Continue with GitHub</a>`);
  }
  if (providers.google) {
    oauthButtons.push(`<a class="button ${oauthButtons.length ? "secondary" : ""}${options?.compact ? "" : " lg"}" href="/auth/google?return_to=${back}">Continue with Google</a>`);
  }
  if (oauthButtons.length) {
    parts.push(`<div class="actions">${oauthButtons.join("")}</div>`);
  }

  if (providers.password) {
    const sep = parts.length ? `<div class="section-title" style="margin:1.35rem 0 .85rem"><span class="rule"></span><small>or password</small><span class="rule"></span></div>` : "";
    parts.push(`${sep}<form method="post" action="/auth/password" style="margin-top:${parts.length ? "0" : "1rem"}">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <div class="field">
        <label class="field-label" for="auth-password">Instance password</label>
        <input id="auth-password" name="password" type="password" required autocomplete="current-password" placeholder="Enter your self-hosted password">
        <span class="field-hint">Signs in as <code>${escapeHtml(providers.password.email)}</code></span>
      </div>
      <div class="actions"><button type="submit"${options?.compact ? "" : ' class="lg"'}>Sign in with password</button></div>
    </form>`);
  }

  if (providers.localDev) {
    const prefill = options?.expectedEmail && !options.expectedEmail.includes("*") && EMAIL_RE.test(options.expectedEmail)
      ? options.expectedEmail
      : providers.localDev.defaultEmail;
    const sep = parts.length ? `<div class="section-title" style="margin:1.35rem 0 .85rem"><span class="rule"></span><small>or local dev</small><span class="rule"></span></div>` : "";
    parts.push(`${sep}<form method="post" action="/auth/local" style="margin-top:${parts.length ? "0" : "1rem"}">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <div class="field">
        <label class="field-label" for="local-email">Local dev email (no password)</label>
        <input id="local-email" name="email" type="email" required maxlength="254" value="${escapeHtml(prefill)}" autocomplete="email">
        <span class="field-hint">Loopback-only development sign-in. Enter any email to test owner or invited guest flows locally.</span>
      </div>
      <div class="actions"><button type="submit" class="cta${options?.compact ? "" : " lg"}">Continue locally</button></div>
    </form>`);
  }

  if (!oauthButtons.length && !providers.password && !providers.localDev) {
    parts.push(`<div class="notice warn" style="margin-top:1rem"><div><strong>No sign-in method is configured on this host.</strong><br>Configure GitHub or Google OAuth credentials, set <code>LOCAL_PASSWORD_HASH</code> + <code>LOCAL_OWNER_EMAIL</code> for self-hosted password sign-in, or run <code>npm run dev</code> on localhost.</div></div>`);
  }

  return parts.join("");
}

export async function routeLocalAuth(
  req: Request,
  env: Env,
  path: string,
  helpers: {
    safeReturn: (value: string | null) => string;
    issueAccountSession: (provider: "local" | "password", email: string, returnTo: string) => Promise<Response>;
  },
): Promise<Response | null> {
  if (path !== "/auth/local" && path !== "/auth/password") return null;
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST");
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) {
    return errorResponse(403, "bad_origin", "Invalid sign-in origin");
  }
  if (req.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    return errorResponse(415, "unsupported_media_type", "Expected form submission");
  }
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: ip })).success) {
    return errorResponse(429, "rate_limited", "Too many sign-in attempts");
  }

  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
  const returnTo = helpers.safeReturn(form.get("return_to"));
  const wantsHtml = req.headers.get("Accept")?.includes("text/html") ?? false;

  if (path === "/auth/local") {
    if (!localDevAuthEnabled(env)) return errorResponse(404, "not_found", "Local dev sign-in is disabled");
    const email = (form.get("email") ?? "").trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      if (wantsHtml) {
        return new Response(null, { status: 303, headers: { Location: `/auth?error=invalid_email&return_to=${encodeURIComponent(returnTo)}`, "Cache-Control": "no-store" } });
      }
      return errorResponse(400, "invalid_email", "Enter a valid email address");
    }
    return helpers.issueAccountSession("local", email, returnTo);
  }

  // POST /auth/password
  const cfg = passwordAuthConfig(env);
  if (!cfg) return errorResponse(404, "not_found", "Password sign-in is not configured");
  const password = form.get("password") ?? "";
  if (!password || password.length > 512 || !(await verifyPassword(password, cfg.hash))) {
    if (env.FAILED_AUTH_RATE) await env.FAILED_AUTH_RATE.limit({ key: ip });
    if (wantsHtml) {
      return new Response(null, { status: 303, headers: { Location: `/auth?error=invalid_password&return_to=${encodeURIComponent(returnTo)}`, "Cache-Control": "no-store" } });
    }
    return errorResponse(401, "invalid_password", "Incorrect password");
  }
  return helpers.issueAccountSession("password", cfg.email, returnTo);
}
