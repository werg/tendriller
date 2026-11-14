// Provision one isolated environment after its domains are active on Cloudflare.
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read from the environment.
// Production: node scripts/provision.mjs production
// Staging: STAGING_PUBLIC_BASE=https://... STAGING_PAGE_BASE_DOMAIN=... node scripts/provision.mjs staging
import { writeFile } from "node:fs/promises";

const stage = process.argv[2];
if (stage !== "production" && stage !== "staging") throw new Error("Pass production or staging");
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
const service = stage === "production" ? "tendriller.dev" : process.env.STAGING_PUBLIC_BASE ? new URL(process.env.STAGING_PUBLIC_BASE).hostname : "";
const pages = stage === "production" ? "tendriller.site" : process.env.STAGING_PAGE_BASE_DOMAIN ?? "staging.tendriller.site";
if (!service || !pages || service === pages) throw new Error("Configure separate service and pages domains for this stage");
if (stage === "staging" && pages === "tendriller.site") throw new Error("Staging needs its own pages zone so it cannot route production pages");
const base = `https://api.cloudflare.com/client/v4`;

async function api(path, method = "GET", body) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
    ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`${method} ${path}: ${JSON.stringify(data.errors ?? response.status)}`);
  return data.result;
}

async function zone(name) {
  const zones = await api(`/zones?name=${encodeURIComponent(name)}&per_page=50`);
  const found = zones.find(z => z.name === name && z.status === "active");
  if (!found) throw new Error(`Cloudflare zone ${name} must exist and be active`);
  return found.id;
}

async function d1(name) {
  const existing = await api(`/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`);
  const found = existing.find(d => d.name === name);
  if (found) return found.uuid;
  const created = await api(`/accounts/${account}/d1/database`, "POST", { name });
  return created.uuid;
}

async function bucket(name) {
  const existing = await api(`/accounts/${account}/r2/buckets?name_contains=${encodeURIComponent(name)}`);
  if (!existing.buckets.some(b => b.name === name)) await api(`/accounts/${account}/r2/buckets`, "POST", { name });
  return name;
}

const pageZoneName = "tendriller.site";
const pageZone = await zone(pageZoneName);
await zone(stage === "production" ? service : "tendriller.dev");
const dbName = `tendriller-${stage}-accounts`;
const bucketName = `tendriller-${stage}-files`;
const [databaseId] = await Promise.all([d1(dbName), bucket(bucketName)]);
const wildcard = `*.${pages}`;
const dns = await api(`/zones/${pageZone}/dns_records?type=AAAA&name=${encodeURIComponent(wildcard)}`);
const record = dns.find(record => record.name === wildcard);
if (record && !record.proxied) {
  await api(`/zones/${pageZone}/dns_records/${record.id}`, "PATCH", { proxied: true });
} else if (!record) {
  await api(`/zones/${pageZone}/dns_records`, "POST", { type: "AAAA", name: wildcard, content: "100::", proxied: true, ttl: 1 });
}

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
  send_email: [{ name: "EMAIL" }],
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
console.log(`Wrote ${path}. Run migrations, install speech assets, set secrets, then deploy after launch checks.`);
