// Provision one isolated environment after its domains are active on Cloudflare.
// Uses the local Wrangler login. CLOUDFLARE_ACCOUNT_ID selects an account when
// Wrangler is logged in to more than one.
// Production: node scripts/provision.mjs production
// Staging: STAGING_PUBLIC_BASE=https://... STAGING_PAGE_BASE_DOMAIN=... node scripts/provision.mjs staging
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const stage = process.argv[2];
if (stage !== "production" && stage !== "staging") throw new Error("Pass production or staging");
function wrangler(...args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const identity = JSON.parse(wrangler("whoami", "--json"));
if (!identity.loggedIn) throw new Error("Run npx wrangler login before provisioning");
const accounts = identity.accounts ?? [];
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? (accounts.length === 1 ? accounts[0].id : null);
if (!account || !accounts.some(a => a.id === account)) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID to one of the accounts in npx wrangler whoami --json");
}
const service = stage === "production" ? "tendriller.dev" : new URL(process.env.STAGING_PUBLIC_BASE ?? "https://staging.tendriller.dev").hostname;
const pages = stage === "production" ? "tendriller.site" : process.env.STAGING_PAGE_BASE_DOMAIN ?? "tendriller.dev";
if (!service || !pages || service === pages) throw new Error("Configure separate service and pages domains for this stage");
if (stage === "staging" && pages === "tendriller.site") throw new Error("Staging needs its own pages zone so it cannot route production pages");
function d1(name) {
  const existing = JSON.parse(wrangler("d1", "list", "--json"));
  const found = existing.find(d => d.name === name);
  if (found) return found.uuid;
  wrangler("d1", "create", name);
  const created = JSON.parse(wrangler("d1", "list", "--json")).find(d => d.name === name);
  if (!created) throw new Error(`Wrangler created ${name} but did not list it`);
  return created.uuid;
}

function bucket(name) {
  try {
    wrangler("r2", "bucket", "info", name, "--json");
  } catch (error) {
    if (!String(error.stderr ?? "").includes("10006")) throw error;
    wrangler("r2", "bucket", "create", name);
  }
}

const pageZoneName = stage === "production" ? "tendriller.site" : "tendriller.dev";
if (pages !== pageZoneName && !pages.endsWith(`.${pageZoneName}`)) throw new Error(`Page domain must be in ${pageZoneName}`);
const dbName = `tendriller-${stage}-accounts`;
const bucketName = `tendriller-${stage}-files`;
const databaseId = d1(dbName);
bucket(bucketName);
const wildcard = `*.${pages}`;

const worker = `tendriller-${stage}`;
const config = {
  $schema: "../node_modules/wrangler/config-schema.json",
  name: worker,
  main: "src/index.ts",
  compatibility_date: "2026-11-01",
  compatibility_flags: ["nodejs_compat"],
  assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
  durable_objects: { bindings: [
    { name: "TENDRIL", class_name: "Tendril" }, { name: "ADMISSION", class_name: "Admission" },
  ] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Tendril"] }, { tag: "v2", new_sqlite_classes: ["Admission"] }],
  d1_databases: [{ binding: "ACCOUNTS", database_name: dbName, database_id: databaseId, migrations_dir: "migrations" }],
  r2_buckets: [{ binding: "FILES", bucket_name: bucketName }],
  triggers: { crons: ["*/15 * * * *"] },
  ratelimits: [
    ["CREATE_RATE", "101", 5], ["KEY_CREATE_RATE", "107", 30], ["AGENT_RATE", "102", 300],
    ["EVAL_RATE", "103", 60], ["AUTH_RATE", "104", 20], ["FAILED_AUTH_RATE", "105", 20],
    ["REPORT_RATE", "106", 5], ["FILE_READ_RATE", "108", 120],
  ].map(([name, namespace_id, limit]) => ({ name, namespace_id, simple: { limit, period: 60 } })),
  vars: { PUBLIC_BASE: `https://${service}`, PAGE_BASE_DOMAIN: pages, CLOUDFLARE_ACCOUNT_ID: account },
  routes: [
    { pattern: service, custom_domain: true },
    { pattern: `*.${pages}/*`, zone_name: pageZoneName },
  ],
  observability: { enabled: true },
};
const path = `server/wrangler.${stage}.jsonc`;
await writeFile(path, JSON.stringify(config, null, 2) + "\n");
console.log(`Wrote ${path}. In Cloudflare DNS for ${pageZoneName}, add a proxied AAAA record for ${wildcard} with value 100:: before deployment. Run migrations, install speech assets, set secrets, then deploy after launch checks.`);
