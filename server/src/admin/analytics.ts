/** Aggregate operations metrics. Never pass page, account, or request data here. */
import type { Env } from "../env";
import { HttpError } from "../http";

const DAY_MS = 86_400_000;
export const ANALYTICS_RETENTION_DAYS = 90;
const DEFAULT_RANGE_DAYS = 30;
const USAGE_FIELDS = ["mcpCalls", "relayMs", "relayBytes", "mediaBytes"] as const;

export interface ServiceUsage {
  mcpCalls: number;
  relayMs: number;
  relayBytes: number;
  mediaBytes: number;
}

interface UsageRow {
  day: string;
  mcp_calls: number;
  relay_ms: number;
  relay_bytes: number;
  media_bytes: number;
}

interface InventoryRow {
  day: string;
  captured_at: number;
  total_accounts: number;
  active_accounts: number;
  total_pages: number;
  active_pages: number;
  resident_pages: number;
  total_agents: number;
  unrevoked_agents: number;
  reserved_bytes: number;
  capacity_bytes: number;
}

function dayAt(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) throw new Error("invalid_analytics_clock");
  return new Date(now).toISOString().slice(0, 10);
}

function parseDay(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function retentionStart(now: number): string {
  return dayAt(Math.max(0, (parseDay(dayAt(now))!) - (ANALYTICS_RETENTION_DAYS - 1) * DAY_MS));
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Best-effort metered deltas, dated when their existing billing meter flushes.
 * One aggregate write per successful existing meter flush; ordinary HTTP/page
 * views and individual relay packets add no writes. Uncertain writes are not retried.
 */
export async function recordServiceUsage(env: Env, delta: Partial<ServiceUsage>, now = Date.now()): Promise<void> {
  try {
    if (!delta || typeof delta !== "object" || Array.isArray(delta) ||
      Object.keys(delta).some(key => !(USAGE_FIELDS as readonly string[]).includes(key))) {
      throw new Error("invalid_analytics_sample");
    }
    const values = USAGE_FIELDS.map(key => delta[key] === undefined ? 0 : delta[key]);
    if (!values.every(validCounter)) throw new Error("invalid_analytics_sample");
    const day = dayAt(now);
    if (values.every(value => value === 0)) return;
    if (!env.ACCOUNTS) throw new Error("analytics_unavailable");
    const result = await env.ACCOUNTS.prepare(`INSERT INTO service_usage_daily (day, mcp_calls, relay_ms, relay_bytes, media_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        mcp_calls = mcp_calls + excluded.mcp_calls,
        relay_ms = relay_ms + excluded.relay_ms,
        relay_bytes = relay_bytes + excluded.relay_bytes,
        media_bytes = media_bytes + excluded.media_bytes`)
      .bind(day, ...values).run();
    if (!result.success) throw new Error("analytics_unavailable");
  } catch {
    // Never log the supplied values, SQL, provider error, or caller context.
    console.warn("service_analytics_usage_failed");
  }
}

/** One SQL snapshot of global inventory; no per-page objects are contacted. */
export async function snapshotServiceInventory(env: Env, now = Date.now()): Promise<void> {
  try {
    const day = dayAt(now);
    if (!env.ACCOUNTS) throw new Error("analytics_unavailable");
    const result = await env.ACCOUNTS.prepare(`INSERT INTO service_inventory_daily
      (day, captured_at, total_accounts, active_accounts, total_pages, active_pages, resident_pages,
        total_agents, unrevoked_agents, reserved_bytes, capacity_bytes)
      SELECT ?, ?,
        (SELECT COUNT(*) FROM accounts),
        (SELECT COUNT(*) FROM accounts WHERE suspended_at IS NULL AND deleting_at IS NULL),
        (SELECT COUNT(*) FROM tendrils),
        (SELECT COUNT(*) FROM tendrils WHERE state = 'active'),
        (SELECT COUNT(*) FROM tendrils WHERE state = 'active' AND lifetime = 'resident'),
        (SELECT COUNT(*) FROM agents),
        (SELECT COUNT(*) FROM agents WHERE revoked_at IS NULL),
        (SELECT reserved FROM service_state WHERE id = 1),
        (SELECT storage_cap FROM service_state WHERE id = 1)
      WHERE true
      ON CONFLICT(day) DO UPDATE SET
        captured_at = excluded.captured_at,
        total_accounts = excluded.total_accounts,
        active_accounts = excluded.active_accounts,
        total_pages = excluded.total_pages,
        active_pages = excluded.active_pages,
        resident_pages = excluded.resident_pages,
        total_agents = excluded.total_agents,
        unrevoked_agents = excluded.unrevoked_agents,
        reserved_bytes = excluded.reserved_bytes,
        capacity_bytes = excluded.capacity_bytes
      WHERE excluded.captured_at >= service_inventory_daily.captured_at`)
      .bind(day, now).run();
    if (!result.success) throw new Error("analytics_unavailable");
  } catch {
    console.warn("service_analytics_inventory_failed");
  }
}

/** Keep today plus the previous 89 UTC days, including when collection is idle. */
export async function pruneServiceAnalytics(env: Env, now = Date.now()): Promise<void> {
  try {
    const cutoff = retentionStart(now);
    if (!env.ACCOUNTS) throw new Error("analytics_unavailable");
    const results = await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("DELETE FROM service_usage_daily WHERE day < ?").bind(cutoff),
      env.ACCOUNTS.prepare("DELETE FROM service_inventory_daily WHERE day < ?").bind(cutoff),
    ]);
    if (results.some(result => !result.success)) throw new Error("analytics_unavailable");
  } catch {
    console.warn("service_analytics_retention_failed");
  }
}

