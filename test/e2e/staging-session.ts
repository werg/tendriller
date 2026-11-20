import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { BrowserContext } from '@playwright/test';
import { preflightStaging, STAGING_ORIGIN } from '../../scripts/staging-preflight.mjs';

export const staging = STAGING_ORIGIN;

function writeStaging(sql: string) {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute',
    'ACCOUNTS', '--remote', '--config', 'server/wrangler.staging.jsonc',
    '--command', sql], { stdio: 'pipe', timeout: 45_000 });
}

/** Provision an ordinary, short-lived service session for an isolated fixture owner. */
export async function stagingSession({ preflight = preflightStaging, write = writeStaging } = {}) {
  // Direct Playwright invocation must have the same gate as the workflow wrapper.
  await preflight();
  const id = randomUUID();
  const email = `e2e-${id}@example.test`;
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const started = Date.now();
  const expires = started + 15 * 60_000;
  const removeAccount = () => write(`DELETE FROM accounts WHERE id = '${id}' AND NOT EXISTS
    (SELECT 1 FROM tendrils WHERE owner_account = '${id}');`);
  try {
    write(`
    INSERT INTO accounts (id, created_at, email) VALUES ('${id}', ${started}, '${email}');
    INSERT INTO identities (provider, subject, account_id, login, email, created_at)
      VALUES ('e2e', '${id}', '${id}', 'Staging test account', '${email}', ${started});
    INSERT INTO identity_emails (provider, subject, email) VALUES ('e2e', '${id}', '${email}');
    INSERT INTO sessions (hash, account_id, created_at, expires_at)
      VALUES ('${hash}', '${id}', ${started}, ${expires});
    `);
  } catch {
    try { removeAccount(); }
    catch { throw new Error(`Staging fixture provisioning and cleanup failed for account ${id}`); }
    throw new Error(`Staging fixture provisioning failed for account ${id}`);
  }
  return {
    id,
    email,
    async signIn(context: BrowserContext) {
      await context.addCookies([{ name: '__Host-tendriller', value: token, url: staging,
        httpOnly: true, secure: true, sameSite: 'Lax', expires: Math.floor(expires / 1000) }]);
    },
    close: removeAccount,
  };
}
