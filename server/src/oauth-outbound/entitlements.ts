/**
 * Entitlement check helper for Issue #136 OAuth features.
 * Matches `server/src/billing/entitlements.ts` and `server/src/billing/plans.ts` 1:1
 * (including `subscriptions` past_due grace-period handling and unlimited self-hosted mode):
 * - Tier A (`agent-held`): always included on every plan (Free, Pro, Team, Self-Hosted).
 * - Tier B (`host-brokered`, `personal` custody): requires `hostBrokeredOAuth` (Pro, Team, Unlimited/Self-Hosted).
 * - Tier B (`host-brokered`, `page` shared team custody) & GitHub/Google Org/Team group admission:
 *   requires `teamOrgOAuth` (Team, Unlimited/Self-Hosted).
 * On localhost / self-hosted unlimited hosts (NULL service_state caps) or pre-billing schemas, all features are open.
 */
import type { Env } from '../env';
import { HttpError } from '../http';

export interface OAuthEntitlements {
  plan: 'free' | 'pro' | 'team' | 'unlimited';
  hostBrokeredOAuth: boolean;
  teamOrgOAuth: boolean;
  inGracePeriod: boolean;
}

/** Optional external billing resolver hook (populated automatically if billing module registers itself). */
export type BillingEntitlementResolver = (
  env: Env,
  accountId: string,
  now?: number,
) => Promise<{
  plan: 'free' | 'pro' | 'team' | 'unlimited';
  unlimitedHost: boolean;
  inGracePeriod: boolean;
  quotas: { hostBrokeredOAuth: boolean; teamOrgOAuth: boolean };
}>;

let externalResolver: BillingEntitlementResolver | null = null;

/** Register the unified `server/src/billing/entitlements.ts` resolver once both branches are merged. */
export function setBillingEntitlementResolver(resolver: BillingEntitlementResolver | null): void {
  externalResolver = resolver;
}

export async function resolveOAuthEntitlements(env: Env, accountId: string, now = Date.now()): Promise<OAuthEntitlements> {
  if (externalResolver) {
    const resolved = await externalResolver(env, accountId, now);
    return {
      plan: resolved.unlimitedHost ? 'unlimited' : resolved.plan,
      hostBrokeredOAuth: resolved.unlimitedHost || resolved.quotas.hostBrokeredOAuth,
      teamOrgOAuth: resolved.unlimitedHost || resolved.quotas.teamOrgOAuth,
      inGracePeriod: resolved.inGracePeriod,
    };
  }
  if (!env.ACCOUNTS) {
    return { plan: 'unlimited', hostBrokeredOAuth: true, teamOrgOAuth: true, inGracePeriod: false };
  }
  const [caps, row, sub] = await Promise.all([
    env.ACCOUNTS.prepare('SELECT account_page_cap, account_resident_cap, account_storage_cap FROM service_state WHERE id = 1')
      .first<{ account_page_cap: number | null; account_resident_cap: number | null; account_storage_cap: number | null }>()
      .catch(() => null),
    env.ACCOUNTS.prepare('SELECT plan FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ plan?: string | null }>()
      .catch(() => null),
    env.ACCOUNTS.prepare('SELECT status, grace_until FROM subscriptions WHERE account_id = ?')
      .bind(accountId)
      .first<{ status?: string | null; grace_until?: number | null }>()
      .catch(() => null),
  ]);

  const unlimitedHost =
    caps !== null &&
    caps.account_page_cap === null &&
    caps.account_resident_cap === null &&
    caps.account_storage_cap === null;

  if (unlimitedHost) {
    return { plan: 'unlimited', hostBrokeredOAuth: true, teamOrgOAuth: true, inGracePeriod: false };
  }

  // If the billing migration (`0005_billing_and_tiers.sql`) isn't applied yet, keep OAuth features unlocked.
  if (!row || typeof row.plan !== 'string') {
    return { plan: 'unlimited', hostBrokeredOAuth: true, teamOrgOAuth: true, inGracePeriod: false };
  }

  let effectivePlan = row.plan;
  let inGracePeriod = false;
  if (sub && sub.status === 'past_due') {
    if (typeof sub.grace_until === 'number' && sub.grace_until > now) {
      inGracePeriod = true;
    } else if (effectivePlan !== 'unlimited') {
      // Grace period expired: match `billing/entitlements.ts` and drop effective entitlements to Free.
      effectivePlan = 'free';
    }
  } else if (sub && (sub.status === 'canceled' || sub.status === 'revoked') && effectivePlan !== 'unlimited') {
    effectivePlan = 'free';
  }

  switch (effectivePlan) {
    case 'unlimited':
    case 'team':
      return { plan: effectivePlan, hostBrokeredOAuth: true, teamOrgOAuth: true, inGracePeriod };
    case 'pro':
      return { plan: 'pro', hostBrokeredOAuth: true, teamOrgOAuth: false, inGracePeriod };
    default:
      return { plan: 'free', hostBrokeredOAuth: false, teamOrgOAuth: false, inGracePeriod };
  }
}

export async function requireHostBrokeredEntitlement(env: Env, accountId: string, custody: 'personal' | 'page'): Promise<void> {
  const ent = await resolveOAuthEntitlements(env, accountId);
  if (custody === 'page' && !ent.teamOrgOAuth) {
    throw new HttpError(402, 'plan_upgrade_required', 'Shared team (page-custody) host-brokered OAuth connections require the Team plan.', {
      feature: 'team_org_oauth',
      required_plan: 'team',
      current_plan: ent.plan,
    });
  }
  if (!ent.hostBrokeredOAuth) {
    throw new HttpError(402, 'plan_upgrade_required', 'Host-brokered wrapped OAuth connections require Pro or Team. Zero-trust agent-held connections are free on every plan.', {
      feature: 'host_brokered_oauth',
      required_plan: 'pro',
      current_plan: ent.plan,
    });
  }
}

export async function requireTeamOrgEntitlement(env: Env, accountId: string): Promise<void> {
  const ent = await resolveOAuthEntitlements(env, accountId);
  if (!ent.teamOrgOAuth) {
    throw new HttpError(402, 'plan_upgrade_required', 'GitHub Organization/Team and Google Workspace group admission require the Team plan.', {
      feature: 'team_org_oauth',
      required_plan: 'team',
      current_plan: ent.plan,
    });
  }
}
