// MCP Events push (PROTOCOL section 13.2): webhook subscriptions made through the MCP
// connector, signed with Standard Webhooks, delivered on the same wake path as the
// plain webhook. A delivery carries a count, never event content (section 8.1).
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { HttpError } from "./http";
import { fromBase64, randomB32, toBase64 } from "./ids";
import { DAY, HOUR, WEBHOOK_BACKOFF, WEBHOOK_DEBOUNCE, WEBHOOK_TIMEOUT } from "./limits";

export const MCP_EVENT_NAME = "tendril.events_waiting";
export const MCP_SUB_DEFAULT_TTL = DAY;
export const MCP_SUB_MAX_TTL = 7 * DAY;
export const MCP_SUB_MIN_TTL = HOUR;
export const MAX_MCP_SUBS = 10;

export interface McpSub {
  id: string;
  name: string;
  /** Canonical JSON of the subscription arguments. */
  args: string;
  url: string;
  secret: string;
  expires: number;
}

interface McpJob {
  due: number;
  attempt: number;
  seq: number;
  /** Subscriptions still owed this delivery. */
  pending: string[];
}

export const MCP_EVENT_DEFINITION = {
  name: MCP_EVENT_NAME,
  description:
    "Events are waiting on this tendril: a person tapped, spoke or typed on its page, a page reported data, or an update failed. Read them with the read_events tool.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: {
    type: "object",
    properties: {
      tendril_id: { type: "string" },
      name: { type: "string" },
      waiting: { type: "integer", description: "Events after the last read" },
      text: { type: "string" },
    },
    required: ["tendril_id", "name", "waiting", "text"],
    additionalProperties: false,
  },
};

/** Live subscriptions (expired ones are ignored and pruned by cleanup). */
export function mcpSubs(t: Tendril): McpSub[] {
  const now = t.now();
  return t.db.get<McpSub[]>("mcp_subs", []).filter((s) => s.expires > now);
}

