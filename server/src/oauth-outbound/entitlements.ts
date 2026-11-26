/**
 * Entitlement check helper for Issue #136 OAuth features.
 * Aligns 1:1 with `server/src/billing/plans.ts`:
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
}

export async function resolveOAuthEntitlements(env: Env, accountId: string): Promise<OAuthEntitlements> {
  if (!env.ACCOUNTS) {
    return { plan: 'unlimited', hostBrokeredOAuth: true, teamOrgOAuth: true };
  }
  const caps = await env.ACCOUNTS.prepare(
    'SELECT account_page_cap, account_resident_cap, account_storage_cap FROM service_state WHERE id = 1',
  ).first<{ account_page_cap: number | null; account_resident_cap: number | null; account_storage_cap: number | null }>().catch(() => null);

  const unlimitedHost =
    caps !== null &&
    caps.account_page_cap === null &&
    caps.account_resident_cap === null &&
    caps.account_storage_cap === null;

  if (unlimitedHost) {
    return { plan: 'unlimited', hostBrokeredOAuth: true, teamOrgOAuth: true };
  }

  // Defensively read `accounts.plan` (added by 0005_billing_and_tiers.sql). If the billing
  // migration isn't present yet on this host, keep OAuth features unlocked rather than crashing.
  const row = await env.ACCOUNTS.prepare('SELECT plan FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ plan?: string | null }>()
    .catch(() => null);

  if (!row || typeof row.plan !== 'string') {
    return { plan: 'unlimited', hostBrokeredOAuth: true, teamOrgOAuth: true };
  }

  switch (row.plan) {
    case 'unlimited':
    case 'team':
      return { plan: row.plan, hostBrokeredOAuth: true, teamOrgOAuth: true };
    case 'pro':
      return { plan: 'pro', hostBrokeredOAuth: true, teamOrgOAuth: false };
    default:
      return { plan: 'free', hostBrokeredOAuth: false, teamOrgOAuth: false };
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
