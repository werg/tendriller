// Create a dedicated sample account and retain its reusable private access link.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' },
  days: { type: 'string', default: '30' }, revoke: { type: 'boolean', default: false } } });
if (!values.config || !values.output) throw Error('Pass --config server/wrangler.<environment>.jsonc --output /private/path/test-access.json [--days 30] [--revoke]');
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 90) throw Error('Choose 1 to 90 days');
const configPath = resolve(values.config), output = resolve(values.output);
const { rawConfig } = createRequire(import.meta.url)('wrangler').experimental_readRawConfig({ config: configPath });
const origin = rawConfig.vars.PUBLIC_BASE;
if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw Error('Choose an HTTPS service deployment');
const run = (args, input) => {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', configPath],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw Error('Wrangler failed. No credentials were printed. Check deployment access and retry with the same private output file.');
};
let record;
try { record = JSON.parse(readFileSync(output, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT' || values.revoke) throw error;
  const token = randomBytes(32).toString('base64url');
  record = { origin, accountId: 'test_' + randomBytes(16).toString('hex'),
    tokenSha256: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + days * 86400000,
    url: `${origin}/auth/test#token=${token}` };
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
}
if (record.origin !== origin || !/^test_[a-f0-9]{32}$/.test(record.accountId) || !/^[a-f0-9]{64}$/.test(record.tokenSha256) ||
    !Number.isSafeInteger(record.expiresAt)) throw Error('Private record does not match this deployment');
if (values.revoke) {
  run(['secret', 'bulk'], JSON.stringify({ TEST_ACCESS_JSON: null }));
  run(['d1', 'execute', 'ACCOUNTS', '--remote', '--command', `DELETE FROM sessions WHERE account_id='${record.accountId}';
    UPDATE accounts SET suspended_at=${Date.now()} WHERE id='${record.accountId}';
    UPDATE integration_oauth_grants SET revoked_at=${Date.now()} WHERE account_id='${record.accountId}' AND revoked_at IS NULL;`]);
  console.log('Test access revoked, including its browser sessions and OAuth grants.');
} else {
  if (record.expiresAt <= Date.now()) throw Error('Saved test access expired. Revoke it and provision a new private record.');
  const now = Date.now(), id = record.accountId;
  run(['d1', 'execute', 'ACCOUNTS', '--remote', '--command', `
    INSERT INTO accounts(id,created_at,email) VALUES('${id}',${now},'${id}@example.invalid') ON CONFLICT(id) DO NOTHING;
    INSERT INTO identities(provider,subject,account_id,login,email,created_at)
      VALUES('test','${id}','${id}','Sample account','${id}@example.invalid',${now}) ON CONFLICT(provider,subject) DO NOTHING;
    INSERT INTO identity_emails(provider,subject,email) VALUES('test','${id}','${id}@example.invalid') ON CONFLICT DO NOTHING;`]);
  run(['secret', 'bulk'], JSON.stringify({ TEST_ACCESS_JSON: JSON.stringify({
    accountId: id, tokenSha256: record.tokenSha256, expiresAt: record.expiresAt,
  }) }));
  console.log(`Test account provisioned. Private link saved in ${output}. Expires ${new Date(record.expiresAt).toISOString()}.`);
}