export function saveMcpSubs(t: Tendril, subs: McpSub[]): void {
  if (subs.length) t.db.set("mcp_subs", subs);
  else t.db.del("mcp_subs");
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** `whsec_` + base64 of 24–64 bytes, as the MCP Events contract requires. */
export function validSecret(secret: unknown): secret is string {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return false;
  try {
    const n = fromBase64(secret.slice(6)).length;
    return n >= 24 && n <= 64;
  } catch {
    return false;
  }
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** HTTPS to a public host only (http://localhost is allowed when the server itself runs on localhost). */
export function callbackUrlProblem(raw: unknown, devLocal: boolean): string | null {
  if (typeof raw !== "string") return "delivery.url must be a string";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "delivery.url is not a URL";
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".localhost");
  if (devLocal && local && (u.protocol === "http:" || u.protocol === "https:")) return null;
  if (u.protocol !== "https:") return "delivery.url must use https";
  if (u.username || u.password) return "delivery.url must not carry credentials";
  if (local || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !host.includes(":"))
    return "delivery.url must be a public host";
  if (PRIVATE_V4.some((re) => re.test(host))) return "delivery.url must be a public address";
  if (host.includes(":") && (host === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith("::ffff:")))
    return "delivery.url must be a public address";
  return null;
}

/** Standard Webhooks headers: HMAC-SHA256 over `${id}.${timestamp}.${body}`. */
export async function signedHeaders(secret: string, id: string, body: string, timestampS: number): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey("raw", fromBase64(secret.slice(6)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestampS}.${body}`));
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestampS),
    "webhook-signature": `v1,${toBase64(mac)}`,
  };
}

async function post(t: Tendril, sub: McpSub, id: string, body: string): Promise<Response> {
  const headers = await signedHeaders(sub.secret, id, body, Math.floor(t.now() / 1000));
  headers["X-MCP-Subscription-Id"] = sub.id;
  return fetch(sub.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(WEBHOOK_TIMEOUT) });
}

/** Sends the verification challenge; the receiver must answer 2xx echoing it. */
export async function verifyCallback(t: Tendril, sub: McpSub): Promise<"ok" | "challenge_failed" | "timeout"> {
  const challenge = randomB32(32);
  let res: Response;
  try {
    res = await post(t, sub, `msg_verification_${randomB32(16)}`, JSON.stringify({ type: "verification", challenge }));
  } catch (err) {
    return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "challenge_failed";
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return "challenge_failed";
  }
  const text = (await res.text()).trim();
  let echoed = text;
  try {
    const parsed = JSON.parse(text);
    echoed = typeof parsed === "string" ? parsed : typeof parsed?.challenge === "string" ? parsed.challenge : "";
  } catch {
    /* plain-text echo */
  }
  return timingSafeEqualStr(echoed, challenge) ? "ok" : "challenge_failed";
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newSubId(): string {
  return `sub_${randomB32(20)}`;
}

/** Called on a delivered wake when no long-poll is held: owe every live subscription a delivery. */
export function queueMcpWake(t: Tendril, seq: number): void {
  const ids = mcpSubs(t).map((s) => s.id);
  if (!ids.length) return;
  const job = t.db.get<McpJob | null>("mcp_job", null);
  if (job) {
    job.seq = Math.max(job.seq, seq);
    job.pending = [...new Set([...job.pending, ...ids])];
    t.db.set("mcp_job", job);
    return;
  }
  t.db.set("mcp_job", { due: t.now() + WEBHOOK_DEBOUNCE, attempt: 0, seq, pending: ids } satisfies McpJob);
  t.scheduleAlarm();
}

export function mcpJobDue(t: Tendril): number | null {
  return t.db.get<McpJob | null>("mcp_job", null)?.due ?? null;
}

/** Called from the alarm: delivers a due MCP event to each pending subscription, with backoff. */
export async function runMcpEvents(t: Tendril): Promise<void> {
  const job = t.db.get<McpJob | null>("mcp_job", null);
  if (!job || job.due > t.now()) return;
  const cursor = t.db.get<number>("agent_cursor", 0);
  const subs = mcpSubs(t).filter((s) => job.pending.includes(s.id));
  if (cursor >= job.seq || subs.length === 0) {
    t.db.del("mcp_job");
    return;
  }
  const waiting = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE seq > ?", cursor)?.n ?? 0;
  const name = t.db.get<string>("name", "Tendril");
  const eventId = `evt_${t.tid}_${job.seq}`;
  const body = JSON.stringify({
    eventId,
    name: MCP_EVENT_NAME,
    timestamp: new Date(t.now()).toISOString(),
    data: {
      tendril_id: t.tid,
      name,
      waiting,
      text: `${waiting} event${waiting === 1 ? " is" : "s are"} waiting on the tendril "${name}". Read them with the read_events tool.`,
    },
    cursor: null,
  });
  const failed: string[] = [];
  const gone: string[] = [];
  let delivered = false;
  let detail = "";
  for (const sub of subs) {
    try {
      const res = await post(t, sub, eventId, body);
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) delivered = true;
      else if (res.status === 410) gone.push(sub.id);
      else if (res.status !== 413) {
        failed.push(sub.id);
        detail = `HTTP ${res.status}`;
      }
    } catch (err) {
      failed.push(sub.id);
      detail = err instanceof Error ? err.message : String(err);
    }
  }
  if (gone.length) saveMcpSubs(t, t.db.get<McpSub[]>("mcp_subs", []).filter((s) => !gone.includes(s.id)));
  if (delivered && t.db.get<number | null>("wake_pending_since", null) === null) t.db.set("wake_pending_since", t.now());

  // The job may have grown while we were sending; keep what was added.
  const cur = t.db.get<McpJob | null>("mcp_job", null) ?? job;
  const added = cur.pending.filter((id) => !job.pending.includes(id));
  const seq = Math.max(cur.seq, job.seq);
  if (failed.length === 0) {
    t.db.del("mcp_job");
    if (seq > job.seq || added.length) {
      const ids = mcpSubs(t).map((s) => s.id);
      if (ids.length) t.db.set("mcp_job", { due: t.now() + WEBHOOK_DEBOUNCE, attempt: 0, seq, pending: ids } satisfies McpJob);
    }
  } else {
    const attempt = job.attempt + 1;
    if (attempt > WEBHOOK_BACKOFF.length) {
      t.db.del("mcp_job");
      addActivity(t, { kind: "webhook_failed", summary: `MCP event delivery failed after ${attempt} attempts (${detail})` });
    } else {
      t.db.set("mcp_job", {
        due: t.now() + WEBHOOK_BACKOFF[attempt - 1],
        attempt,
        seq,
        pending: [...new Set([...failed, ...added])],
      } satisfies McpJob);
    }
  }
  t.refreshPresence();
}

export function pruneMcpSubs(t: Tendril): void {
  const all = t.db.get<McpSub[]>("mcp_subs", []);
  const live = mcpSubs(t);
  if (live.length !== all.length) saveMcpSubs(t, live);
}

export function requireSubsRoom(t: Tendril, replacing: boolean): void {
  if (!replacing && mcpSubs(t).length >= MAX_MCP_SUBS)
    throw new HttpError(409, "too_many_subscriptions", `At most ${MAX_MCP_SUBS} event subscriptions per tendril`);
}
