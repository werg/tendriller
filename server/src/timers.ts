import type { Tendril } from "./tendril";
import { addEvent } from "./events";
import { addActivity } from "./activity";
import { HttpError, isPlainObject } from "./http";
import { mutateDecision } from "./scopes";
import { cancelTimerNotifications, notificationDelivery, pruneTimerHistory, queueTimerNotification, runTimerNotifications, timerOperationsAllowed } from "./timer-notifications";
import { assertValid, type TimerRepeat, type DurableTimer, type TimerRun, type TimerWrite, type TimerDeleted } from "../../contract/index.mjs";
export type { TimerRepeat, DurableTimer, TimerRun } from "../../contract/index.mjs";
type TimerRow = { id: string; spec: string; next_at: number; state: string };
const MAX_TIMERS = 32;
const LATE_GRACE = 120_000;
const REJECTED_TIMER_DECISIONS = new Set(["quota", "lifetime_required", "unclaimed", "timer_conflict", "not_found", "already_fired", "bad_request"]);

function zoned(at: number, zone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}
function wall(p: Record<string, number>): number { return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }

/** Calendar recurrence in an IANA zone. Nonexistent DST times are skipped; repeated times fire once per date. */
export function nextDaily(after: number, repeat: { at: string; days?: number[] }, zone: string): number {
  const start = zoned(after, zone);
  const [hour, minute] = repeat.at.split(":").map(Number);
  const midnight = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(midnight + i * 86400000);
    if (repeat.days && !repeat.days.includes(date.getUTCDay())) continue;
    const wanted = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
    const offsets = new Set([-86400000, 0, 86400000].map(d => wall(zoned(wanted + d, zone)) - (wanted + d)));
    const matches = [...offsets].map(offset => wanted - offset).filter(candidate => wall(zoned(candidate, zone)) === wanted).sort((a, b) => a - b);
    // Choose the first occurrence of a repeated wall time, even if it is already past.
    if (matches[0] > after) return matches[0];
  }
  throw new HttpError(400, "bad_request", "No next calendar occurrence");
}

export function listTimers(t: Tendril): DurableTimer[] {
  return t.db.all<TimerRow>("SELECT * FROM timers ORDER BY next_at, id").map(r => JSON.parse(r.spec));
}
export function timerHistory(t: Tendril): TimerRun[] {
  return t.db.all<TimerRun>("SELECT * FROM timer_runs ORDER BY fired_at DESC, id DESC LIMIT 100")
    .map(run => ({ ...run, delivery: notificationDelivery(t, run.id) }));
}
function requireClaim(t: Tendril) {
  if (!t.db.get("owner_account", null)) throw new HttpError(403, "unclaimed", "Open the page as its owner before scheduling a timer");
}

function reviewedTimer(t: Tendril, id: string, expectedRevision: number): DurableTimer {
  const row = t.db.one<TimerRow>("SELECT * FROM timers WHERE id=?", id);
  if (!row) throw new HttpError(404, "not_found", "No such timer");
  const current: DurableTimer = JSON.parse(row.spec);
  if (current.revision !== expectedRevision)
    throw new HttpError(409, "timer_conflict", "Timer changed; review its current revision", { current: current.revision });
  return current;
}

/** Timers share the platform command receipt and generation transaction. */
export function saveTimer(t: Tendril, body: unknown, actor: string, id?: string, by = actor): DurableTimer {
  const command = id ? assertValid("timerWrite", body) : assertValid("timerCreate", body);
  return mutateDecision(t, actor, command, { operations: ["timer.write"] }, { operation: id ? "update" : "create", id: id ?? null, command }, () => {
    requireClaim(t);
    const previous = id ? reviewedTimer(t, id, (command as TimerWrite).expected_revision) : undefined;
    if (!id && listTimers(t).length >= MAX_TIMERS)
      throw new HttpError(429, "quota", "Remove an old timer before adding another (32 maximum)");
    return writeTimer(t, command, by, previous);
  }, REJECTED_TIMER_DECISIONS);
}

