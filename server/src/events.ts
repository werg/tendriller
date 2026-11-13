// Events, wake budget, long-poll and webhook delivery (PROTOCOL section 8).
import type { Tendril } from "./tendril";
import { addActivity, bumpAggregate } from "./activity";
import { json } from "./http";
import {
  EVENT_RETENTION, HOUR, LONGPOLL_DEBOUNCE, MAX_EVENTS, WAKE_MERGE_WINDOW, WEBHOOK_BACKOFF, WEBHOOK_DEBOUNCE,
  WEBHOOK_TIMEOUT,
} from "./limits";
import { apiUrl } from "./urls";

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
  /** Bypasses budget (version_failed: once per version). */
  force?: boolean;
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

interface BudgetClassState {
  times: number[];
  last: number | null;
}
type BudgetState = Record<WakeClass, BudgetClassState>;

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

/** Decides whether a wake-eligible event wakes, merges into the previous wake, or is withheld. */
function budgetDecide(t: Tendril, cls: WakeClass, force: boolean): "wake" | "merged" | "withheld" {
  const now = t.now();
  const st = t.db.get<BudgetState>("budget_state", { owner: { times: [], last: null }, page: { times: [], last: null } });
  const c = st[cls];
  c.times = c.times.filter((x) => x > now - HOUR);
  let decision: "wake" | "merged" | "withheld";
  if (c.last !== null && now - c.last < WAKE_MERGE_WINDOW) decision = "merged";
  else if (force || c.times.length < t.wakeConfig().budget[`${cls}_per_hour`]) {
    c.times.push(now);
    c.last = now;
    decision = "wake";
  } else decision = "withheld";
  t.db.set("budget_state", st);
  return decision;
}

export function addEvent(t: Tendril, e: NewEvent): StoredEvent {
  let wake = false;
  let withheld = false;
  let decision: "wake" | "merged" | "withheld" | null = null;
  if (e.wake && e.cls) {
    decision = budgetDecide(t, e.cls, !!e.force);
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
    const w = t.db.get<Record<WakeClass, number>>("withheld", { owner: 0, page: 0 });
    w[e.cls] += 1;
    t.db.set("withheld", w);
    const cls = e.cls;
    const openKey = `withheld_agg_${cls}`;
    let key = t.db.get<string | null>(openKey, null);
    if (!key) {
      key = `withheld:${cls}:${seq}`;
      t.db.set(openKey, key);
    }
    bumpAggregate(t, key, "wake_withheld", null, { n: 1 }, (tot) =>
      `${tot.n} ${cls === "owner" ? "instruction" : "page"} wake${tot.n === 1 ? "" : "s"} withheld (over budget); the agent sees them at its next check`);
    t.refreshPresence();
  }
  if (decision === "wake") {
    t.db.del(`withheld_agg_${e.cls}`);
    addActivity(t, { kind: "wake", summary: `Agent woken (${e.cls === "owner" ? "instruction" : e.type})` });
  }
  if (wake) deliverWake(t, seq);
  return { seq, ts, type: e.type, data: e.data ?? null, device: e.device ?? null, role: e.role ?? null, wake, withheld, by: e.by ?? null };
}

/** Delivery path 1 (held long-polls) or 2 (webhook). Never affects storage of the event. */
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
  const w = t.db.get<Record<WakeClass, number>>("withheld", { owner: 0, page: 0 });
  return w.owner + w.page;
}

/** Returns events after `after`; reports and resets the withheld counters; advances the agent cursor. */
export function readEvents(t: Tendril, after: number, limit: number): { events: StoredEvent[]; cursor: number; withheld: number } {
  const events = t.db.all("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?", after, limit).map(renderEvent);
  const cursor = events.length ? events[events.length - 1].seq : after;
  const withheld = withheldTotal(t);
  if (withheld > 0) {
    t.db.set("withheld", { owner: 0, page: 0 });
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
