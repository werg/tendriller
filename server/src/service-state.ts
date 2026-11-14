import type { Env } from "./env";
import { HttpError } from "./http";
import ipaddr from "ipaddr.js";

export type ServiceMode = "open" | "creation_paused" | "read_only";

export async function serviceMode(env: Env): Promise<ServiceMode> {
  const row = await env.ACCOUNTS.prepare("SELECT mode FROM service_state WHERE id = 1").first<{ mode: ServiceMode }>();
  if (!row || !["open", "creation_paused", "read_only"].includes(row.mode)) {
    throw new HttpError(503, "unavailable", "Service state is not initialized");
  }
  return row.mode;
}

export async function requireCreationOpen(env: Env): Promise<void> {
  if (await serviceMode(env) !== "open") throw new HttpError(503, "creation_paused", "New tendrils are temporarily paused");
}

export async function requireWritesOpen(env: Env): Promise<void> {
  if (await serviceMode(env) === "read_only") throw new HttpError(503, "read_only", "Writes are temporarily paused");
}

/** Returns a compensation action to call if creation fails. */
export async function reserveCreationIp(env: Env, req: Request): Promise<() => Promise<void>> {
  const db = env.ACCOUNTS!;
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) throw new HttpError(503, "unavailable", "Creator address is unavailable");
  const blocked = await db.prepare("SELECT 1 FROM blocks WHERE kind = 'ip' AND value = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(ip, Date.now()).first();
  if (blocked) throw new HttpError(403, "blocked", "Creation is unavailable from this address");
  if (ipaddr.isValid(ip)) {
    const address = ipaddr.parse(ip);
    const ranges = await db.prepare("SELECT value FROM blocks WHERE kind = 'cidr' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(Date.now()).all<{ value: string }>();
    for (const range of ranges.results) {
      try {
        const network = ipaddr.parseCIDR(range.value);
        if (address.kind() === network[0].kind() && address.match(network)) {
          throw new HttpError(403, "blocked", "Creation is unavailable from this address");
        }
      } catch (error) { if (error instanceof HttpError) throw error; }
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare(`INSERT INTO creation_ip (ip, day, count) VALUES (?, ?, 1)
    ON CONFLICT(ip, day) DO UPDATE SET count = count + 1 WHERE count < 30 RETURNING count`)
    .bind(ip, day).first<{ count: number }>();
  if (!row) throw new HttpError(429, "rate_limited", "Daily creation limit reached");
  return async () => { await db.prepare("UPDATE creation_ip SET count = count - 1 WHERE ip = ? AND day = ? AND count > 0").bind(ip, day).run(); };
}