function writeTimer(t: Tendril, body: Record<string, unknown>, by: string, previous?: DurableTimer): DurableTimer {
  const input: Record<string, any> = { ...previous, ...body };
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) throw new HttpError(400, "bad_request", "title must be 1–200 characters");
  const timezone = input.timezone ?? "UTC";
  if (typeof timezone !== "string" || timezone.length > 100) throw new HttpError(400, "bad_request", "Invalid timezone");
  try { zoned(t.now(), timezone); } catch { throw new HttpError(400, "bad_request", "timezone must be an IANA time zone"); }
  let repeat: TimerRepeat | undefined;
  if (input.repeat != null) {
    if (!isPlainObject(input.repeat)) throw new HttpError(400, "bad_request", "Invalid repeat schedule");
    if (Object.hasOwn(input.repeat, "every_minutes")) {
      const n = input.repeat.every_minutes;
      if (!Number.isInteger(n) || n < 1 || n > 525600) throw new HttpError(400, "bad_request", "every_minutes must be 1–525600");
      repeat = { every_minutes: n };
    } else {
      if (typeof input.repeat.at !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.repeat.at)) throw new HttpError(400, "bad_request", "repeat.at must be HH:MM");
      const days = input.repeat.days;
      if (days !== undefined && (!Array.isArray(days) || !days.length || days.length > 7 || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)))
        throw new HttpError(400, "bad_request", "days must contain weekday numbers 0–6");
      repeat = { at: input.repeat.at, ...(days ? { days: [...new Set<number>(days)] } : {}) };
    }
  }
  const due = input.due_at ?? (repeat && "at" in repeat ? nextDaily(t.now(), repeat, timezone) : undefined);
  if (typeof due !== "number" || !Number.isSafeInteger(due) || due < 0 || due > 8640000000000000) throw new HttpError(400, "bad_request", "due_at must be epoch milliseconds");
  const expires = t.expiresAt();
  if ((input.state ?? "scheduled") === "scheduled" && expires !== null && due >= expires)
    throw new HttpError(409, "lifetime_required", "Make this tendril resident before scheduling beyond its current lifetime", { expires_at: expires });
  if (!["fire_once", "skip"].includes(input.missed ?? "fire_once")) throw new HttpError(400, "bad_request", "missed must be fire_once or skip");
  if (input.device !== undefined && input.device !== null && (typeof input.device !== "string" || !t.device(input.device))) throw new HttpError(400, "bad_request", "Unknown target device");
  if (input.notify !== undefined && typeof input.notify !== "boolean") throw new HttpError(400, "bad_request", "notify must be boolean");
  if (input.state !== undefined && !["scheduled", "cancelled", "completed"].includes(input.state)) throw new HttpError(400, "bad_request", "Invalid timer state");
  if (previous && (input.state ?? "scheduled") === "scheduled" && t.db.one("SELECT id FROM timer_runs WHERE id=?", `${previous.id}:${due}`))
    throw new HttpError(409, "already_fired", "Choose a new first run time to restart this timer");
  const now = t.now();
  const timer: DurableTimer = { id: previous?.id ?? crypto.randomUUID(), revision: (previous?.revision ?? 0) + 1, title: input.title.trim(), due_at: due, timezone,
    ...(repeat ? { repeat } : {}), missed: input.missed ?? "fire_once", ...(input.device ? { device: input.device } : {}), notify: input.notify === true,
    state: input.state ?? "scheduled", created_at: previous?.created_at ?? now, updated_at: now };
  t.db.run("INSERT INTO timers (id, spec, next_at, state) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec, next_at=excluded.next_at, state=excluded.state",
    timer.id, JSON.stringify(timer), timer.due_at, timer.state);
  if (previous) cancelTimerNotifications(t, timer.id);
  addActivity(t, { kind: "timer", summary: `${previous ? "Updated" : "Scheduled"} timer: ${timer.title}`, by });
  t.scheduleAlarm();
  return timer;
}

