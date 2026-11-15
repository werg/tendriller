// Provision an environment after its domains are active on Cloudflare.
// --name selects independent Worker/D1/R2 resources; --fresh refuses existing
// resources and requires separate service and page origins. Nothing is reset.
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function deploymentPlan(stage, { name, fresh = false } = {}, env = process.env, current = {}) {
  if (stage !== 'production' && stage !== 'staging') throw Error('Pass production or staging');
  const defaultName = `tendriller-${stage}`, worker = name ?? defaultName;
  if (!/^[a-z][a-z0-9-]{1,52}[a-z0-9]$/.test(worker)) throw Error('Deployment name must be 3–54 lowercase letters, digits or hyphens, beginning with a letter and ending with a letter or digit.');
  const prefix = stage.toUpperCase();
  const serviceURL = new URL(env[`${prefix}_PUBLIC_BASE`] ?? (stage === 'production' ? 'https://tendriller.dev' : 'https://staging.tendriller.dev'));
  if (serviceURL.protocol !== 'https:' || serviceURL.pathname !== '/' || serviceURL.search || serviceURL.hash || serviceURL.username || serviceURL.password || serviceURL.port)
    throw Error('The service base must be an HTTPS origin without a path, port or credentials.');
  const service = serviceURL.hostname;
  const zone = stage === 'production' ? 'tendriller.site' : 'tendriller.dev';
  const pages = env[`${prefix}_PAGE_BASE_DOMAIN`] ?? zone;
  const suffix = env[`${prefix}_PAGE_HOST_SUFFIX`] ?? '';
  if (pages !== zone && !pages.endsWith(`.${zone}`)) throw Error(`Page domain must be in ${zone}`);
  if (!pages.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw Error('Invalid page domain');
  if (service === pages) throw Error('Configure separate service and page domains.');
  if (suffix && !/^--[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(suffix)) throw Error('A page host suffix must start with -- and contain lowercase letters, digits or hyphens.');
  const database = `${worker}-accounts`, bucket = `${worker}-files`;
  if (fresh) {
    if (!name || ['tendriller-staging', 'tendriller-production', current.name].includes(worker)) throw Error('--fresh needs a new explicit --name, distinct from the configured deployment.');
    if (current.d1_databases?.some(binding => binding.database_name === database) || current.r2_buckets?.some(binding => binding.bucket_name === bucket))
      throw Error('A fresh deployment cannot reuse configured storage resources.');
    const oldService = current.vars?.PUBLIC_BASE ?? (stage === 'production' ? 'https://tendriller.dev' : 'https://staging.tendriller.dev');
    const oldPages = current.vars?.PAGE_BASE_DOMAIN ?? zone, oldSuffix = current.vars?.PAGE_HOST_SUFFIX ?? '';
    if (serviceURL.origin === new URL(oldService).origin || (pages === oldPages && suffix === oldSuffix))
      throw Error('--fresh requires separate service and page origins; set the stage PUBLIC_BASE and PAGE_HOST_SUFFIX or PAGE_BASE_DOMAIN.');
  }
  return { stage, worker, database, bucket, service, pages, suffix, zone, fresh,
    configPath: `server/wrangler.${name ?? stage}.jsonc` };
}

function missing(error, code) { return new RegExp(`\\b${code}\\b`).test(String(error.stderr ?? '') + String(error.stdout ?? '') + String(error.message ?? '')); }
function exists(wrangler, args, missingCode) {
  try { wrangler(...args); return true; }
  catch (error) { if (missing(error, missingCode)) return false; throw error; }
}

export function provisionResources(plan, wrangler) {
  const databases = JSON.parse(wrangler('d1', 'list', '--json'));
  let database = databases.find(value => value.name === plan.database);
  const bucketExists = exists(wrangler, ['r2', 'bucket', 'info', plan.bucket, '--json'], 10006);
  if (plan.fresh) {
    const workerExists = exists(wrangler, ['deployments', 'list', '--name', plan.worker, '--json'], 10007);
    if (database || bucketExists || workerExists) throw Error('Fresh deployment resources already exist. Choose a new name; no resources were changed.');
  }
  if (!database) {
    wrangler('d1', 'create', plan.database);
    database = JSON.parse(wrangler('d1', 'list', '--json')).find(value => value.name === plan.database);
    if (!database) throw Error(`Wrangler created ${plan.database} but did not list it`);
  }
  if (!bucketExists) wrangler('r2', 'bucket', 'create', plan.bucket);
  return database.uuid;
}

export function deploymentConfig(plan, databaseId, account) {
  return {
    $schema: '../node_modules/wrangler/config-schema.json', name: plan.worker,
    main: '../dist/service/worker.mjs', compatibility_date: '2026-11-01', compatibility_flags: ['nodejs_compat'],
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: true },
    durable_objects: { bindings: [{ name: 'TENDRIL', class_name: 'TendrilV2' }, { name: 'ADMISSION', class_name: 'Admission' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TendrilV2'] }, { tag: 'v2', new_sqlite_classes: ['Admission'] }],
    d1_databases: [{ binding: 'ACCOUNTS', database_name: plan.database, database_id: databaseId, migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: plan.bucket }], triggers: { crons: ['*/15 * * * *'] },
    ratelimits: [
      ['CREATE_RATE', '101', 5], ['AGENT_RATE', '102', 300], ['EVAL_RATE', '103', 60], ['AUTH_RATE', '104', 20],
      ['FAILED_AUTH_RATE', '105', 20], ['REPORT_RATE', '106', 5], ['FILE_READ_RATE', '108', 120],
    ].map(([name, namespace_id, limit]) => ({ name, namespace_id, simple: { limit, period: 60 } })),
    vars: { PUBLIC_BASE: `https://${plan.service}`, PAGE_BASE_DOMAIN: plan.pages, ...(plan.suffix ? { PAGE_HOST_SUFFIX: plan.suffix } : {}), CLOUDFLARE_ACCOUNT_ID: account },
    routes: [{ pattern: plan.service, custom_domain: true }, { pattern: `*${plan.suffix}.${plan.pages}/*`, zone_name: plan.zone }],
    observability: { enabled: true },
  };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, fresh: { type: 'boolean', default: false } } });
  if (positionals.length !== 1) throw Error('Usage: node scripts/provision.mjs staging|production [--name <deployment>] [--fresh]');
  const stage = positionals[0];
  if (stage !== 'production' && stage !== 'staging') throw Error('Pass production or staging');
  const { experimental_readRawConfig } = createRequire(import.meta.url)('wrangler');
  const current = experimental_readRawConfig({ config: `server/wrangler.${stage}.jsonc` }).rawConfig;
  const plan = deploymentPlan(stage, values, process.env, current);
  const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = JSON.parse(wrangler('whoami', '--json'));
  if (!identity.loggedIn) throw Error('Run npx wrangler login before provisioning');
  const accounts = identity.accounts ?? [], account = process.env.CLOUDFLARE_ACCOUNT_ID ?? (accounts.length === 1 ? accounts[0].id : null);
  if (!account || !accounts.some(value => value.id === account)) throw Error('Set CLOUDFLARE_ACCOUNT_ID to one of the accounts in npx wrangler whoami --json');
  const databaseId = provisionResources(plan, wrangler);
  await writeFile(plan.configPath, JSON.stringify(deploymentConfig(plan, databaseId, account), null, 2) + '\n');
  console.log(`Wrote ${plan.configPath} for ${plan.worker}. Configure DNS/certificates for ${plan.service} and *${plan.suffix}.${plan.pages}; run D1 migrations, install runtime resources and secrets, then deploy this config. Canonical service configs were not switched.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