export async function maintainServiceAnalytics(env: Env, now = Date.now()): Promise<void> {
  await Promise.all([snapshotServiceInventory(env, now), pruneServiceAnalytics(env, now)]);
}

function usageValue(row: UsageRow): ServiceUsage {
  const value = { mcpCalls: row.mcp_calls, relayMs: row.relay_ms, relayBytes: row.relay_bytes, mediaBytes: row.media_bytes };
  if (!Object.values(value).every(validCounter)) throw new Error("invalid_analytics_storage");
  return value;
}

function inventoryValue(row: InventoryRow) {
  if (!Object.entries(row).every(([key, value]) => key === "day" || validCounter(value))) throw new Error("invalid_analytics_storage");
  return {
    day: row.day,
    capturedAt: new Date(row.captured_at).toISOString(),
    totalAccounts: row.total_accounts,
    activeAccounts: row.active_accounts,
    totalPages: row.total_pages,
    activePages: row.active_pages,
    residentPages: row.resident_pages,
    totalAgents: row.total_agents,
    unrevokedAgents: row.unrevoked_agents,
    storageReservedBytes: row.reserved_bytes,
    storageCapacityBytes: row.capacity_bytes,
  };
}

/** Inclusive UTC dates, strict fixed query shape, at most 90 retained days. */
export async function queryServiceAnalytics(
  env: Env,
  input: { from?: string; to?: string } = {},
  now = Date.now(),
) {
  const today = dayAt(now);
  const earliest = retentionStart(now);
  const badRange = () => new HttpError(400, "invalid_analytics_range", "Use inclusive UTC dates (YYYY-MM-DD) within the last 90 days; only from and to are supported.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "from" && key !== "to")) throw badRange();
  const to = input.to === undefined ? today : input.to;
  const toMs = parseDay(to);
  if (toMs === null) throw badRange();
  const from = input.from === undefined
    ? new Date(Math.max(parseDay(earliest)!, toMs - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)).toISOString().slice(0, 10)
    : input.from;
  const fromMs = parseDay(from);
  if (fromMs === null || from > to || from < earliest || to > today || toMs - fromMs >= ANALYTICS_RETENTION_DAYS * DAY_MS) throw badRange();

  try {
    if (!env.ACCOUNTS) throw new Error("analytics_unavailable");
    const results = await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("SELECT day, mcp_calls, relay_ms, relay_bytes, media_bytes FROM service_usage_daily WHERE day BETWEEN ? AND ? ORDER BY day").bind(from, to),
      env.ACCOUNTS.prepare("SELECT * FROM service_inventory_daily WHERE day BETWEEN ? AND ? ORDER BY day").bind(from, to),
      env.ACCOUNTS.prepare("SELECT * FROM service_inventory_daily WHERE day BETWEEN ? AND ? AND captured_at <= ? ORDER BY day DESC LIMIT 1").bind(earliest, today, now),
    ]);
    if (results.some(result => !result.success)) throw new Error("analytics_unavailable");
    const usageRows = results[0].results as unknown as UsageRow[];
    const inventoryRows = results[1].results as unknown as InventoryRow[];
    const latestRow = results[2].results[0] as unknown as InventoryRow | undefined;
    const usageByDay = new Map(usageRows.map(row => [row.day, usageValue(row)]));
    const inventoryByDay = new Map(inventoryRows.map(row => [row.day, inventoryValue(row)]));
    const totals: ServiceUsage | null = usageRows.length ? { mcpCalls: 0, relayMs: 0, relayBytes: 0, mediaBytes: 0 } : null;
    if (totals) for (const value of usageByDay.values()) for (const key of USAGE_FIELDS) {
      totals[key] += value[key];
      if (!validCounter(totals[key])) throw new Error("invalid_analytics_storage");
    }
    const daily = [];
    for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
      const day = new Date(ms).toISOString().slice(0, 10);
      daily.push({ day, usage: usageByDay.get(day) ?? null, inventory: inventoryByDay.get(day) ?? null });
    }
    return {
      schemaVersion: 1,
      scope: "service" as const,
      timezone: "UTC" as const,
      range: { from, to, inclusive: true },
      retentionDays: ANALYTICS_RETENTION_DAYS,
      totals,
      daily,
      latestInventory: latestRow ? inventoryValue(latestRow) : null,
      coverage: {
        usageDaysWithSamples: usageRows.length,
        inventoryDaysWithSamples: inventoryRows.length,
        requestedDays: daily.length,
        firstUsageDay: usageRows[0]?.day ?? null,
        lastUsageDay: usageRows.at(-1)?.day ?? null,
        missingDayMeaning: "not_observed" as const,
        usageQuality: "best_effort_metered_deltas" as const,
        inventoryKind: "latest_daily_snapshot" as const,
      },
      limitations: [
        "Missing days and totals without samples are null, not measured zeroes; collection has no historical backfill.",
        "Usage is dated when existing meters flush. MCP calls are metered hosted attempts, not successful operations or all gateway traffic.",
        "Relay counters may undercount after hibernation or eviction. Media bytes are client-reported SFU receive bytes, not TURN or provider-measured egress.",
        "Inventory snapshots are gauges, not live activity or unique users, and must not be summed across days.",
        "Storage is reserved capacity, not measured disk usage. Request counts, CPU, latency, and actual storage usage require Cloudflare provider metrics.",
      ],
    };
  } catch {
    console.warn("service_analytics_read_failed");
    throw new HttpError(503, "analytics_unavailable", "Operational analytics are temporarily unavailable.");
  }
}
