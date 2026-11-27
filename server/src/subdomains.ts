/**
 * Named page subdomains (`<name>.<PAGE_BASE_DOMAIN>`) for paid plans (Pro, Team, Self-Hosted).
 *
 * Keeps each page's immutable 12-char `tendril_id` intact as a fallback alias so existing devices
 * with local-first Chronolog state are never stranded and downgrades stay non-destructive.
 */
import type { Env } from "./env";
import { HttpError } from "./http";
import { TENDRIL_ID_RE } from "./ids";
import { cachedAccountEntitlements, getAccountEntitlements, quotaError, type AccountEntitlements } from "./billing/entitlements";
import { TtlCache } from "./isolate-cache";
import { barePageUrl, pageHostForLabel, parsePageHostLabel, publicBase } from "./urls";

export interface PageSubdomainRow {
  subdomain: string;
  account_id: string;
  tendril_id: string;
  created_at: number;
  updated_at: number;
}

export interface SubdomainUpdateResult {
  id: string;
  subdomain: string | null;
  page_url: string;
  bare_url: string;
  fallback_page_url: string;
  fallback_bare_url: string;
  /** Set when the subdomain was atomically moved/swapped from another page in the same account. */
  previous_tendril_id?: string | null;
  /** Set when two pages swapped their subdomains atomically (the subdomain moved onto `previous_tendril_id`). */
  swapped_subdomain?: string | null;
}

export interface SetSubdomainOptions {
  /** Atomically move the subdomain from another page owned by the same account. */
  reassign?: boolean;
  /** When moving a subdomain onto a page that already has one, atomically swap the two names instead of clearing the target's old name. */
  swap?: boolean;
  /** Optional authorization hook checked before displacing another page (e.g. verifying an agent has `host:manage` on that page). */
  authorizeDisplacedPage?: (previousTendrilId: string) => Promise<void>;
}

/** DNS-safe lowercase label, 3..45 chars (leaves room for `--p-<12hex>` branch preview suffix within 63-char DNS label limit). */
export const PAGE_SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])$/;

const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "app",
  "auth",
  "admin",
  "billing",
  "blog",
  "cdn",
  "chat",
  "cloud",
  "console",
  "cookbooks",
  "dashboard",
  "dev",
  "docs",
  "help",
  "home",
  "login",
  "mail",
  "mcp",
  "oauth",
  "pages",
  "portal",
  "pricing",
  "preview",
  "relay",
  "root",
  "self-host",
  "staging",
  "static",
  "status",
  "support",
  "system",
  "tendril",
  "tendriller",
  "test",
  "webhooks",
  "ws",
]);

/** Whether an account's active plan permits named page subdomains. */
export function subdomainPlanAllowed(ent: Pick<AccountEntitlements, "unlimitedHost" | "quotas">): boolean {
  return ent.unlimitedHost || ent.quotas.customSubdomains === null || ent.quotas.customSubdomains > 0;
}

/** Validate and normalize a user- or agent-supplied page subdomain label. Returns null if invalid or reserved. */
export function normalizePageSubdomain(raw: string, env: Env): string | null {
  const slug = raw.trim().toLowerCase();
  if (!PAGE_SUBDOMAIN_RE.test(slug)) return null;
  // Disallow consecutive hyphens (blocks punycode `xn--` and branch preview `--p-...` suffixes).
  if (slug.includes("--")) return null;
  if (RESERVED_SUBDOMAINS.has(slug) || slug.startsWith("preview-")) return null;

  // Never allow colliding with the service host's own label when both share PAGE_BASE_DOMAIN.
  const pageBase = (env.PAGE_BASE_DOMAIN || "").toLowerCase();
  if (pageBase) {
    try {
      const serviceHost = new URL(publicBase(env)).hostname.toLowerCase();
      if (serviceHost.endsWith("." + pageBase)) {
        const serviceLabel = serviceHost.slice(0, -(pageBase.length + 1));
        if (serviceLabel === slug) return null;
      }
    } catch { /* ignore */ }
  }
  return slug;
}

/**
 * Routing lookups for `<label>.<PAGE_BASE_DOMAIN>`. Nearly every page request on
 * the standard pages domain is for a 12-character page ID, which is a miss here,
 * so absent labels are cached as well. Revocation window: another isolate keeps
 * routing a released or moved name to its previous page for at most 20 seconds,
 * and a newly claimed name may stay unresolved there for at most 10 seconds.
 * The page's Durable Object still authenticates every request it receives.
 */
