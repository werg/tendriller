// Events, wake budget, long-poll and webhook delivery (PROTOCOL section 8).
import type { Tendril } from "./tendril";
import { addActivity, bumpAggregate } from "./activity";
import { json } from "./http";
import {
  EVENT_RETENTION, HOUR, LONGPOLL_DEBOUNCE, MAX_EVENTS, WAKE_MERGE_WINDOW, WEBHOOK_BACKOFF, WEBHOOK_DEBOUNCE,
  WEBHOOK_TIMEOUT,
} from "./limits";
import { apiUrl } from "./urls";
import { queueMcpWake } from "./mcpEvents";

export type EventType = "event" | "instruction" | "version_failed" | "version_healthy" | "device" | "rule" | "voice";
export type WakeClass = "owner" | "page";

export interface NewEvent {
  type: EventType;
  data: unknown;
  device?: string | null;
  role?: string | null;
  /** Requested wake (the sender's `wake` flag). Only effective with a wake class. */
  wake: boolean;
  cls?: WakeClass | null;
  /** Bypasses the page-wake cap (version_failed: once per version). */
  force?: boolean;
  /**
   * A person caused this event: an owner instruction, or a page event sent during a real user
   * gesture on an owner device (browser user activation, which page code cannot fake). It always
   * wakes and resets the consecutive page-wake streak.
   */
  human?: boolean;
  by?: string | null;
}

export interface StoredEvent {
  seq: number;
  ts: number;
  type: EventType;
  data: unknown;
  device: string | null;
  role: string | null;
  wake: boolean;
  withheld: boolean;
  by: string | null;
}

interface WakeBoundState {
  /** Page-started wakes delivered since the last human input. */
  streak: number;
  /** Time of the last delivered wake per class, for merging bursts. */
  last: Record<WakeClass, number | null>;
}

export interface WebhookJob {
  due: number;
  attempt: number;
  seq: number;
}

export interface Waiter {
  after: number;
  limit: number;
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function renderEvent(r: Record<string, any>): StoredEvent {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    data: r.data === null || r.data === undefined ? null : JSON.parse(r.data),
    device: r.device ?? null,
    role: r.role ?? null,
    wake: !!r.wake,
    withheld: !!r.withheld,
    by: r.by ?? null,
  };
}

/**
 * Decides whether a wake-eligible event wakes, merges into the previous wake, or is withheld.
 *
 * Owner wakes are never withheld. Page-started wakes are bounded by count, not by a clock: at most
 * `budget.page_streak` consecutive page wakes may be delivered without a person in between. Any
 * human input (owner instruction, or a page event sent during a real owner gesture) resets the
 * streak. This bounds a page that loops on its own without ever throttling a person.
 */
function wakeDecide(t: Tendril, e: NewEvent): "wake" | "merged" | "withheld" {
  const cls = e.cls!;
  const now = t.now();
  const st = t.db.get<WakeBoundState>("wake_bound", { streak: 0, last: { owner: null, page: null } });
  let decision: "wake" | "merged" | "withheld";
  if (cls === "owner" || e.human) {
    st.streak = 0;
    decision = st.last[cls] !== null && now - st.last[cls]! < WAKE_MERGE_WINDOW ? "merged" : "wake";
  } else if (e.force) {
    decision = "wake";
  } else if (st.last.page !== null && now - st.last.page < WAKE_MERGE_WINDOW) {
    decision = "merged";
  } else if (st.streak < t.wakeConfig().budget.page_streak) {
    st.streak += 1;
    decision = "wake";
  } else decision = "withheld";
  if (decision === "wake") st.last[cls] = now;
  t.db.set("wake_bound", st);
  return decision;
}

/** Page-started wakes delivered since the last human input. */
export function pageStreak(t: Tendril): number {
  return t.db.get<WakeBoundState>("wake_bound", { streak: 0, last: { owner: null, page: null } }).streak;
}

