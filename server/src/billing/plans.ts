/** Canonical Tendriller plan definitions, quotas, and PAYG overage rates. */
import { HOUR, MB } from "../limits";

export const GB = 1024 * MB;
/** Short uniform host-side publication cache window (current + 2 prior versions). */
export const DEFAULT_VERSION_RETENTION = 3;

export type PlanId = "free" | "pro" | "team" | "unlimited";
export type BillingInterval = "month" | "year";

export interface PlanQuotas {
  /** Active pages per account (null = unlimited). */
  pages: number | null;
  /** Permanent resident pages per account (null = unlimited). */
  residents: number | null;
  /** Account-wide R2 published asset bytes (null = unlimited). */
  storageBytes: number | null;
  /** Per-page R2 + participant storage bytes. */
  pageStorageBytes: number;
  /** Registered workspace agents per account (null = unlimited). */
  agents: number | null;
  /** Approved guests per page (null = unlimited). */
  guestsPerPage: number | null;
  /** Retained publication versions per page (null = unlimited). */
  versionRetention: number | null;
  /** Opted-in hosted MCP pages per account (null = unlimited). */
  mcpPages: number | null;
  /** Monthly hosted MCP calls included (null = unlimited). */
  mcpCallsPerMonth: number | null;
  /** Per-page encrypted mcp_store byte limit (null = unlimited). */
  mcpStoreBytes: number | null;
  /** QuickJS-NG sandbox CPU timeout for hosted MCP calls. */
  mcpSandboxTimeoutMs: number;
  /** Monthly TURN + SFU media egress bytes included (null = unlimited). */
  mediaBytesPerMonth: number | null;
  /** Whether Cloudflare Realtime SFU multi-party routing is unlocked. */
  sfuEnabled: boolean;
  /** Max concurrent video peers in an SFU room (0 = P2P mesh only). */
  sfuMaxPeers: number;
  /** Max SFU video height hint (0 = P2P mesh only). */
  sfuMaxHeight: number;
  /** Monthly DO WebSocket relay active duration in ms (null = unlimited). */
  relayMsPerMonth: number | null;
  /** Concurrent DO WebSocket relay sessions per account (null = unlimited). */
  relayConcurrentSessions: number | null;
  /** Single DO relay session lifetime in ms. */
  relayLifetimeMs: number;
  /** Whether opt-in pay-as-you-go metered overage is permitted. */
  paygAllowed: boolean;
  /** PAYG rate: cents per GB of media egress over included allowance. */
  paygMediaCentsPerGb: number;
  /** PAYG rate: cents per 10,000 hosted MCP calls over included allowance. */
  paygMcpCentsPer10k: number;
  /** Whether host-brokered personal wrapped OAuth connections (Issue #136 Tier B personal) are included. */
  hostBrokeredOAuth: boolean;
  /** Whether Team OAuth tie-ins (GitHub Org/Team & Google Workspace group admission, automatic offboarding, and shared page-custody OAuth connections — Issue #136) are included. */
  teamOrgOAuth: boolean;
  /** Whether custom page domains (*.yourteam.com) are included. */
  customDomain: boolean;
  /** Named page subdomains (<name>.<PAGE_BASE_DOMAIN>) per account (0 = not included, null = unlimited). */
  customSubdomains: number | null;
}

export interface PlanSpec {
  id: PlanId;
  name: string;
  tagline: string;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  quotas: PlanQuotas;
}

