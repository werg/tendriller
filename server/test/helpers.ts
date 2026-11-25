// Shared test helpers: authenticated host requests and clock control.
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Tendril } from "../src/tendril";
import { sha256Hex } from "../src/ids";
import { localAgentGrant, type AgentPrincipal } from "../src/access";

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
  /** The agent API base for this page: `/api/agent/pages/<id>`. */
  api: string;
  /** The creating agent's account-level credential. */
  token: string;
  agent: { id: string; name: string; public_key: string };
  application: { id: string };
  lifetime: string;
  claimed?: boolean;
  expires_at: number | null;
  /** The owner's account and service session cookie, when `create` claimed the page. */
  account?: string;
  session?: string;
}

/** Owner page-session cookies by tendril id, filled by `create`. */
const ownerCookies = new Map<string, string>();

export function randomTestIp(): string {
  // 198.18.0.0/15 is reserved for benchmarking; a fresh address avoids per-IP creation limits.
  const b = crypto.getRandomValues(new Uint8Array(3));
  return `198.${18 + (b[0] & 1)}.${b[1]}.${b[2]}`;
}

/** A random base64url Ed25519-shaped public key; the host stores and mirrors it only. */
export function testPublicKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Creates an unclaimed agent for an owner email, the way a new agent bootstraps. */
export async function createAgent(owner: string, name = "maintainer"): Promise<{ token: string; agent: Handle["agent"] }> {
  const res = await req("/api/agents", { method: "POST", anonymous: true,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": randomTestIp() },
    body: JSON.stringify({ owner, name, publicKey: testPublicKey() }) });
  if (res.status !== 201) throw new Error(`agent creation failed: ${res.status} ${await res.text()}`);
  return await res.json() as { token: string; agent: Handle["agent"] };
}

/** Calls a service-origin agent route with a token. */
export function agentReq(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return req(path, { method, anonymous: true, headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": randomTestIp(),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** Creates a page with an agent token. */
export async function createPage(agent: { token: string; agent: Handle["agent"] }, body: Record<string, unknown> = {}): Promise<Handle> {
  const res = await agentReq(agent.token, "POST", "/api/agent/pages", body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return { ...await res.json() as Omit<Handle, "token" | "agent">, token: agent.token, agent: agent.agent };
}

/**
 * Creates a tendril the way the public service does: a new unclaimed agent for an
 * owner email creates the page. Unless `claim: false` is passed, the owner then
 * signs in (claiming the page and the agent) and keeps the page-session cookie,
 * so ordinary page requests carry its account session.
 */
export async function create(body: Record<string, unknown> & { claim?: boolean; listener?: boolean } = {}): Promise<Handle> {
  const { claim = true, listener: _listener, owner, lifetime: _lifetime, ...rest } = body;
  const email = typeof owner === "string" ? owner : `owner-${crypto.randomUUID()}@example.com`;
  const account = crypto.randomUUID();
  const db = env.ACCOUNTS!;
  const now = Date.now();
  if (claim) await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, now, email).run();
  const h = await createPage(await createAgent(email), rest);
  if (claim) {
    const { cookie, session } = await signInAsOwner(h, account, email);
    ownerCookies.set(h.id, cookie);
    h.account = account;
    h.session = session;
  }
  return h;
}

/** Signs `account` in, follows the owner auto-claim, and returns the page-session cookie. */
export async function signInAsOwner(h: Handle, account: string, email: string): Promise<{ cookie: string; session: string }> {
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
  return { cookie, session: `__Host-tendriller=${raw}` };
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

/** The principal the page object builds for a handle's agent from its local grant mirror. */
export function agentPrincipal(t: Tendril, handle: { agent: { id: string } }): AgentPrincipal {
  const grant = localAgentGrant(t, handle.agent.id);
  if (!grant) throw new Error(`agent ${handle.agent.id} has no grant on ${t.tid}`);
  return { kind: "agent", agentId: handle.agent.id, scopes: [...grant.scopes], revision: grant.revision };
}

/** Owner dashboard request with the account's service session (set by `create`). */
export function dashboard(h: Handle, path: string, init: RequestInit = {}): Promise<Response> {
  if (!h.session) throw new Error("dashboard requests need a claimed handle");
  const headers = new Headers(init.headers);
  headers.set("Cookie", h.session);
  if (init.method && init.method !== "GET") headers.set("Origin", BASE);
  return req(path, { ...init, headers, anonymous: true, redirect: "manual" });
}

/** Adds an agent to the handle's account through Dashboard → Your agents → Add agent. */
export async function joinAccountAgent(h: Handle, name: string): Promise<{ token: string; agent: Handle["agent"] }> {
  const issued = await dashboard(h, "/dashboard/agents/join", { method: "POST" });
  if (issued.status !== 201) throw new Error(`join code failed: ${issued.status} ${await issued.text()}`);
  const { code } = await issued.json() as { code: string };
  const res = await req("/api/agents/join", { method: "POST", anonymous: true,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": randomTestIp() },
    body: JSON.stringify({ code, name, publicKey: testPublicKey() }) });
  if (res.status !== 201) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  return await res.json() as { token: string; agent: Handle["agent"] };
}

/** Grants an agent the page with exact scopes through the page object's internal owner route. */
export async function grantAgent(h: Handle, agent: { token: string; agent: Handle["agent"] }, scopes?: string[]): Promise<Handle> {
  const res = await stub(h.id).fetch(new Request("https://tendril.internal/agent-grant/put", { method: "POST",
    headers: { "Content-Type": "application/json", "x-account-id": h.account! },
    body: JSON.stringify({ agentId: agent.agent.id, publicKey: agent.agent.public_key, ...(scopes ? { scopes } : {}) }) }));
  if (!res.ok) throw new Error(`grant failed: ${res.status} ${await res.text()}`);
  return { ...h, token: agent.token, agent: agent.agent };
}

/** Removes one agent's grant through the owner dashboard. */
export async function revokeGrant(h: Handle, agentId: string): Promise<Response> {
  return dashboard(h, `/dashboard/t/${h.id}/agents`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: agentId, granted: false }) });
}
