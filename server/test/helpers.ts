// Shared test helpers: API client, page WebSocket client, clock control.
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
  lifetime: string;
  expires_at: number | null;
}

/** Owner page-session cookies by tendril id, filled by `create` and used by `PageClient`. */
const ownerCookies = new Map<string, string>();

function randomTestIp(): string {
  // 198.18.0.0/15 is reserved for benchmarking; a fresh address avoids per-IP creation limits.
  const b = crypto.getRandomValues(new Uint8Array(3));
  return `198.${18 + (b[0] & 1)}.${b[1]}.${b[2]}`;
}

/**
 * Creates a tendril the way the public service does: for an owner email, from a creator IP.
 * Unless `claim: false` is passed, it then signs in as that owner and keeps the page-session
 * cookie, so `PageClient.connect(h.page_url)` connects as the owner without further setup.
 */
export async function create(body: Record<string, unknown> & { claim?: boolean; listener?: boolean } = {}): Promise<Handle> {
  const { claim = true, listener = true, ...rest } = body;
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
  // Publishing needs a wake path; a webhook receiver is the lightest one to fake.
  if (listener) {
    const wake = await api(h, "PUT", "wake", { webhook: { url: "https://example.org/tendriller-test" } });
    if (!wake.ok) throw new Error(`wake setup failed: ${wake.status} ${await wake.text()}`);
  }
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

/** A page speaking the WebSocket protocol directly. */
export class PageClient {
  ws!: WebSocket;
  messages: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  closed: { code: number; reason: string } | null = null;
  welcome: any;
  /** Auto-answer eval messages with this function. */
  onEval: ((code: string, msg: any) => any) | null = null;
  headers: Record<string, string> = {};

  constructor(
    public pageUrl: string,
    public deviceId = "d_" + rb32(16),
    public secret = rb32(32),
  ) {}

  static async connect(pageUrl: string, opts: { deviceId?: string; secret?: string; name?: string; version?: number; rev?: number; headers?: Record<string, string> } = {}): Promise<PageClient> {
    const c = new PageClient(pageUrl, opts.deviceId, opts.secret);
    c.headers = opts.headers ?? ownerHeaders(pageUrl);
    await c.open();
    c.welcome = await c.hello(opts);
    return c;
  }

  async open(): Promise<void> {
    const res = await req(this.pageUrl + "_tendril/ws", { headers: { Upgrade: "websocket", ...this.headers } });
    if (res.status !== 101 || !res.webSocket) throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
    this.ws = res.webSocket;
    this.ws.accept();
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.t === "eval" && this.onEval) {
        Promise.resolve()
          .then(() => this.onEval!(m.code, m))
          .then(
            (value) => this.send({ t: "eval_result", call_id: m.call_id, ok: true, value }),
            (err) => this.send({ t: "eval_result", call_id: m.call_id, ok: false, error: String(err?.message ?? err) }),
          );
      }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(m);
      } else this.messages.push(m);
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
  }

  hello(opts: { name?: string; version?: number; rev?: number } = {}): Promise<any> {
    this.send({ t: "hello", device_id: this.deviceId, device_secret: this.secret, name: opts.name ?? "Test device", ua: "vitest", version: opts.version ?? 0, rev: opts.rev ?? 0, caps: {} });
    return this.next((m) => m.t === "welcome" || m.t === "error");
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Resolves with the next message (already queued or future) matching `pred` (a type string or predicate). */
  next(pred: string | ((m: any) => boolean), timeoutMs = 3000): Promise<any> {
    const p = typeof pred === "string" ? (m: any) => m.t === pred : pred;
    const i = this.messages.findIndex(p);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred: p, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) {
          this.waiters.splice(j, 1);
          reject(new Error(`timed out waiting for message (${typeof pred === "string" ? pred : "predicate"}); have: ${JSON.stringify(this.messages.map((m) => m.t))}`));
        }
      }, timeoutMs);
    });
  }

  /** Sends a request with a cid and waits for the reply carrying that cid. */
  async request(m: Record<string, unknown>, timeoutMs = 3000): Promise<any> {
    const cid = "c" + rb32(10);
    this.send({ ...m, cid });
    return this.next((x) => x.cid === cid, timeoutMs);
  }

  drain(): any[] {
    const m = this.messages;
    this.messages = [];
    return m;
  }

  close(): void {
    try {
      this.ws.close(1000, "done");
    } catch {
      /* ignore */
    }
  }
}