export function addEvent(t: Tendril, e: NewEvent): StoredEvent {
  let wake = false;
  let withheld = false;
  let decision: "wake" | "merged" | "withheld" | null = null;
  if (e.wake && e.cls) {
    decision = wakeDecide(t, e);
    wake = decision !== "withheld";
    withheld = decision === "withheld";
  }
  const ts = t.now();
  const row = t.db.one<{ seq: number }>(
    "INSERT INTO events (ts, type, data, device, role, wake, withheld, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
    ts, e.type, JSON.stringify(e.data ?? null), e.device ?? null, e.role ?? null, wake, withheld, e.by ?? null,
  );
  const seq = row!.seq;
  if (seq % 100 === 0) pruneEvents(t);

  if (withheld && e.cls) {
    t.db.set("withheld", t.db.get<number>("withheld", 0) + 1);
    const cls = e.cls;
    const openKey = `withheld_agg_${cls}`;
    let key = t.db.get<string | null>(openKey, null);
    if (!key) {
      key = `withheld:${cls}:${seq}`;
      t.db.set(openKey, key);
    }
    bumpAggregate(t, key, "wake_withheld", null, { n: 1 }, (tot) =>
      `${tot.n} page wake${tot.n === 1 ? "" : "s"} withheld (the page woke the agent ${t.wakeConfig().budget.page_streak} times in a row without you); the agent sees them at its next check`);
    t.refreshPresence();
  }
  if (decision === "wake") {
    t.db.del(`withheld_agg_${e.cls}`);
    addActivity(t, { kind: "wake", summary: `Agent woken (${e.cls === "owner" ? "instruction" : e.type})` });
  }
  if (wake) deliverWake(t, seq);
  return { seq, ts, type: e.type, data: e.data ?? null, device: e.device ?? null, role: e.role ?? null, wake, withheld, by: e.by ?? null };
}

/** Delivery path 1 (held long-polls) or 2 (webhook and MCP Events). Never affects storage of the event. */
function deliverWake(t: Tendril, seq: number): void {
  if (t.waiters.size > 0) {
    scheduleRelease(t);
    return;
  }
  const hook = t.wakeConfig().webhook;
  if (hook) {
    const job = t.db.get<WebhookJob | null>("webhook_job", null);
    if (job) {
      job.seq = Math.max(job.seq, seq);
      t.db.set("webhook_job", job);
    } else {
      t.db.set("webhook_job", { due: t.now() + WEBHOOK_DEBOUNCE, attempt: 0, seq } satisfies WebhookJob);
      t.scheduleAlarm();
    }
  }
  queueMcpWake(t, seq);
}

function scheduleRelease(t: Tendril): void {
  if (t.releaseTimer) return;
  t.releaseTimer = setTimeout(() => {
    t.releaseTimer = null;
    releaseWaiters(t);
  }, LONGPOLL_DEBOUNCE);
}

function releaseWaiters(t: Tendril): void {
  if (t.waiters.size === 0) return;
  let delivered = false;
  for (const w of [...t.waiters]) {
    if (!hasWakeAfter(t, w.after)) continue;
    t.waiters.delete(w);
    clearTimeout(w.timer);
    w.resolve(json(readEvents(t, w.after, w.limit)));
    delivered = true;
  }
  if (delivered && t.db.get<number | null>("wake_pending_since", null) === null) t.db.set("wake_pending_since", t.now());
  t.refreshPresence();
  t.scheduleAlarm();
}

export function hasWakeAfter(t: Tendril, after: number): boolean {
  return !!t.db.one("SELECT 1 AS x FROM events WHERE wake = 1 AND seq > ? LIMIT 1", after);
}

function withheldTotal(t: Tendril): number {
  return t.db.get<number>("withheld", 0);
}