export const PLANS: Readonly<Record<PlanId, PlanSpec>> = Object.freeze({
  free: {
    id: "free",
    name: "Free",
    tagline: "Everything you need to build and share real local-first apps.",
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    quotas: {
      pages: 20,
      residents: 20,
      storageBytes: 1 * GB,
      pageStorageBytes: 100 * MB,
      agents: 5,
      guestsPerPage: 10,
      versionRetention: DEFAULT_VERSION_RETENTION,
      mcpPages: 1,
      mcpCallsPerMonth: 250,
      mcpStoreBytes: 50 * MB,
      mcpSandboxTimeoutMs: 50,
      mediaBytesPerMonth: 2 * GB, // 2 GB/mo TURN trial (~45 hrs audio or ~2 hrs 1:1 720p)
      sfuEnabled: false,
      sfuMaxPeers: 0,
      sfuMaxHeight: 0,
      relayMsPerMonth: 5 * HOUR,
      relayConcurrentSessions: 2,
      relayLifetimeMs: HOUR,
      paygAllowed: false,
      paygMediaCentsPerGb: 0,
      paygMcpCentsPer10k: 0,
      hostBrokeredOAuth: false,
      teamOrgOAuth: false,
      customDomain: false,
      customSubdomains: 0,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Named subdomains, group video calls, reliable cloud relay, and full hosted MCP.",
    monthlyPriceCents: 1200,
    yearlyPriceCents: 10000,
    quotas: {
      pages: 100,
      residents: 100,
      storageBytes: 20 * GB,
      pageStorageBytes: 250 * MB,
      agents: 25,
      guestsPerPage: 50,
      versionRetention: DEFAULT_VERSION_RETENTION,
      mcpPages: 25,
      mcpCallsPerMonth: 15_000,
      mcpStoreBytes: 500 * MB,
      mcpSandboxTimeoutMs: 150,
      mediaBytesPerMonth: 100 * GB,
      sfuEnabled: true,
      sfuMaxPeers: 12,
      sfuMaxHeight: 720,
      relayMsPerMonth: 50 * HOUR,
      relayConcurrentSessions: 16,
      relayLifetimeMs: 2 * HOUR,
      paygAllowed: true,
      paygMediaCentsPerGb: 10, // $0.10/GB
      paygMcpCentsPer10k: 200, // $2.00 per 10k calls
      hostBrokeredOAuth: true,
      teamOrgOAuth: false,
      customDomain: false,
      customSubdomains: 25,
    },
  },
  team: {
    id: "team",
    name: "Team",
    tagline: "Larger video rooms, team sign-in, high-volume hosted MCP, named subdomains, and custom domains.",
    monthlyPriceCents: 3900,
    yearlyPriceCents: 32000,
    quotas: {
      pages: 1000,
      residents: 1000,
      storageBytes: 100 * GB,
      pageStorageBytes: 500 * MB,
      agents: 100,
      guestsPerPage: 250,
      versionRetention: DEFAULT_VERSION_RETENTION,
      mcpPages: 100,
      mcpCallsPerMonth: 100_000,
      mcpStoreBytes: 2 * GB,
      mcpSandboxTimeoutMs: 250,
      mediaBytesPerMonth: 500 * GB,
      sfuEnabled: true,
      sfuMaxPeers: 50,
      sfuMaxHeight: 1080,
      relayMsPerMonth: 250 * HOUR,
      relayConcurrentSessions: 64,
      relayLifetimeMs: 4 * HOUR,
      paygAllowed: true,
      paygMediaCentsPerGb: 8, // $0.08/GB
      paygMcpCentsPer10k: 150, // $1.50 per 10k calls
      hostBrokeredOAuth: true,
      teamOrgOAuth: true,
      customDomain: true,
      customSubdomains: 100,
    },
  },
  unlimited: {
    id: "unlimited",
    name: "Self-Hosted",
    tagline: "Unlimited quotas running on your own Cloudflare account.",
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    quotas: {
      pages: null,
      residents: null,
      storageBytes: null,
      pageStorageBytes: 500 * MB,
      agents: null,
      guestsPerPage: null,
      versionRetention: DEFAULT_VERSION_RETENTION,
      mcpPages: null,
      mcpCallsPerMonth: null,
      mcpStoreBytes: null,
      mcpSandboxTimeoutMs: 250,
      mediaBytesPerMonth: null,
      sfuEnabled: true,
      sfuMaxPeers: 50,
      sfuMaxHeight: 1080,
      relayMsPerMonth: null,
      relayConcurrentSessions: null,
      relayLifetimeMs: 4 * HOUR,
      paygAllowed: false,
      paygMediaCentsPerGb: 0,
      paygMcpCentsPer10k: 0,
      hostBrokeredOAuth: true,
      teamOrgOAuth: true,
      customDomain: true,
      customSubdomains: null,
    },
  },
});

export function isPlanId(value: unknown): value is PlanId {
  return value === "free" || value === "pro" || value === "team" || value === "unlimited";
}

export function planSpec(plan: PlanId): PlanSpec {
  return PLANS[plan] ?? PLANS.free;
}

/** Monthly UTC period key (`YYYY-MM`) and its next reset timestamp (ISO string). */
export function currentUsagePeriod(now = Date.now()): { period: string; resetsAt: string } {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const period = `${year}-${String(month + 1).padStart(2, "0")}`;
  const resetsAt = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
  return { period, resetsAt };
}

/** Estimate accrued PAYG overage spend in integer cents (rounded up to whole cents). */
export function estimateOverageCents(
  plan: PlanId,
  usage: { mediaBytes: number; mcpCalls: number },
): { mediaCents: number; mcpCents: number; totalCents: number; mediaOverageBytes: number; mcpOverageCalls: number } {
  const q = planSpec(plan).quotas;
  if (!q.paygAllowed) {
    return { mediaCents: 0, mcpCents: 0, totalCents: 0, mediaOverageBytes: 0, mcpOverageCalls: 0 };
  }
  const mediaOverageBytes = q.mediaBytesPerMonth !== null ? Math.max(0, usage.mediaBytes - q.mediaBytesPerMonth) : 0;
  const mcpOverageCalls = q.mcpCallsPerMonth !== null ? Math.max(0, usage.mcpCalls - q.mcpCallsPerMonth) : 0;
  const mediaCents = mediaOverageBytes > 0 ? Math.ceil((mediaOverageBytes / GB) * q.paygMediaCentsPerGb) : 0;
  const mcpCents = mcpOverageCalls > 0 ? Math.ceil((mcpOverageCalls / 10_000) * q.paygMcpCentsPer10k) : 0;
  return { mediaCents, mcpCents, totalCents: mediaCents + mcpCents, mediaOverageBytes, mcpOverageCalls };
}
