/**
 * Periodic billing & usage reconciliation (runs in Worker `scheduled()` cron):
 * 1. Expires elapsed `past_due` grace windows and `canceled` subscriptions past `period_end`.
 * 2. Prunes expired `active_relay_leases`.
 * 3. Emits PAYG metered overage events (in 100 MB media chunks & 1,000-call MCP chunks) to Polar.sh,
 *    strictly bounded by each account's `payg_spend_cap_cents` (when not disabled).
 */
import type { Env } from "../env";
import { applyPlanToAccount } from "./entitlements";
import { ingestPolarUsageEvents, parsePolarMeters, type PolarUsageEvent } from "./polar";
import { currentUsagePeriod, estimateOverageCents, GB, isPlanId, planSpec, type PlanId } from "./plans";

const MB = 1024 * 1024;
const MEDIA_REPORT_CHUNK_MB = 100; // 0.1 GB granularity so users aren't rounded up by whole GBs
const MCP_REPORT_CHUNK_CALLS = 1000;

export async function reconcileBillingAndUsage(env: Env, now = Date.now()): Promise<{
  expiredSubscriptions: number;
  flushedEvents: number;
}> {
  if (!env.ACCOUNTS) return { expiredSubscriptions: 0, flushedEvents: 0 };
  let expiredSubscriptions = 0;
  let flushedEvents = 0;

  try {
    // 1. Prune expired relay concurrency leases.
    await env.ACCOUNTS.prepare("DELETE FROM active_relay_leases WHERE expires_at <= ?").bind(now).run();

    // 2. Downgrade accounts whose past_due grace window or canceled period_end has elapsed.
    const expired = await env.ACCOUNTS.prepare(`SELECT s.account_id, s.status
      FROM subscriptions s
      JOIN accounts a ON a.id = s.account_id
      WHERE a.plan IN ('pro', 'team')
        AND ((s.status = 'past_due' AND s.grace_until IS NOT NULL AND s.grace_until <= ?)
          OR (s.status = 'canceled' AND (s.period_end IS NULL OR s.period_end <= ?)))`)
      .bind(now, now).all<{ account_id: string; status: string }>();

    for (const row of expired.results) {
      await applyPlanToAccount(env, row.account_id, "free");
      await env.ACCOUNTS.prepare("UPDATE subscriptions SET status = 'revoked', updated_at = ? WHERE account_id = ?")
        .bind(now, row.account_id).run();
      await env.ACCOUNTS.prepare(
        "INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, 'system', 'billing:downgrade_expired', ?, ?, ?)",
      ).bind(crypto.randomUUID(), row.account_id, `previous_status=${row.status}`, now).run();
      expiredSubscriptions++;
    }

    // 3. Emit PAYG metered overage events to Polar (only when Polar token is configured).
    if (!env.POLAR_ACCESS_TOKEN) return { expiredSubscriptions, flushedEvents };
    const { period } = currentUsagePeriod(now);
    const meters = parsePolarMeters(env);

    const rows = await env.ACCOUNTS.prepare(`SELECT u.account_id, u.mcp_calls, u.media_bytes,
      u.reported_media_overage_mb, u.reported_mcp_overage_calls,
      a.plan, a.payg_enabled, a.payg_spend_cap_cents, a.media_bytes_cap, a.mcp_call_cap
      FROM usage_periods u
      JOIN accounts a ON a.id = u.account_id
      WHERE u.period = ? AND a.payg_enabled = 1 AND a.plan IN ('pro', 'team')
      LIMIT 100`)
      .bind(period).all<{
        account_id: string;
        mcp_calls: number;
        media_bytes: number;
        reported_media_overage_mb: number;
        reported_mcp_overage_calls: number;
        plan: string;
        payg_enabled: number;
        payg_spend_cap_cents: number | null;
        media_bytes_cap: number | null;
        mcp_call_cap: number | null;
      }>();

    const events: PolarUsageEvent[] = [];
    const updates: Array<{ accountId: string; addMediaMb: number; addMcpCalls: number }> = [];

    for (const r of rows.results) {
      if (!isPlanId(r.plan)) continue;
      const plan: PlanId = r.plan;
      const q = planSpec(plan).quotas;
      if (!q.paygAllowed) continue;

      const mediaIncluded = r.media_bytes_cap ?? q.mediaBytesPerMonth ?? 0;
      const mcpIncluded = r.mcp_call_cap ?? q.mcpCallsPerMonth ?? 0;

      // Respect spend cap if user did not disable it (`payg_spend_cap_cents !== null`).
      const est = estimateOverageCents(plan, { mediaBytes: r.media_bytes, mcpCalls: r.mcp_calls });
      const cappedRatio =
        r.payg_spend_cap_cents !== null && est.totalCents > r.payg_spend_cap_cents && est.totalCents > 0
          ? r.payg_spend_cap_cents / est.totalCents
          : 1;

      const rawMediaOverageMb = Math.floor(Math.max(0, r.media_bytes - mediaIncluded) / MB);
      const billableMediaMb = Math.floor(rawMediaOverageMb * cappedRatio);
      const unreportedMediaMb = billableMediaMb - r.reported_media_overage_mb;
      const mediaChunkMb = unreportedMediaMb >= MEDIA_REPORT_CHUNK_MB
        ? Math.floor(unreportedMediaMb / MEDIA_REPORT_CHUNK_MB) * MEDIA_REPORT_CHUNK_MB
        : 0;

      const rawMcpOverage = Math.max(0, r.mcp_calls - mcpIncluded);
      const billableMcp = Math.floor(rawMcpOverage * cappedRatio);
      const unreportedMcp = billableMcp - r.reported_mcp_overage_calls;
      const mcpChunkCalls = unreportedMcp >= MCP_REPORT_CHUNK_CALLS
        ? Math.floor(unreportedMcp / MCP_REPORT_CHUNK_CALLS) * MCP_REPORT_CHUNK_CALLS
        : 0;

      if (mediaChunkMb > 0) {
        const newTotalMb = r.reported_media_overage_mb + mediaChunkMb;
        events.push({
          name: meters.media_egress_gb,
          external_customer_id: r.account_id,
          external_id: `tendriller:${period}:media:${r.account_id}:${newTotalMb}`,
          timestamp: new Date(now).toISOString(),
          metadata: {
            period,
            plan,
            megabytes: mediaChunkMb,
            gigabytes: Number((mediaChunkMb / 1024).toFixed(4)),
            unit_cents_per_gb: q.paygMediaCentsPerGb,
          },
        });
      }
      if (mcpChunkCalls > 0) {
        const newTotalCalls = r.reported_mcp_overage_calls + mcpChunkCalls;
        events.push({
          name: meters.mcp_overage_calls,
          external_customer_id: r.account_id,
          external_id: `tendriller:${period}:mcp:${r.account_id}:${newTotalCalls}`,
          timestamp: new Date(now).toISOString(),
          metadata: {
            period,
            plan,
            calls: mcpChunkCalls,
            unit_cents_per_10k: q.paygMcpCentsPer10k,
          },
        });
      }
      if (mediaChunkMb > 0 || mcpChunkCalls > 0) {
        updates.push({ accountId: r.account_id, addMediaMb: mediaChunkMb, addMcpCalls: mcpChunkCalls });
      }
    }

    if (events.length > 0) {
      await ingestPolarUsageEvents(env, events);
      flushedEvents = events.length;
      for (const u of updates) {
        await env.ACCOUNTS.prepare(`UPDATE usage_periods
          SET reported_media_overage_mb = reported_media_overage_mb + ?,
              reported_mcp_overage_calls = reported_mcp_overage_calls + ?,
              updated_at = ?
          WHERE account_id = ? AND period = ?`)
          .bind(u.addMediaMb, u.addMcpCalls, now, u.accountId, period).run();
      }
    }
  } catch (err) {
    console.error("Billing reconciliation error", err);
  }

  return { expiredSubscriptions, flushedEvents };
}
