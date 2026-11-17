// Shared test helpers: authenticated host requests and clock control.
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Tendril } from "../src/tendril";
import { sha256Hex } from "../src/ids";

export const BASE = "https://tendriller.dev";

/**
 * Fetches through the Worker. A request to a page that `create` claimed carries the owner's
 * page session unless the caller sets its own Cookie header or passes `anonymous: true`.
 */
export function req(path: string, init?: RequestInit & { anonymous?: boolean }): Promise<Response> {
  const url = path.startsWith("http") ? path : BASE + path;
  const { anonymous, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (!anonymous && !headers.has("Cookie")) {
    for (const [k, v] of Object.entries(ownerHeaders(url))) if (!headers.has(k)) headers.set(k, v);
  }
  return exports.default.fetch(url, { ...rest, headers });
}

export interface Handle {
  id: string;
  name: string;
  page_url: string;
  api: string;
  token: string;
  agent_md: string;
  application: { id: string };
  lifetime: string;
  expires_at: number | null;
}

/** Owner page-session cookies by tendril id, filled by `create`. */
const ownerCookies = new Map<string, string>();

function randomTestIp(): string {
  // 198.18.0.0/15 is reserved for benchmarking; a fresh address avoids per-IP creation limits.
  const b = crypto.getRandomValues(new Uint8Array(3));
  return `198.${18 + (b[0] & 1)}.${b[1]}.${b[2]}`;
}

/**
 * Creates a tendril the way the public service does: for an owner email, from a creator IP.
 * Unless `claim: false` is passed, it then signs in as that owner and keeps the page-session
 * cookie, so ordinary page requests carry its account session.
 */
export async function create(body: Record<string, unknown> & { claim?: boolean; listener?: boolean } = {}): Promise<Handle> {
  const { claim = true, listener: _listener, ...rest } = body;
  const email = typeof rest.owner === "string" ? rest.owner : `owner-${crypto.randomUUID()}@example.com`;
  const account = crypto.randomUUID();
  const db = env.ACCOUNTS!;
  const now = Date.now();
  if (claim) await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, now, email).run();
  const res = await req("/api/tendrils", { method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": randomTestIp() },
    body: JSON.stringify({ ...rest, owner: email }) });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const h = (await res.json()) as Handle;
  if (claim) ownerCookies.set(h.id, await signInAsOwner(h, account, email));
  return h;
}

/** Signs `account` in, follows the owner auto-claim, and returns the page-session cookie. */
export async function signInAsOwner(h: Handle, account: string, email: string): Promise<string> {
  const db = env.ACCOUNTS!;
  const now = Date.now();
  const raw = `test-${crypto.randomUUID()}`;
  await db.batch([
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', ?, ?, ?, ?, ?)")
      .bind(account, account, email.split("@")[0], email, now),
    db.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('google', ?, ?)").bind(account, email),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(raw), account, now, now + 86_400_000),
  ]);
  const key = new URL(h.page_url).pathname.split("/")[2];
  const redirect = await req(`/auth/page?tendril=${h.id}&key=${key}`, { headers: { Cookie: `__Host-tendriller=${raw}` }, redirect: "manual" });
  if (redirect.status !== 303) throw new Error(`owner sign-in failed: ${redirect.status} ${await redirect.text()}`);
  const session = await req(redirect.headers.get("Location")!, { redirect: "manual" });
  const cookie = session.headers.get("Set-Cookie")?.split(";")[0];
  if (!cookie) throw new Error(`no page session cookie: ${session.status}`);
  return cookie;
}

/** Headers that make a request to `pageUrl` as the tendril's signed-in owner, if `create` claimed it. */
export function ownerHeaders(pageUrl: string): Record<string, string> {
  const url = new URL(pageUrl);
  if (!url.hostname.endsWith(".tendriller.site")) return {};
  const cookie = ownerCookies.get(url.hostname.split(".")[0]);
  return cookie ? { Cookie: cookie, Origin: url.origin } : {};
}

/** Calls the agent API of a tendril. `body` objects are sent as JSON. */
export async function api(h: Handle, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, token = h.token): Promise<Response> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (body !== undefined) {
    if (typeof body === "string" || body instanceof ArrayBuffer || body instanceof Uint8Array) init.body = body as BodyInit;
    else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }
  return req(h.api + (path ? "/" + path : ""), init);
}

export async function apiJson<T = any>(h: Handle, method: string, path: string, body?: unknown, expectStatus?: number): Promise<T> {
  const res = await api(h, method, path, body);
  const text = await res.text();
  if (expectStatus !== undefined && res.status !== expectStatus) throw new Error(`${method} ${path}: expected ${expectStatus}, got ${res.status}: ${text}`);
  if (expectStatus === undefined && !res.ok) throw new Error(`${method} ${path}: ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export function stub(id: string): DurableObjectStub {
  return env.TENDRIL.get(env.TENDRIL.idFromName(id));
}

/** Runs a callback inside the tendril's Durable Object instance. */
export function inDO<R>(id: string, fn: (t: Tendril) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub(id), (inst: Tendril) => fn(inst));
}

/** Moves the tendril's clock forward. */
export function advance(id: string, ms: number): Promise<void> {
  return inDO(id, (t) => {
    t.skew += ms;
  });
}

export function runAlarm(id: string): Promise<boolean> {
  return runDurableObjectAlarm(stub(id));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function rb32(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += B32[Math.floor(Math.random() * 32)];
  return s;
}
