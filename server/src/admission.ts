import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { errorResponse, json } from "./http";

/** Exact service-wide admission for anonymous creations. One named instance. */
export class Admission extends DurableObject<Env> {
  private live: number | undefined;
  private hourly: { count: number; checkedAt: number; expiresAt: number } | undefined;
  private prunedBefore: number | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS creations (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS creations_ts ON creations (ts);`);
  }

  private liveCount(): number {
    return this.live ??= this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM creations WHERE released = 0").one().n as number;
  }

  private hourlyCount(now: number): number {
    // This aggregate remains exact until its oldest counted creation expires.
    // A backwards clock jump also requires rebuilding the rolling window.
    if (!this.hourly || now < this.hourly.checkedAt || now >= this.hourly.expiresAt) {
      const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM creations WHERE ts > ?", now - 3_600_000)
        .one() as { n: number; oldest: number | null };
      this.hourly = { count: row.n, checkedAt: now, expiresAt: row.oldest === null ? Infinity : row.oldest + 3_600_000 };
    }
    return this.hourly.count;
  }

  fetch(req: Request): Response {
    const url = new URL(req.url);
    const id = req.headers.get("x-tendril-id") ?? "";
    if (!/^[a-z2-7]{12}$/.test(id)) return errorResponse(400, "bad_request", "Invalid tendril id");
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    if (url.pathname === "/release" && req.method === "POST") {
      const changed = sql.exec("UPDATE creations SET released = 1 WHERE id = ? AND released = 0 RETURNING ts", id).toArray() as { ts: number }[];
      if (this.live !== undefined) this.live -= changed.length;
      // A newly released old row can become eligible behind the last sweep.
      if (changed.length && this.prunedBefore !== undefined) this.prunedBefore = Math.min(this.prunedBefore, changed[0].ts);
      return json({ ok: true });
    }
    if (url.pathname === "/reopen" && req.method === "POST") {
      const row = sql.exec("SELECT released FROM creations WHERE id = ?", id).toArray()[0] as { released: number } | undefined;
      if (!row) return errorResponse(404, "not_found", "Creation record is missing");
      if (!row.released) return json({ ok: true });
      const cap = Number(this.env.PUBLIC_UNCLAIMED_CAP ?? 1000);
      if (!Number.isSafeInteger(cap) || cap < 1) return errorResponse(503, "unavailable", "Admission limits are not configured");
      if (this.liveCount() >= cap) return errorResponse(503, "busy", "Anonymous creation is temporarily full");
      const changed = sql.exec("UPDATE creations SET released = 0 WHERE id = ? AND released = 1 RETURNING id", id).toArray().length;
      this.live! += changed;
      return json({ ok: true });
    }
    if (url.pathname === "/cancel" && req.method === "POST") {
      const removed = sql.exec("DELETE FROM creations WHERE id = ? AND released = 0 RETURNING ts", id).toArray() as { ts: number }[];
      if (this.live !== undefined) this.live -= removed.length;
      if (removed.length && this.hourly) {
        if (now < this.hourly.checkedAt || now >= this.hourly.expiresAt) this.hourly = undefined;
        else if (removed[0].ts > now - 3_600_000) this.hourly.count--;
      }
      return json({ ok: true });
    }
    if (url.pathname !== "/reserve" || req.method !== "POST") return errorResponse(404, "not_found", "Not found");
    // Account setup owns an independently scheduled expiry journal. Reject a
    // delayed reserve after that deadline, including one arriving after cleanup.
    const setupDeadline = req.headers.get('x-setup-expires-at');
    if (setupDeadline !== null && (!/^\d{1,16}$/.test(setupDeadline) || !Number.isSafeInteger(Number(setupDeadline)) || Number(setupDeadline) <= now))
      return errorResponse(410, 'setup_expired', 'The account setup admission deadline expired');
    if (sql.exec("SELECT id FROM creations WHERE id = ?", id).toArray().length) return json({ ok: true });
    const hourCap = Number(this.env.PUBLIC_CREATIONS_PER_HOUR ?? 100);
    const liveCap = Number(this.env.PUBLIC_UNCLAIMED_CAP ?? 1000);
    if (!Number.isSafeInteger(hourCap) || hourCap < 1 || !Number.isSafeInteger(liveCap) || liveCap < 1) {
      return errorResponse(503, "unavailable", "Admission limits are not configured");
    }
    if (this.hourlyCount(now) >= hourCap || this.liveCount() >= liveCap) return errorResponse(503, "busy", "Anonymous creation is temporarily full");
    const inserted = sql.exec("INSERT OR IGNORE INTO creations (id, ts) VALUES (?, ?) RETURNING id", id, now).toArray().length;
    // fetch and each mutation are synchronous. Update the bounded aggregates
    // only after SQLite confirms the change; eviction rebuilds both from SQL.
    this.live! += inserted;
    this.hourly!.count += inserted;
    if (inserted) this.hourly!.expiresAt = Math.min(this.hourly!.expiresAt, now + 3_600_000);
    const cutoff = now - 2 * 86_400_000;
    if (this.prunedBefore === undefined) sql.exec("DELETE FROM creations WHERE released = 1 AND ts < ?", cutoff);
    else if (cutoff > this.prunedBefore)
      sql.exec("DELETE FROM creations WHERE released = 1 AND ts >= ? AND ts < ?", this.prunedBefore, cutoff);
    // Never advance this watermark until the sweep succeeds. A backwards clock
    // jump retains the last completed range; eviction starts with a full sweep.
    this.prunedBefore = Math.max(this.prunedBefore ?? cutoff, cutoff);
    return json({ ok: true });
  }
}
