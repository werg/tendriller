import type { Env } from './env';
import { assistantOAuth } from './assistant-shared';
import { activeGrant, scopesOf } from './accounts/oauth-data';

/** A setup binding retains its admitting grant, never an account-wide credential. */
export async function setupCredentialActive(env: Env, row: {
  account_id: string; client_id: string; grant_id: string; service_origin: string; expires_at: number;
}): Promise<boolean> {
  const config = await assistantOAuth(env);
  if (!config || config.issuer !== row.service_origin || row.expires_at <= Date.now()) return false;
  const grant = await activeGrant(env, config, row.grant_id, row.account_id);
  return !!grant && grant.client_id === row.client_id && scopesOf(grant).includes('tendrils:create');
}
