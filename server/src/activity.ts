// Activity record (PLAN 14.4): built by the server from the traffic it routes.
import type { Tendril } from "./tendril";
import { ACTIVITY_RETENTION, HOUR } from "./limits";

export interface ActivityInput {
  kind: string;
  summary: string;
  device?: string | null;
  blob?: string | null;
  by?: string | null;
  source?: "server" | "agent";
}

export interface ActivityEntry {
  seq: number;
  ts: number;
  kind: string;
  summary: string;
  device: string | null;
  blob?: string;
  by?: string;
  source: "server" | "agent";
}

export function addActivity(t: Tendril, a: ActivityInput): number {
  const row = t.db.one<{ seq: number }>(
    "INSERT INTO activity (ts, kind, summary, device, blob, by, source) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
    t.now(), a.kind, clip(a.summary, 500), a.device ?? null, a.blob ?? null, a.by ?? null, a.source ?? "server",
  );
  return row!.seq;
}

/**
 * Upserts an aggregated entry identified by `key`: `counts` are added to the stored counters,
 * and the summary is rebuilt from the totals.
 */
export function bumpAggregate(
  t: Tendril,
  key: string,
  kind: string,
  device: string | null,
  counts: Record<string, number>,
  summarize: (totals: Record<string, number>) => string,
): void {
  const row = t.db.one<{ seq: number; agg: string }>("SELECT seq, agg FROM activity WHERE agg_key = ?", key);
  const totals: Record<string, number> = row ? JSON.parse(row.agg) : {};
  for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
  const summary = clip(summarize(totals), 500);
  if (row) {
    t.db.run("UPDATE activity SET agg = ?, summary = ?, ts = ? WHERE seq = ?", JSON.stringify(totals), summary, t.now(), row.seq);
  } else {
    t.db.run(
      "INSERT INTO activity (ts, kind, summary, device, source, agg_key, agg) VALUES (?, ?, ?, ?, 'server', ?, ?)",
      t.now(), kind, summary, device, key, JSON.stringify(totals),
    );
  }
}

/** Counts page events per hour and device, by a short label (the data's `type` field if it has one). */
export function countEvent(t: Tendril, device: string | null, data: unknown): void {
  const label = data && typeof data === "object" && typeof (data as any).type === "string" ? String((data as any).type).slice(0, 40) : "event";
  const bucket = Math.floor(t.now() / HOUR);
  bumpAggregate(t, `events:${bucket}:${device ?? "-"}`, "events", device, { [label]: 1 }, (tot) => {
    const n = Object.values(tot).reduce((a, b) => a + b, 0);
    const parts = Object.entries(tot)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`)
      .join(", ");
    return `Page sent ${n} event${n === 1 ? "" : "s"} (${parts})`;
  });
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
  if (r.blob) e.blob = r.blob;
  if (r.by) e.by = r.by;
  return e;
}

/** Deletes an entry and, if it references a blob, the blob and its stored bytes. */
export async function deleteActivity(t: Tendril, seq: number): Promise<boolean> {
  const row = t.db.one<{ blob: string | null }>("SELECT blob FROM activity WHERE seq = ?", seq);
  if (!row) return false;
  t.db.run("DELETE FROM activity WHERE seq = ?", seq);
  if (row.blob) await t.deleteBlob(row.blob);
  return true;
}

export function pruneActivity(t: Tendril): void {
  t.db.run("DELETE FROM activity WHERE ts < ?", t.now() - ACTIVITY_RETENTION);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function preview(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
