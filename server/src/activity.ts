// Activity record (PLAN 14.4): built by the server from the traffic it routes.
import type { Tendril } from "./tendril";
import { ACTIVITY_RETENTION } from "./limits";

export interface ActivityInput {
  kind: string;
  summary: string;
  device?: string | null;
  by?: string | null;
  source?: "server" | "agent";
}

export interface ActivityEntry {
  seq: number;
  ts: number;
  kind: string;
  summary: string;
  device: string | null;
  by?: string;
  source: "server" | "agent";
}

export function addActivity(t: Tendril, a: ActivityInput): number {
  const row = t.db.one<{ seq: number }>(
    "INSERT INTO activity (ts, kind, summary, device, by, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
    t.now(), a.kind, clip(a.summary, 500), a.device ?? null, a.by ?? null, a.source ?? "server",
  );
  return row!.seq;
}

export function listActivity(t: Tendril, after: number | null, limit: number): { entries: ActivityEntry[]; cursor: number } {
  const rows =
    after === null
      ? t.db.all("SELECT * FROM (SELECT * FROM activity ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC", limit)
      : t.db.all("SELECT * FROM activity WHERE seq > ? ORDER BY seq ASC LIMIT ?", after, limit);
  const entries = rows.map(renderActivity);
  return { entries, cursor: entries.length ? entries[entries.length - 1].seq : (after ?? 0) };
}

export function renderActivity(r: Record<string, any>): ActivityEntry {
  const e: ActivityEntry = { seq: r.seq, ts: r.ts, kind: r.kind, summary: r.summary, device: r.device ?? null, source: r.source };
  if (r.by) e.by = r.by;
  return e;
}

export function pruneActivity(t: Tendril): void {
  t.db.run("DELETE FROM activity WHERE ts < ?", t.now() - ACTIVITY_RETENTION);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
