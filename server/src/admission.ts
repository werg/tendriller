import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { errorResponse, json } from "./http";

/** Exact service-wide admission for anonymous creations. One named instance. */
export class Admission extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS creations (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS creations_ts ON creations (ts);`);
  }

  fetch(req: Request): Response {
    const url = new URL(req.url);
    const id = req.headers.get("x-tendril-id") ?? "";
    if (!/^[a-z2-7]{12}$/.test(id)) return errorResponse(400, "bad_request", "Invalid tendril id");
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    if (url.pathname === "/release" && req.method === "POST") {
      sql.exec("UPDATE creations SET released = 1 WHERE id = ?", id);
      return json({ ok: true });
    }
    if (url.pathname === "/reopen" && req.method === "POST") {
      const row = sql.exec("SELECT released FROM creations WHERE id = ?", id).toArray()[0] as { released: number } | undefined;
      if (!row) return errorResponse(404, "not_found", "Creation record is missing");
      if (!row.released) return json({ ok: true });
      const cap = Number(this.env.PUBLIC_UNCLAIMED_CAP ?? 1000);
      const live = sql.exec("SELECT COUNT(*) AS n FROM creations WHERE released = 0").one() as { n: number };
      if (live.n >= cap) return errorResponse(503, "busy", "Anonymous creation is temporarily full");
      sql.exec("UPDATE creations SET released = 0 WHERE id = ?", id);
      return json({ ok: true });
    }
    if (url.pathname === "/cancel" && req.method === "POST") {
      sql.exec("DELETE FROM creations WHERE id = ? AND released = 0", id);
      return json({ ok: true });
    }
    if (url.pathname !== "/reserve" || req.method !== "POST") return errorResponse(404, "not_found", "Not found");
    if (sql.exec("SELECT id FROM creations WHERE id = ?", id).toArray().length) return json({ ok: true });
    const hourCap = Number(this.env.PUBLIC_CREATIONS_PER_HOUR ?? 100);
    const liveCap = Number(this.env.PUBLIC_UNCLAIMED_CAP ?? 1000);
    if (!Number.isSafeInteger(hourCap) || hourCap < 1 || !Number.isSafeInteger(liveCap) || liveCap < 1) {
      return errorResponse(503, "unavailable", "Admission limits are not configured");
    }
    const perHour = sql.exec("SELECT COUNT(*) AS n FROM creations WHERE ts > ?", now - 3_600_000).one() as { n: number } | undefined;
    const live = sql.exec("SELECT COUNT(*) AS n FROM creations WHERE released = 0").one() as { n: number } | undefined;
    if ((perHour?.n ?? 0) >= hourCap || (live?.n ?? 0) >= liveCap) return errorResponse(503, "busy", "Anonymous creation is temporarily full");
    sql.exec("INSERT OR IGNORE INTO creations (id, ts) VALUES (?, ?)", id, now);
    sql.exec("DELETE FROM creations WHERE released = 1 AND ts < ?", now - 2 * 86_400_000);
    return json({ ok: true });
  }
}