export function deleteTimer(t: Tendril, id: string, body: unknown, actor: string, by = actor): TimerDeleted {
  const command = assertValid("timerDelete", body);
  return mutateDecision(t, actor, command, { operations: ["timer.write"] }, { operation: "delete", id, command }, () => {
    requireClaim(t);
    const previous = reviewedTimer(t, id, command.expected_revision);
    cancelTimerNotifications(t, id);
    t.db.run("DELETE FROM timers WHERE id = ?", id);
    addActivity(t, { kind: "timer", summary: "Timer removed", by });
    t.scheduleAlarm();
    return { id, revision: previous.revision + 1, deleted: true };
  }, REJECTED_TIMER_DECISIONS);
}
export function nextTimerDeadline(t: Tendril): number | null {
  if (t.db.get("disabled", false) || !t.db.get("owner_account", null)) return null;
  const next = t.db.one<{ next: number | null }>("SELECT MIN(next_at) AS next FROM timers WHERE state = 'scheduled'")?.next ?? null;
  return next === null ? null : Math.max(next, t.db.get("timer_retry_at", 0));
}

export async function runTimers(t: Tendril): Promise<void> {
  const due = nextTimerDeadline(t), expires = t.expiresAt();
  if (due === null || due > t.now() || (expires !== null && expires <= t.now())) return;
  if (!await timerOperationsAllowed(t)) return;
  const rows = t.db.all<TimerRow>("SELECT * FROM timers WHERE state='scheduled' AND next_at <= ? ORDER BY next_at LIMIT 32", t.now());
  let notificationBudget = 4;
  for (const candidate of rows) {
    let timer: DurableTimer | null = null;
    let runId = "", skip = false, created = false;
    t.transaction(() => {
      // A previous timer's notification can yield to an owner editing a later
      // timer. The candidate list is only a hint; claim its current schedule.
      const now = t.now();
      const row = t.db.one<TimerRow>("SELECT * FROM timers WHERE id=?", candidate.id);
      if (!row || row.state !== "scheduled" || row.next_at > now || t.db.get("disabled", false)) return;
      timer = JSON.parse(row.spec) as DurableTimer;
      runId = `${timer.id}:${timer.due_at}`;
      skip = timer.missed === "skip" && now - timer.due_at > LATE_GRACE;
      created = !t.db.one("SELECT id FROM timer_runs WHERE id=?", runId);
      if (created) {
        const event = skip ? null : addEvent(t, { type: "event", data: { type: "timer", timer_id: timer.id, run_id: runId,
          title: timer.title, scheduled_at: timer.due_at, fired_at: now, timezone: timer.timezone }, device: timer.device ?? null,
          role: null, by: "timer", wake: true, cls: "page" });
        t.db.run("INSERT INTO timer_runs (id, timer_id, scheduled_at, fired_at, status, event_seq) VALUES (?, ?, ?, ?, ?, ?)",
          runId, timer.id, timer.due_at, now, skip ? "skipped" : "fired", event?.seq ?? null);
        if (!skip && timer.notify) queueTimerNotification(t, timer, runId, now);
      }
      if (timer.repeat) {
        timer.due_at = "every_minutes" in timer.repeat
          ? timer.due_at + (Math.floor((now - timer.due_at) / (timer.repeat.every_minutes * 60000)) + 1) * timer.repeat.every_minutes * 60000
          : nextDaily(now, timer.repeat, timer.timezone);
      } else timer.state = "completed";
      timer.revision++;
      timer.updated_at = now;
      t.db.run("UPDATE timers SET spec=?, next_at=?, state=? WHERE id=?", JSON.stringify(timer), timer.due_at, timer.state, timer.id);
      if (created) addActivity(t, { kind: "timer", summary: `${skip ? "Skipped missed" : "Fired"} timer: ${timer.title}`, by: "timer", device: timer.device ?? null });
    });
    t.scheduleAlarm();
    if (created && !skip && notificationBudget-- > 0) await runTimerNotifications(t, 1);
  }
  pruneTimerHistory(t);
}
