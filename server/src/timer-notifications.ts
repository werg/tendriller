// A run and its notification intent are committed together. Provider acceptance
// is outside that transaction: retries are at least once, with a stable run tag.
import type { Tendril } from "./tendril";
import type { DurableTimer, TimerDelivery } from "../../contract/index.mjs";
import { serviceMode } from "./service-state";
import { HttpError } from "./http";
import { randomB32 } from "./ids";

type Job = { run_id: string; timer_id: string; payload: string; state: TimerDelivery["state"]; attempts: number; next_at: number;
  attempt_token: string | null; created_at: number; updated_at: number; last_attempt_at: number | null; last_error: string | null;
  pending_devices: string | null; sent_devices: string; failed_devices: string; sent: number; failed: number };
const BACKOFF = [10_000, 60_000, 300_000, 900_000, 3_600_000];
const MAX_ATTEMPTS = BACKOFF.length + 1;
const ATTEMPT_LEASE = 60_000;
const MAX_AGE = 24 * 3_600_000;
const MAX_PENDING = 200;
const ACTIVE = "('pending','sending')";

/** Must be called inside the same SQLite transaction as the timer run/event. */
export function queueTimerNotification(t: Tendril, timer: DurableTimer, runId: string, now: number): void {
  const full = (t.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM timer_notifications WHERE state IN ${ACTIVE}`)?.n ?? 0) >= MAX_PENDING;
  const payload = { title: timer.title, body: "Your scheduled timer is ready.", ...(timer.device ? { device: timer.device } : {}), tag: runId };
  t.db.run(`INSERT OR IGNORE INTO timer_notifications(run_id,timer_id,payload,state,next_at,created_at,updated_at,last_error)
    VALUES(?,?,?,?,?,?,?,?)`, runId, timer.id, JSON.stringify(payload), full ? "failed" : "pending", now, now, now,
    full ? "The notification retry queue is full. The timer event is still available." : null);
}

export function cancelTimerNotifications(t: Tendril, timerId: string | null, reason = "The timer was changed or removed."): void {
  t.db.run(`UPDATE timer_notifications SET state='cancelled',attempt_token=NULL,updated_at=?,last_error=? WHERE state IN ${ACTIVE}` +
    (timerId ? " AND timer_id=?" : ""), t.now(), reason, ...(timerId ? [timerId] : []));
}

export function notificationDelivery(t: Tendril, runId: string): TimerDelivery | null {
  const row = t.db.one<Job>("SELECT * FROM timer_notifications WHERE run_id=?", runId);
  return row ? { state: row.state, attempts: row.attempts, next_attempt_at: row.state === "pending" || row.state === "sending" ? row.next_at : null,
    last_attempt_at: row.last_attempt_at, last_error: row.last_error, sent: row.sent, failed: row.failed } : null;
}

export function nextNotificationDeadline(t: Tendril): number | null {
  if (t.db.get("disabled", false) || !t.db.get("owner_account", null)) return null;
  const next = t.db.one<{ next: number | null }>(`SELECT MIN(next_at) AS next FROM timer_notifications WHERE state IN ${ACTIVE}`)?.next ?? null;
  return next === null ? null : Math.max(next, t.db.get("timer_retry_at", 0));
}

/** Account/service gates are rechecked for every retry, not only when the run fires. */
export async function timerOperationsAllowed(t: Tendril): Promise<boolean> {
  const expires = t.expiresAt();
  if (t.db.get("disabled", false) || !t.db.get("owner_account", null) || (expires !== null && expires <= t.now())) {
    cancelTimerNotifications(t, null, "This page is no longer available for notification delivery."); return false;
  }
  try {
    const [mode, account] = await Promise.all([serviceMode(t.env), t.env.ACCOUNTS.prepare(`SELECT t.state, a.suspended_at, a.deleting_at FROM tendrils t
      JOIN accounts a ON a.id=t.owner_account WHERE t.id=? AND t.owner_account=?`)
      .bind(t.tid, t.db.get("owner_account", null)).first<{ state: string; suspended_at: number | null; deleting_at: number | null }>()]);
    if (!account || account.state === "held" || account.suspended_at !== null || account.deleting_at !== null) {
      t.db.set("disabled", true); t.db.set("disabled_at", t.db.get("disabled_at", t.now()));
      cancelTimerNotifications(t, null, "Delivery stopped because the page or owner account is unavailable."); return false;
    }
    if (mode === "read_only") { t.db.set("timer_retry_at", t.now() + 60_000); return false; }
  } catch {
    t.db.set("timer_retry_at", t.now() + 60_000); return false;
  }
  t.db.del("timer_retry_at"); return true;
}

export function pruneTimerHistory(t: Tendril): void {
  // Pending intents keep their run receipts until they finish; both sets are bounded.
  t.db.run(`DELETE FROM timer_runs WHERE id NOT IN (SELECT id FROM timer_runs ORDER BY fired_at DESC, id DESC LIMIT 200)
    AND id NOT IN (SELECT run_id FROM timer_notifications WHERE state IN ${ACTIVE})`);
  t.db.run("DELETE FROM timer_notifications WHERE run_id NOT IN (SELECT id FROM timer_runs)");
}

function claim(t: Tendril): Job | null {
  return t.transaction(() => {
    const row = t.db.one<Job>(`SELECT * FROM timer_notifications WHERE state IN ${ACTIVE} AND next_at<=? ORDER BY next_at,run_id LIMIT 1`, t.now());
    if (!row) return null;
    const timer = t.db.one<{ state: string; spec: string }>("SELECT state,spec FROM timers WHERE id=?", row.timer_id);
    const expired = row.created_at + MAX_AGE <= t.now();
    if (!timer || timer.state === "cancelled" || !JSON.parse(timer.spec).notify || expired || row.attempts >= MAX_ATTEMPTS) {
      t.db.run("UPDATE timer_notifications SET state=?,attempt_token=NULL,updated_at=?,last_error=? WHERE run_id=?",
        row.attempts >= MAX_ATTEMPTS ? "failed" : "cancelled", t.now(), expired ? "Notification expired after 24 hours." : row.attempts >= MAX_ATTEMPTS ? "Retry limit reached after an interrupted delivery attempt." : "The timer no longer requests notifications.", row.run_id);
      return null;
    }
    const token = randomB32(20), now = t.now();
    // Persist ownership and retry deadline before any network side effect. A
    // crashed worker is reclaimed only after this short attempt lease expires.
    t.db.run("UPDATE timer_notifications SET state='sending',attempts=attempts+1,attempt_token=?,next_at=?,last_attempt_at=?,updated_at=? WHERE run_id=?",
      token, now + ATTEMPT_LEASE, now, now, row.run_id);
    return t.db.one<Job>("SELECT * FROM timer_notifications WHERE run_id=?", row.run_id)!;
  });
}

export async function runTimerNotifications(t: Tendril, limit = 4): Promise<void> {
  const deadline = nextNotificationDeadline(t);
  if (deadline === null || deadline > t.now()) return;
  for (let remaining = Math.min(4, Math.max(0, limit)); remaining > 0; remaining--) {
    if (!await timerOperationsAllowed(t)) break;
    const job = claim(t);
    // A cancelled/expired first row must not starve the remaining ready jobs.
    if (!job) { if ((nextNotificationDeadline(t) ?? Infinity) <= t.now()) continue; break; }
    t.scheduleAlarm();
    let result: Awaited<ReturnType<Tendril["notify"]>> | null = null, error: unknown = null;
    try {
      result = await t.notify(JSON.parse(job.payload), "timer", {
        includeResults: true, broadcastLocal: job.attempts === 1,
        ...(job.pending_devices === null ? {} : { devices: JSON.parse(job.pending_devices) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (caught) { error = caught; }
    t.transaction(() => {
      const current = t.db.one<Job>("SELECT * FROM timer_notifications WHERE run_id=?", job.run_id);
      if (!current || current.state !== "sending" || current.attempt_token !== job.attempt_token) return; // cancelled/reassigned while awaiting
      const sent = new Set<string>(JSON.parse(job.sent_devices)), failed = new Set<string>(JSON.parse(job.failed_devices));
      let pending: string[] | null = job.pending_devices === null ? null : JSON.parse(job.pending_devices);
      let sentCount = job.sent, failedCount = job.failed, retry = false, unavailable = false, detail: string | null = null;
      if (result?.deliveries) {
        const retriable: string[] = [];
        for (const delivery of result.deliveries) {
          if (delivery.ok) { sent.add(delivery.device); failed.delete(delivery.device); }
          else if (!delivery.gone && (delivery.status === 0 || delivery.status === 408 || delivery.status === 425 || delivery.status === 429 || (delivery.status >= 500 && delivery.status !== 501))) retriable.push(delivery.device);
          else failed.add(delivery.device);
        }
        pending = retriable;
        sentCount = sent.size; failedCount = failed.size + pending.length;
        retry = pending.length > 0;
        unavailable = !sentCount && !retry && (!result.deliveries.length || result.deliveries.every(delivery => delivery.gone));
        if (failedCount) detail = `${failedCount} device notification${failedCount === 1 ? "" : "s"} not accepted${retry ? "; retry scheduled" : ""}.`;
      } else if (result) {
        // Keeps notify's existing {sent,failed} contract compatible with hosts
        // that supply their own sender; this fallback cannot isolate devices.
        sentCount += result.sent; failedCount = result.failed; retry = result.failed > 0; unavailable = sentCount === 0 && !retry;
        if (retry) detail = "The notification sender reported a failed delivery.";
      } else {
        detail = (error instanceof Error ? error.message : "Notification delivery failed").slice(0, 1000);
        retry = !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
        failedCount = Math.max(failedCount, 1);
      }
      const now = t.now(), exhausted = job.attempts >= MAX_ATTEMPTS || now >= job.created_at + MAX_AGE;
      const delay = error instanceof HttpError && error.status === 429
        ? (Math.floor(now / 3_600_000) + 1) * 3_600_000 - now + 1 : BACKOFF[job.attempts - 1] ?? BACKOFF.at(-1)!;
      const state: Job["state"] = retry && !exhausted ? "pending" : unavailable ? "unavailable" : failedCount ? "failed" : "sent";
      if (retry && exhausted) detail = `Retry limit reached. ${detail ?? "Delivery could not be confirmed."}`;
      t.db.run(`UPDATE timer_notifications SET state=?,next_at=?,attempt_token=NULL,updated_at=?,last_error=?,pending_devices=?,sent_devices=?,failed_devices=?,sent=?,failed=? WHERE run_id=?`,
        state, Math.min(now + delay, job.created_at + MAX_AGE), now, detail, pending === null ? null : JSON.stringify(pending), JSON.stringify([...sent]), JSON.stringify([...failed]), sentCount, failedCount, job.run_id);
      t.db.run("UPDATE timer_runs SET notification=? WHERE id=?", JSON.stringify(result ? { sent: sentCount, failed: failedCount } : { error: detail }), job.run_id);
    });
  }
  pruneTimerHistory(t); t.scheduleAlarm();
}
