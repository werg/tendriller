/**
 * Entitlement check helper for Issue #136 OAuth features.
 * Delegates directly to `server/src/billing/entitlements.ts` (`getAccountEntitlements`) as the single
 * source of truth for plan tier, `past_due` grace periods, admin overrides, and self-hosted unlimited mode:
 * - Tier A (`agent-held`): always included on every plan (Free, Pro, Team, Self-Hosted).
 * - Tier B (`host-brokered`, `personal` custody): requires `quotas.hostBrokeredOAuth` (Pro, Team, Unlimited/Self-Hosted).
 * - Tier B (`host-brokered`, `page` shared team custody) & GitHub/Google Org/Team group admission:
 *   requires `quotas.teamOrgOAuth` (Team, Unlimited/Self-Hosted).
 */
import type { Env } from '../env';
import { HttpError } from '../http';
import { getAccountEntitlements } from '../billing/entitlements';
import type { PlanId } from '../billing/plans';

export interface OAuthEntitlements {
  plan: PlanId;
  hostBrokeredOAuth: boolean;
  teamOrgOAuth: boolean;
  inGracePeriod: boolean;
}

export async function resolveOAuthEntitlements(env: Env, accountId: string, now = Date.now()): Promise<OAuthEntitlements> {
  const ent = await getAccountEntitlements(env, accountId, now);
  return {
    plan: ent.unlimitedHost ? 'unlimited' : ent.plan,
    hostBrokeredOAuth: ent.unlimitedHost || ent.quotas.hostBrokeredOAuth,
    teamOrgOAuth: ent.unlimitedHost || ent.quotas.teamOrgOAuth,
    inGracePeriod: ent.inGracePeriod,
  };
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