/** Returns events after `after`; reports and resets the withheld counters; advances the agent cursor. */
export function readEvents(t: Tendril, after: number, limit: number): { events: StoredEvent[]; cursor: number; withheld: number } {
  const events = t.db.all("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?", after, limit).map(renderEvent);
  const cursor = events.length ? events[events.length - 1].seq : after;
  const withheld = withheldTotal(t);
  if (withheld > 0) {
    t.db.set("withheld", 0);
    t.refreshPresence();
  }
  if (cursor > t.db.get<number>("agent_cursor", 0)) t.db.set("agent_cursor", cursor);
  return { events, cursor, withheld };
}

export function getEvents(t: Tendril, url: URL, signal: AbortSignal | undefined, after: number, wait: number, limit: number): Promise<Response> | Response {
  if (wait > 0) t.db.del("status_override"); // "until the next long-poll"
  if (wait === 0 || hasWakeAfter(t, after)) return json(readEvents(t, after, limit));
  return new Promise<Response>((resolve) => {
    const w: Waiter = {
      after,
      limit,
      resolve,
      timer: setTimeout(() => {
        t.waiters.delete(w);
        resolve(json({ events: [], cursor: after, timeout: true, withheld: withheldTotal(t) }));
        t.refreshPresence();
      }, wait * 1000),
    };
    t.waiters.add(w);
    signal?.addEventListener("abort", () => {
      if (!t.waiters.has(w)) return;
      t.waiters.delete(w);
      clearTimeout(w.timer);
      resolve(json({ events: [], cursor: after, timeout: true, withheld: withheldTotal(t) }));
      t.refreshPresence();
    });
    t.refreshPresence();
  });
}

/** Called from the alarm: sends a due webhook, with retries and backoff. */
export async function runWebhook(t: Tendril): Promise<void> {
  const job = t.db.get<WebhookJob | null>("webhook_job", null);
  if (!job || job.due > t.now()) return;
  const hook = t.wakeConfig().webhook;
  const cursor = t.db.get<number>("agent_cursor", 0);
  if (!hook || cursor >= job.seq) {
    t.db.del("webhook_job");
    return;
  }
  const waiting = (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE seq > ?", cursor)?.n) ?? 0;
  const A = apiUrl(t.env, t.tid);
  const body = {
    source: "tendriller",
    tendril: t.tid,
    waiting,
    text: `${waiting} tendril event(s) waiting on ${t.db.get("name", "Tendril")}. Read them with GET ${A}/events?after=${cursor}`,
    events_url: `${A}/events`,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hook.token) headers.Authorization = `Bearer ${hook.token}`;
  let ok = false;
  let detail = "";
  try {
    const res = await fetch(hook.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(WEBHOOK_TIMEOUT) });
    ok = res.ok;
    detail = `HTTP ${res.status}`;
    await res.body?.cancel();
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  // The job may have been replaced while awaiting; only touch it if it is still ours.
  const cur = t.db.get<WebhookJob | null>("webhook_job", null);
  const extraSeq = cur ? Math.max(cur.seq, job.seq) : job.seq;
  if (ok) {
    t.db.del("webhook_job");
    if (t.db.get<number | null>("wake_pending_since", null) === null) t.db.set("wake_pending_since", t.now());
    if (extraSeq > job.seq) t.db.set("webhook_job", { due: t.now() + WEBHOOK_DEBOUNCE, attempt: 0, seq: extraSeq });
    t.refreshPresence();
    return;
  }
  const attempt = job.attempt + 1;
  if (attempt > WEBHOOK_BACKOFF.length) {
    t.db.del("webhook_job");
    addActivity(t, { kind: "webhook_failed", summary: `Webhook delivery failed after ${attempt} attempts (${detail})` });
    return;
  }
  t.db.set("webhook_job", { due: t.now() + WEBHOOK_BACKOFF[attempt - 1], attempt, seq: extraSeq });
}

export function pruneEvents(t: Tendril): void {
  t.db.run("DELETE FROM events WHERE ts < ?", t.now() - EVENT_RETENTION);
  const row = t.db.one<{ seq: number }>("SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?", MAX_EVENTS);
  if (row) t.db.run("DELETE FROM events WHERE seq <= ?", row.seq);
}