const subdomainRows = new TtlCache<PageSubdomainRow | null>(20_000, 10_000, 2048);

export function invalidateSubdomainCache(): void { subdomainRows.clear(); }

/** Look up an active named subdomain for an incoming Worker request on `*.<PAGE_BASE_DOMAIN>`. */
export async function resolveSubdomainRequest(
  url: URL,
  env: Env,
): Promise<{ record: PageSubdomainRow; host: string; entitlementOk: boolean } | null> {
  if (!env.ACCOUNTS) return null;
  const label = parsePageHostLabel(url, env);
  if (!label) return null;
  const row = await subdomainRows.get(label, async () => {
    // A failed read is not cached as an absence.
    return await env.ACCOUNTS.prepare(
      "SELECT subdomain, account_id, tendril_id, created_at, updated_at FROM page_subdomains WHERE subdomain = ?",
    ).bind(label).first<PageSubdomainRow>();
  }, env.ACCOUNTS).catch(() => null);
  if (!row) return null;

  const ent = await cachedAccountEntitlements(env, row.account_id).catch(() => null);
  const entitlementOk = Boolean(ent && subdomainPlanAllowed(ent));
  return { record: row, host: url.hostname.toLowerCase(), entitlementOk };
}

/** Strict allow-list check used by `/auth/page` and enrollment so redirects/origins only target a live named subdomain bound to this exact page. */
export async function isActiveSubdomainForPage(
  env: Env,
  rawHost: string | null | undefined,
  tendrilId: string,
): Promise<string | null> {
  if (!env.ACCOUNTS || !rawHost) return null;
  const cleanHost = rawHost.trim().toLowerCase();
  if (!cleanHost || cleanHost.includes("/") || cleanHost.includes(":")) return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${cleanHost}/`);
  } catch {
    return null;
  }
  const label = parsePageHostLabel(parsed, env);
  if (!label) return null;
  const row = await env.ACCOUNTS.prepare(
    "SELECT account_id FROM page_subdomains WHERE subdomain = ? AND tendril_id = ?",
  ).bind(label, tendrilId).first<{ account_id: string }>().catch(() => null);
  if (!row) return null;
  const ent = await cachedAccountEntitlements(env, row.account_id).catch(() => null);
  if (!ent || !subdomainPlanAllowed(ent)) return null;
  return pageHostForLabel(env, label);
}

/** List all named subdomains owned by an account. */
export async function listAccountSubdomains(env: Env, accountId: string): Promise<PageSubdomainRow[]> {
  if (!env.ACCOUNTS) return [];
  const res = await env.ACCOUNTS.prepare(
    "SELECT subdomain, account_id, tendril_id, created_at, updated_at FROM page_subdomains WHERE account_id = ? ORDER BY created_at DESC",
  ).bind(accountId).all<PageSubdomainRow>();
  return res.results;
}

/** Fetch the named subdomain bound to a specific page (if any). */
export async function getPageSubdomain(env: Env, tendrilId: string): Promise<PageSubdomainRow | null> {
  if (!env.ACCOUNTS) return null;
  return await env.ACCOUNTS.prepare(
    "SELECT subdomain, account_id, tendril_id, created_at, updated_at FROM page_subdomains WHERE tendril_id = ?",
  ).bind(tendrilId).first<PageSubdomainRow>().catch(() => null);
}

/** Check whether a candidate subdomain name is syntactically valid and currently unclaimed. */
export async function checkSubdomainAvailability(
  env: Env,
  raw: string,
  excludeTendrilId?: string | null,
): Promise<{ subdomain: string | null; available: boolean; reason?: "invalid" | "in_use"; preview_url?: string }> {
  const slug = normalizePageSubdomain(raw, env);
  if (!slug) {
    return { subdomain: null, available: false, reason: "invalid" };
  }
  if (!env.ACCOUNTS) {
    return { subdomain: slug, available: false, reason: "in_use" };
  }
  const [takenSub, takenId] = await Promise.all([
    env.ACCOUNTS.prepare("SELECT tendril_id FROM page_subdomains WHERE subdomain = ?")
      .bind(slug).first<{ tendril_id: string }>(),
    env.ACCOUNTS.prepare("SELECT id FROM tendrils WHERE id = ?")
      .bind(slug).first<{ id: string }>(),
  ]);
  if (takenSub && takenSub.tendril_id !== excludeTendrilId) {
    return { subdomain: slug, available: false, reason: "in_use" };
  }
  if (takenId && takenId.id !== excludeTendrilId) {
    return { subdomain: slug, available: false, reason: "in_use" };
  }
  return {
    subdomain: slug,
    available: true,
    preview_url: barePageUrl(env, slug),
  };
}

function planRequiredSubdomainError(env: Env, plan: string): HttpError {
  const origin = publicBase(env);
  return new HttpError(
    402,
    "plan_required",
    "Named page subdomains require a paid plan (Pro or Team) or a self-hosted deployment.",
    {
      quota: "custom_subdomains",
      plan,
      used: 0,
      limit: 0,
      upgradeUrl: `${origin}/dashboard/billing`,
      pricingUrl: `${origin}/pricing`,
      selfHostUrl: `${origin}/self-host`,
    },
  );
}

/** Pre-validate a requested subdomain before allocating a new page (for `POST /api/agent/pages`). */
export async function validateSubdomainForNewPage(
  env: Env,
  accountId: string,
  rawSubdomain: string,
): Promise<string> {
  if (!env.ACCOUNTS) throw new HttpError(503, "unavailable", "Accounts database is not configured");
  const slug = normalizePageSubdomain(rawSubdomain, env);
  if (!slug) {
    throw new HttpError(
      400,
      "invalid_subdomain",
      "Use 3–45 lowercase letters, numbers, or single hyphens (cannot start or end with a hyphen or use reserved names).",
    );
  }
  const ent = await getAccountEntitlements(env, accountId);
  if (!subdomainPlanAllowed(ent)) {
    throw planRequiredSubdomainError(env, ent.plan);
  }
  const [takenSub, takenId, countRow] = await Promise.all([
    env.ACCOUNTS.prepare("SELECT tendril_id FROM page_subdomains WHERE subdomain = ?").bind(slug).first(),
    env.ACCOUNTS.prepare("SELECT id FROM tendrils WHERE id = ?").bind(slug).first(),
    !ent.unlimitedHost && ent.quotas.customSubdomains !== null
      ? env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM page_subdomains WHERE account_id = ?").bind(accountId).first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  if (takenSub || takenId) {
    throw new HttpError(409, "subdomain_in_use", `The subdomain "${slug}" is already taken. Choose another unique name.`);
  }
  if (!ent.unlimitedHost && ent.quotas.customSubdomains !== null) {
    const used = countRow?.n ?? 0;
    if (used >= ent.quotas.customSubdomains) {
      throw quotaError({
        env,
        quota: "custom_subdomains",
        plan: ent.plan,
        used,
        limit: ent.quotas.customSubdomains,
        resetsAt: null,
        message: `Your ${ent.plan} plan includes up to ${ent.quotas.customSubdomains} named page subdomains. Remove an unused subdomain, upgrade, or self-host.`,
        localAlternative: "Your page stays accessible at its default generated URL; remove an unused named subdomain to free a slot.",
      });
    }
  }
  return slug;
}

/**
 * Assign, rename, reassign/swap, or remove (`rawSubdomain = null | ""`) a page's named subdomain.
 * Atomically updates D1 (`page_subdomains`) and mirrors the subdomain onto the affected page Durable Object(s).
 */
export async function setPageSubdomain(
  env: Env,
  accountId: string,
  tendrilId: string,
  rawSubdomain: string | null,
  by: string,
  options: SetSubdomainOptions = {},
): Promise<SubdomainUpdateResult> {
  // This isolate observes its own binding changes at once, including on failure paths.
  try { return await updatePageSubdomain(env, accountId, tendrilId, rawSubdomain, by, options); }
  finally { subdomainRows.clear(); }
}

async function updatePageSubdomain(
  env: Env,
  accountId: string,
  tendrilId: string,
  rawSubdomain: string | null,
  by: string,
  options: SetSubdomainOptions,
): Promise<SubdomainUpdateResult> {
  if (!env.ACCOUNTS) throw new HttpError(503, "unavailable", "Accounts database is not configured");
  if (!TENDRIL_ID_RE.test(tendrilId)) {
    throw new HttpError(400, "invalid_page", "Select a valid page.");
  }

  const page = await env.ACCOUNTS.prepare(
    "SELECT id FROM tendrils WHERE id = ? AND owner_account = ? AND state = 'active'",
  ).bind(tendrilId, accountId).first<{ id: string }>();
  if (!page) throw new HttpError(404, "not_found", "Page not found in your account.");

  const syncDo = async (targetId: string, subdomain: string | null): Promise<SubdomainUpdateResult> => {
    const stub = env.TENDRIL.get(env.TENDRIL.idFromName(targetId));
    const res = await stub.fetch(new Request("https://tendril.internal/account/subdomain", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-account-id": accountId,
      },
      body: JSON.stringify({ subdomain, by }),
    }));
    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new HttpError(res.status, err?.error?.code ?? "unavailable", err?.error?.message ?? "Could not update page subdomain.");
    }
    return await res.json() as SubdomainUpdateResult;
  };

  // Clearing a subdomain is always permitted (even after a downgrade to Free).
  if (rawSubdomain === null || rawSubdomain.trim() === "") {
    await env.ACCOUNTS.prepare("DELETE FROM page_subdomains WHERE tendril_id = ? AND account_id = ?")
      .bind(tendrilId, accountId).run();
    return await syncDo(tendrilId, null);
  }

  const slug = normalizePageSubdomain(rawSubdomain, env);
  if (!slug) {
    throw new HttpError(
      400,
      "invalid_subdomain",
      "Use 3–45 lowercase letters, numbers, or single hyphens (cannot start or end with a hyphen or use reserved names).",
    );
  }

  const ent = await getAccountEntitlements(env, accountId);
  if (!subdomainPlanAllowed(ent)) {
    throw planRequiredSubdomainError(env, ent.plan);
  }

  const existingForPage = await env.ACCOUNTS.prepare(
    "SELECT subdomain, created_at FROM page_subdomains WHERE tendril_id = ?",
  ).bind(tendrilId).first<{ subdomain: string; created_at: number }>();

  if (existingForPage?.subdomain === slug) {
    return await syncDo(tendrilId, slug);
  }

  const [takenSub, takenId] = await Promise.all([
    env.ACCOUNTS.prepare("SELECT tendril_id, account_id, created_at FROM page_subdomains WHERE subdomain = ?")
      .bind(slug).first<{ tendril_id: string; account_id: string; created_at: number }>(),
    env.ACCOUNTS.prepare("SELECT id FROM tendrils WHERE id = ?").bind(slug).first<{ id: string }>(),
  ]);
  if (takenId && takenId.id !== tendrilId) {
    throw new HttpError(409, "subdomain_in_use", `The subdomain "${slug}" is already taken. Choose another unique name.`);
  }

  const canReassign = Boolean(options.reassign || options.swap);
  let displaced: { tendril_id: string; created_at: number } | null = null;
  if (takenSub && takenSub.tendril_id !== tendrilId) {
    if (takenSub.account_id !== accountId) {
      throw new HttpError(409, "subdomain_in_use", `The subdomain "${slug}" is already taken. Choose another unique name.`);
    }
    if (!canReassign) {
      throw new HttpError(
        409,
        "subdomain_in_use",
        `The subdomain "${slug}" is already assigned to your page ${takenSub.tendril_id}. Pass reassign: true (or use Move in Domains) to move it atomically.`,
        { existing_tendril_id: takenSub.tendril_id, owned_by_account: true },
      );
    }
    if (options.authorizeDisplacedPage) {
      await options.authorizeDisplacedPage(takenSub.tendril_id);
    }
    displaced = { tendril_id: takenSub.tendril_id, created_at: takenSub.created_at };
  }

  // Reassigning an existing name from another page in this account never increases the account's slot count.
  if (!existingForPage && !displaced && !ent.unlimitedHost && ent.quotas.customSubdomains !== null) {
    const usedRow = await env.ACCOUNTS.prepare(
      "SELECT COUNT(*) AS n FROM page_subdomains WHERE account_id = ?",
    ).bind(accountId).first<{ n: number }>();
    const used = usedRow?.n ?? 0;
    if (used >= ent.quotas.customSubdomains) {
      throw quotaError({
        env,
        quota: "custom_subdomains",
        plan: ent.plan,
        used,
        limit: ent.quotas.customSubdomains,
        resetsAt: null,
        message: `Your ${ent.plan} plan includes up to ${ent.quotas.customSubdomains} named page subdomains. Remove an unused subdomain, upgrade, or self-host.`,
        localAlternative: "Your page stays accessible at its default generated URL; remove an unused named subdomain to free a slot.",
      });
    }
  }

  const now = Date.now();
  const swappedSubdomain = displaced && options.swap && existingForPage ? existingForPage.subdomain : null;

  try {
    if (displaced && swappedSubdomain && existingForPage) {
      // Atomic 2-page swap in a single D1 batch transaction: neither name is ever unbound.
      await env.ACCOUNTS.batch([
        env.ACCOUNTS.prepare("DELETE FROM page_subdomains WHERE tendril_id IN (?, ?) AND account_id = ?")
          .bind(tendrilId, displaced.tendril_id, accountId),
        env.ACCOUNTS.prepare("INSERT INTO page_subdomains (subdomain, account_id, tendril_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(slug, accountId, tendrilId, displaced.created_at, now),
        env.ACCOUNTS.prepare("INSERT INTO page_subdomains (subdomain, account_id, tendril_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(swappedSubdomain, accountId, displaced.tendril_id, existingForPage.created_at, now),
      ]);
    } else if (displaced && existingForPage) {
      // Atomic move onto a page that already held another name: release target's old name & move `slug` in one transaction.
      await env.ACCOUNTS.batch([
        env.ACCOUNTS.prepare("DELETE FROM page_subdomains WHERE tendril_id = ? AND account_id = ?")
          .bind(tendrilId, accountId),
        env.ACCOUNTS.prepare("UPDATE page_subdomains SET tendril_id = ?, updated_at = ? WHERE subdomain = ? AND account_id = ? AND tendril_id = ?")
          .bind(tendrilId, now, slug, accountId, displaced.tendril_id),
      ]);
    } else if (displaced) {
      // Atomic move from displaced page -> target page with zero gap.
      const res = await env.ACCOUNTS.prepare(
        "UPDATE page_subdomains SET tendril_id = ?, updated_at = ? WHERE subdomain = ? AND account_id = ? AND tendril_id = ? RETURNING subdomain",
      ).bind(tendrilId, now, slug, accountId, displaced.tendril_id).first();
      if (!res) {
        throw new HttpError(409, "subdomain_in_use", `The subdomain "${slug}" changed concurrently. Retry the request.`);
      }
    } else if (existingForPage) {
      await env.ACCOUNTS.prepare(
        "UPDATE page_subdomains SET subdomain = ?, updated_at = ? WHERE tendril_id = ? AND account_id = ?",
      ).bind(slug, now, tendrilId, accountId).run();
    } else {
      await env.ACCOUNTS.prepare(
        "INSERT INTO page_subdomains (subdomain, account_id, tendril_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(slug, accountId, tendrilId, now, now).run();
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (String(err).includes("UNIQUE")) {
      throw new HttpError(409, "subdomain_in_use", `The subdomain "${slug}" is already taken. Choose another unique name.`);
    }
    throw err;
  }

  try {
    const targetResult = await syncDo(tendrilId, slug);
    if (displaced) {
      await syncDo(displaced.tendril_id, swappedSubdomain);
    }
    return {
      ...targetResult,
      ...(displaced ? { previous_tendril_id: displaced.tendril_id } : {}),
      ...(swappedSubdomain ? { swapped_subdomain: swappedSubdomain } : {}),
    };
  } catch (err) {
    // Roll back D1 if DO sync fails so D1 and DO stay consistent.
    if (displaced) {
      const restoreStmts = [
        env.ACCOUNTS.prepare("DELETE FROM page_subdomains WHERE tendril_id IN (?, ?) AND account_id = ?")
          .bind(tendrilId, displaced.tendril_id, accountId),
        env.ACCOUNTS.prepare("INSERT INTO page_subdomains (subdomain, account_id, tendril_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(slug, accountId, displaced.tendril_id, displaced.created_at, now),
        ...(existingForPage
          ? [env.ACCOUNTS.prepare("INSERT INTO page_subdomains (subdomain, account_id, tendril_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
              .bind(existingForPage.subdomain, accountId, tendrilId, existingForPage.created_at, now)]
          : []),
      ];
      await env.ACCOUNTS.batch(restoreStmts).catch(() => {});
      await syncDo(tendrilId, existingForPage?.subdomain ?? null).catch(() => {});
      await syncDo(displaced.tendril_id, slug).catch(() => {});
    } else if (existingForPage) {
      await env.ACCOUNTS.prepare(
        "UPDATE page_subdomains SET subdomain = ?, updated_at = ? WHERE tendril_id = ? AND account_id = ?",
      ).bind(existingForPage.subdomain, now, tendrilId, accountId).run().catch(() => {});
    } else {
      await env.ACCOUNTS.prepare("DELETE FROM page_subdomains WHERE tendril_id = ? AND subdomain = ?")
        .bind(tendrilId, slug).run().catch(() => {});
    }
    throw err;
  }
}
