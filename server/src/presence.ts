// Agent presence (PROTOCOL section 8.4). Pure computation from the tendril's facts.
import { DAY, HOUR, MINUTE, STATUS_OVERRIDE_TTL, WORKING_WINDOW } from "./limits";

export type PresenceState = "listening" | "working" | "scheduled" | "not_responding" | "away" | "no_agent";

export interface Presence {
  state: PresenceState;
  text: string;
  last_seen: number | null;
  schedule_minutes: number | null;
  withheld: number;
  wake: "long_poll" | "webhook" | "schedule" | "none";
}

export interface PresenceFacts {
  now: number;
  tokens: number;
  lastCheckin: number | null;
  longPollHeld: boolean;
  webhook: boolean;
  scheduleMinutes: number | null;
  /** Time a wake was delivered that has not been followed by a check-in yet. */
  wakePendingSince: number | null;
  graceSeconds: number;
  status: { state: "working" | "idle" | "done"; text: string | null; at: number } | null;
  withheld: number;
}

export function relativeTime(then: number, now: number): string {
  const d = Math.max(0, now - then);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(d / DAY);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function computePresence(f: PresenceFacts): Presence {
  const wake: Presence["wake"] = f.longPollHeld ? "long_poll" : f.webhook ? "webhook" : f.scheduleMinutes ? "schedule" : "none";
  const base = { last_seen: f.lastCheckin, schedule_minutes: f.scheduleMinutes, withheld: f.withheld, wake };
  const p = (state: PresenceState, text: string): Presence => ({ state, text, ...base });

  if (f.tokens === 0 || f.lastCheckin === null) {
    return p("no_agent", f.lastCheckin ? `No agent attached, last heard from ${relativeTime(f.lastCheckin, f.now)}` : "No agent attached");
  }
  const since = f.now - f.lastCheckin;
  if (f.wakePendingSince !== null && f.now - f.wakePendingSince >= f.graceSeconds * 1000) {
    return p("not_responding", "Agent not responding");
  }
  if (f.longPollHeld) return p("listening", "Listening");

  const status = f.status && f.now - f.status.at < STATUS_OVERRIDE_TTL ? f.status : null;
  if (status?.state === "working") return p("working", status.text || "Working");
  const label = (fallback: string) => (status ? status.text || (status.state === "done" ? "Done" : "Idle") : fallback);

  if (!status && since < WORKING_WINDOW) return p("working", "Working");
  if (f.webhook && since < DAY) return p("listening", label("Listening"));
  if (f.scheduleMinutes) {
    const n = f.scheduleMinutes;
    if (since > (2 * n + 5) * MINUTE) return p("not_responding", `Agent not responding (checks every ${n} min)`);
    return p("scheduled", label(`Checks every ${n} min`));
  }
  return p("away", label(`Last heard from ${relativeTime(f.lastCheckin, f.now)}`));
}

/** Next time the presence may change by itself (for scheduling the alarm), or null. */
export function nextPresenceChange(f: PresenceFacts): number | null {
  const times: number[] = [];
  if (f.lastCheckin !== null) {
    times.push(f.lastCheckin + WORKING_WINDOW, f.lastCheckin + DAY);
    if (f.scheduleMinutes) times.push(f.lastCheckin + (2 * f.scheduleMinutes + 5) * MINUTE + 1);
  }
  if (f.wakePendingSince !== null) times.push(f.wakePendingSince + f.graceSeconds * 1000);
  if (f.status) times.push(f.status.at + STATUS_OVERRIDE_TTL);
  const future = times.filter((t) => t > f.now);
  return future.length ? Math.min(...future) : null;
}
