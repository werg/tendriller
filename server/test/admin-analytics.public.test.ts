import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import {
  ANALYTICS_RETENTION_DAYS,
  maintainServiceAnalytics,
  pruneServiceAnalytics,
  queryServiceAnalytics,
  recordServiceUsage,
  snapshotServiceInventory,
} from "../src/admin/analytics";
import { recordAccountUsage } from "../src/billing/entitlements";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const DAY = 86_400_000;
const TODAY = "2026-11-27";

beforeEach(async () => {
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("DELETE FROM service_usage_daily"),
    env.ACCOUNTS.prepare("DELETE FROM service_inventory_daily"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("Service operational analytics", () => {
  it("reports absent collection explicitly without inventing historical zeroes", async () => {
    const result = await queryServiceAnalytics(env, {}, NOW);
    expect(result).toMatchObject({
      schemaVersion: 1,
      scope: "service",
      timezone: "UTC",
      range: { from: "2026-10-29", to: TODAY, inclusive: true },
      retentionDays: 90,
      totals: null,
      latestInventory: null,
      coverage: { usageDaysWithSamples: 0, inventoryDaysWithSamples: 0, requestedDays: 30, missingDayMeaning: "not_observed" },
    });
    expect(result.daily).toHaveLength(30);
    expect(result.daily.every(day => day.usage === null && day.inventory === null)).toBe(true);
    await recordServiceUsage(env, {}, NOW);
    expect((await queryServiceAnalytics(env, { from: TODAY }, NOW)).totals).toBeNull();
  });

  it("preserves concurrent increments, uses UTC flush dates, and never sums inventory gauges", async () => {
    await Promise.all(Array.from({ length: 25 }, () => recordServiceUsage(env, {
      mcpCalls: 1, relayMs: 25, relayBytes: 1024, mediaBytes: 2048,
    }, NOW)));
    await recordServiceUsage(env, { mcpCalls: 2 }, Date.parse("2026-11-26T23:59:59.999Z"));
    await recordServiceUsage(env, { mcpCalls: 3 }, Date.parse("2026-11-27T00:00:00.000Z"));
    await snapshotServiceInventory(env, NOW);
    const result = await queryServiceAnalytics(env, { from: "2026-11-25", to: TODAY }, NOW);
    expect(result.totals).toEqual({ mcpCalls: 30, relayMs: 625, relayBytes: 25 * 1024, mediaBytes: 25 * 2048 });
    expect(result.daily.map(day => [day.day, day.usage?.mcpCalls ?? null])).toEqual([
      ["2026-11-25", null], ["2026-11-26", 2], [TODAY, 28],
    ]);
    expect(result.coverage).toMatchObject({ usageDaysWithSamples: 2, inventoryDaysWithSamples: 1, firstUsageDay: "2026-11-26", lastUsageDay: TODAY });
    expect(result.totals).not.toHaveProperty("totalAccounts");
    expect(result.latestInventory?.capturedAt).toBe(new Date(NOW).toISOString());
  });

  it("accepts only finite nonnegative safe integer counters and fixed fields", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
      await recordServiceUsage(env, { mcpCalls: value } as any, NOW);
    }
    for (const value of [NaN, Infinity, -1, 0.5]) await recordServiceUsage(env, { mcpCalls: 1 }, value);
    await recordServiceUsage(env, { mcpCalls: 1, pageId: "private-page-sentinel" } as any, NOW);
    expect((await queryServiceAnalytics(env, {}, NOW)).totals).toBeNull();
    expect(warnings.mock.calls.every(call => call.length === 1 && call[0] === "service_analytics_usage_failed")).toBe(true);
    // SQLite also rejects invalid writes and overflow when independent writers race.
    await expect(env.ACCOUNTS.prepare("INSERT INTO service_usage_daily(day,mcp_calls) VALUES (?,?)").bind(TODAY, -1).run()).rejects.toThrow();
    await recordServiceUsage(env, { mcpCalls: Number.MAX_SAFE_INTEGER }, NOW);
    await recordServiceUsage(env, { mcpCalls: 1 }, NOW);
    expect((await queryServiceAnalytics(env, { from: TODAY }, NOW)).totals?.mcpCalls).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("retains exactly the latest 90 UTC days and excludes already-expired rows from queries", async () => {
    const retained = NOW - (ANALYTICS_RETENTION_DAYS - 1) * DAY;
    const expired = retained - DAY;
    await recordServiceUsage(env, { mcpCalls: 1 }, retained);
    await recordServiceUsage(env, { mcpCalls: 9 }, expired);
    await snapshotServiceInventory(env, retained);
    await snapshotServiceInventory(env, expired);
    const from = new Date(retained).toISOString().slice(0, 10);
    expect((await queryServiceAnalytics(env, { from }, NOW)).totals?.mcpCalls).toBe(1);
    await pruneServiceAnalytics(env, NOW);
    const usage = await env.ACCOUNTS.prepare("SELECT day FROM service_usage_daily ORDER BY day").all<{ day: string }>();
    const inventory = await env.ACCOUNTS.prepare("SELECT day FROM service_inventory_daily ORDER BY day").all<{ day: string }>();
    expect(usage.results).toEqual([{ day: from }]);
    expect(inventory.results).toEqual([{ day: from }]);
    await maintainServiceAnalytics(env, NOW);
    expect((await queryServiceAnalytics(env, {}, NOW)).latestInventory?.day).toBe(TODAY);
  });

  it("rejects invalid, future, excessive, reversed and identifying query parameters", async () => {
    for (const input of [
      { from: "2026-02-30" }, { to: "2026-11-28" }, { from: "2026-01-01" },
      { from: TODAY, to: "2026-11-26" }, { from: "2026-11-01T00:00:00Z" },
      { pageId: "private-page-sentinel" }, { accountId: "private-account-sentinel" },
      { from: null }, { to: 1 },
    ]) {
      await expect(queryServiceAnalytics(env, input as any, NOW)).rejects.toMatchObject({ status: 400, code: "invalid_analytics_range" });
    }
    expect((await queryServiceAnalytics(env, { to: "2026-11-20" }, NOW)).range).toEqual({ from: "2026-10-22", to: "2026-11-20", inclusive: true });
  });

  it("stores numeric global inventory only and keeps the newest snapshot on out-of-order maintenance", async () => {
    await snapshotServiceInventory(env, NOW);
    const before = (await queryServiceAnalytics(env, {}, NOW)).latestInventory!;
    const privateValue = `private-sentinel-${crypto.randomUUID()}`;
    await env.ACCOUNTS.prepare("INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)")
      .bind(privateValue, NOW, `${privateValue}@example.test`).run();
    await env.ACCOUNTS.prepare("INSERT INTO tendrils(id,owner_account,intended_owner,creator_ip,created_at,state,lifetime) VALUES(?,?,?,?,?,'active','resident')")
      .bind(`page-${privateValue}`, privateValue, `${privateValue}@example.test`, "192.0.2.123", NOW).run();
    await snapshotServiceInventory(env, NOW + 1000);
    await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at=? WHERE id=?").bind(NOW + 2000, privateValue).run();
    await snapshotServiceInventory(env, NOW); // Must not replace the later completed snapshot.
    const result = await queryServiceAnalytics(env, {}, NOW + 2000);
    expect(result.latestInventory).toMatchObject({
      capturedAt: new Date(NOW + 1000).toISOString(),
      totalAccounts: before.totalAccounts + 1,
      activeAccounts: before.activeAccounts + 1,
      totalPages: before.totalPages + 1,
      activePages: before.activePages + 1,
      residentPages: before.residentPages + 1,
    });
    expect(result.daily.filter(day => day.inventory !== null)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain("192.0.2.123");
    for (const table of ["service_usage_daily", "service_inventory_daily"]) {
      const columns = await env.ACCOUNTS.prepare(`PRAGMA table_info(${table})`).all<{ name: string; type: string }>();
      expect(columns.results.filter(column => column.type !== "INTEGER").map(column => column.name)).toEqual(["day"]);
      const rows = await env.ACCOUNTS.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows.results)).not.toContain(privateValue);
    }
  });

  it("records aggregate usage only after existing account metering succeeds", async () => {
    const account = crypto.randomUUID();
    await env.ACCOUNTS.prepare("INSERT INTO accounts(id,created_at) VALUES(?,?)").bind(account, NOW).run();
    await recordAccountUsage(env, account, { mcpCalls: 2, relayBytes: 32 }, NOW);
    await recordAccountUsage(env, "missing-account", { mcpCalls: 10 }, NOW);
    expect((await queryServiceAnalytics(env, { from: TODAY }, NOW)).totals).toEqual({ mcpCalls: 2, relayMs: 0, relayBytes: 32, mediaBytes: 0 });
  });

  it("reports missing service state instead of fabricating an empty inventory snapshot", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = (await env.ACCOUNTS.prepare("SELECT * FROM service_state WHERE id=1").first<Record<string, string | number | null>>())!;
    await env.ACCOUNTS.prepare("DELETE FROM service_state WHERE id=1").run();
    try {
      await snapshotServiceInventory(env, NOW);
      expect(warning).toHaveBeenCalledWith("service_analytics_inventory_failed");
      expect((await queryServiceAnalytics(env, {}, NOW)).latestInventory).toBeNull();
    } finally {
      const keys = Object.keys(state);
      await env.ACCOUNTS.prepare(`INSERT INTO service_state (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .bind(...keys.map(key => state[key])).run();
    }
  });

  it("does not return rounded totals or retain unsafe inventory gauges", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordServiceUsage(env, { mcpCalls: Number.MAX_SAFE_INTEGER }, NOW - DAY);
    await recordServiceUsage(env, { mcpCalls: 1 }, NOW);
    await expect(queryServiceAnalytics(env, {}, NOW)).rejects.toMatchObject({ status: 503, code: "analytics_unavailable" });
    await snapshotServiceInventory(env, NOW);
    await expect(env.ACCOUNTS.prepare("UPDATE service_inventory_daily SET capacity_bytes=? WHERE day=?")
      .bind(Number.MAX_SAFE_INTEGER + 1, TODAY).run()).rejects.toThrow();
  });

  it("fails open on writes and maintenance while reads return a sanitized unavailable error", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { ...env, ACCOUNTS: { prepare() { throw new Error("private-provider-error-with-page-secret"); } } } as unknown as Env;
    await expect(recordServiceUsage(broken, { mcpCalls: 1 }, NOW)).resolves.toBeUndefined();
    await expect(maintainServiceAnalytics(broken, NOW)).resolves.toBeUndefined();
    await expect(queryServiceAnalytics(broken, {}, NOW)).rejects.toMatchObject({ status: 503, code: "analytics_unavailable" });
    expect(warnings.mock.calls).toEqual([
      ["service_analytics_usage_failed"], ["service_analytics_inventory_failed"],
      ["service_analytics_retention_failed"], ["service_analytics_read_failed"],
    ]);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private-provider-error");
  });
});
