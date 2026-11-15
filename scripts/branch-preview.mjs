// GitHub Actions owns the lifecycle; this script only touches resources derived
// from one exact branch name. It never loads staging/production resource IDs.
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const ZONE = "tendriller.dev";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;

export function previewIdentity(branch, sha) {
  if (typeof branch !== "string" || !branch || branch.length > 255 || branch === "master" || branch === "@"
    || branch.startsWith("-") || branch.startsWith("refs/") || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
    || branch.includes("..") || branch.includes("@{")
    || branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    throw new Error("Pass a valid non-master branch name, not a ref or revision expression");
  }
  if (sha !== undefined && !SHA.test(sha)) throw new Error("Pass a complete lowercase commit SHA");
  const key = createHash("sha256").update(branch).digest("hex").slice(0, 12);
  const worker = `tendriller-preview-${key}`;
  const hostname = `preview-${key}.${ZONE}`;
  const suffix = `--p-${key}`;
  return { branch, sha, key, worker, database: `${worker}-accounts`, bucket: `${worker}-files`,
    hostname, suffix, url: `https://${hostname}`,
    routes: [`${hostname}/*`, `*${suffix}.${ZONE}/*`] };
}

function validateTemplate(template) {
  const bindings = template.durable_objects?.bindings;
  if (!Array.isArray(bindings) || !bindings.length || bindings.some(b => b.script_name || b.environment)) {
    throw new Error("Preview Durable Objects must be defined in the preview Worker");
  }
  if (template.migrations?.some(migration => migration.transferred_classes?.length)) {
    throw new Error("Preview migrations cannot transfer Durable Objects from another Worker");
  }
  if ((template.ratelimits?.length ?? 0) > 15) throw new Error("Too many preview rate limit bindings");
}

export function previewConfig(identity, template, databaseId, accountId) {
  if (!UUID.test(databaseId) || !/^[a-f0-9]{32}$/.test(accountId)) throw new Error("Invalid Cloudflare resource ID");
  validateTemplate(template);
  const bindings = template.durable_objects.bindings;
  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: identity.worker,
    account_id: accountId,
    main: "../dist/service/worker.mjs",
    compatibility_date: template.compatibility_date,
    compatibility_flags: template.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
    durable_objects: { bindings: bindings.map(({ name, class_name }) => ({ name, class_name })) },
    migrations: template.migrations,
    d1_databases: [{ binding: "ACCOUNTS", database_name: identity.database,
      database_id: databaseId, migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "FILES", bucket_name: identity.bucket }],
    // Isolated branch previews must not consume the account-wide Cron Trigger\n    // quota (five on Workers Free). Explicitly clear schedules on retries.\n    // Production and staging retain their scheduled reconciliation.\n    triggers: { crons: [] },
    ratelimits: (template.ratelimits ?? []).map((limit, index) => ({
      ...limit, namespace_id: String((BigInt(`0x${identity.key}`) + 1024n) * 16n + BigInt(index)),
    })),
    vars: { PUBLIC_BASE: identity.url, PAGE_BASE_DOMAIN: ZONE, PAGE_HOST_SUFFIX: identity.suffix,
      BRANCH_PREVIEW_BRANCH: identity.branch, BRANCH_PREVIEW_SHA: identity.sha,
      CLOUDFLARE_ACCOUNT_ID: accountId },
    routes: identity.routes.map(pattern => ({ pattern, zone_name: ZONE })),
    observability: { enabled: true },
  };
}

export function previewSecrets(env) {
  const secrets = {};
  for (const [id, secret] of [["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]]) {
    const first = env[`PREVIEW_${id}`], second = env[`PREVIEW_${secret}`];
    if (!!first !== !!second) throw new Error(`Set both PREVIEW_${id} and PREVIEW_${secret}, or neither`);
    if (first) Object.assign(secrets, { [id]: first, [secret]: second });
  }
  return secrets;
}

export function cloudflareClient({ accountId, token, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !token) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the staging Actions environment");
  }
  return async function api(path, { method = "GET", body, missingCodes = [] } = {}) {
    if (!path.startsWith("/accounts/") && !path.startsWith("/zones")) throw new Error("Invalid Cloudflare API path");
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : { success: response.ok, result: null }; }
    catch { throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}, invalid JSON`); }
    if (missingCodes.length && (response.status === 404
      || data.errors?.some(error => missingCodes.includes(error.code)))) return null;
    if (!response.ok || data.success === false) {
      const details = (data.errors ?? []).map(error => `${error.code}: ${error.message}`).join("; ");
      throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}${details ? ` (${details})` : ""}`);
    }
    return data;
  };
}

export async function findDatabase(api, accountId, name) {
  const matches = [];
  for (let page = 1; ; page++) {
    const data = await api(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100&page=${page}`);
    if (!Array.isArray(data.result)) throw new Error("Invalid D1 database list");
    matches.push(...data.result.filter(db => db.name === name));
    const perPage = data.result_info?.per_page ?? 100;
    const total = data.result_info?.total_count;
    if (data.result.length < perPage || (Number.isFinite(total) && page * perPage >= total)) break;
  }
  if (matches.length > 1) throw new Error(`More than one database is named ${name}`);
  if (matches[0] && !UUID.test(matches[0].uuid)) throw new Error("Invalid D1 database ID");
  return matches[0] ?? null;
}

export async function readPreviewTemplate(source) {
  const path = resolve(source, "server/wrangler.staging.jsonc");
  // Use the installed Wrangler's own JSONC parser, including comments and
  // trailing commas. Cleanup requires no npm install or Wrangler dependency.
  const { experimental_readRawConfig } = createRequire(resolve(source, "package.json"))("wrangler");
  const { rawConfig } = experimental_readRawConfig({ config: path });
  validateTemplate(rawConfig);
  return rawConfig;
}

export async function provisionPreview(api, accountId, identity) {
  let database = await findDatabase(api, accountId, identity.database);
  if (!database) {
    database = (await api(`/accounts/${accountId}/d1/database`, {
      method: "POST", body: { name: identity.database },
    })).result;
    if (database?.name !== identity.database || !UUID.test(database.uuid)) throw new Error("Unexpected created D1 database");
  }
  const bucketPath = `/accounts/${accountId}/r2/buckets/${identity.bucket}`;
  const bucket = await api(bucketPath, { missingCodes: [10006] });
  if (!bucket) await api(`/accounts/${accountId}/r2/buckets`, { method: "POST", body: { name: identity.bucket } });
  else if (bucket.result?.name !== identity.bucket) throw new Error("Unexpected R2 bucket");
  return database.uuid;
}

function runWrangler(source, args, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(source, "node_modules/wrangler/bin/wrangler.js"), ...args], {
      cwd: source, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Wrangler ${args[0]} failed (${signal ?? code})`)));
    if (input !== undefined) child.stdin.end(input);
  });
}

function runSourceScript(source, script, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(source, 'scripts', script), ...args], { cwd: source, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${script} failed (${signal ?? code})`)));
  });
}

export async function smokePreview(identity, { fetcher = fetch, provenance = true, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const healthResponse = await fetcher(`${identity.url}/health`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!healthResponse.ok) throw new Error(`Health HTTP ${healthResponse.status}`);
      const health = await healthResponse.json();
      if (health.ok !== true || (provenance && health.preview?.commit !== identity.sha)) {
        throw new Error("Preview is not serving the checked commit yet");
      }
      for (const path of ["/", "/status", "/api/service", "/agent.md"]) {
        const response = await fetcher(`${identity.url}${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        const body = await response.text();
        if (path === "/api/service") { if (JSON.parse(body).contract !== 2) throw new Error("Service contract mismatch"); }
        else if (!body.includes("Tendriller")) throw new Error(`${path}: missing service content`);
        if (path === "/agent.md" && !body.includes(identity.url)) throw new Error("Agent guide points at another environment");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 9) await delay(3_000);
    }
  }
  throw lastError;
}

export async function verifyPreview(identity, source, { smoke = smokePreview } = {}) {
  await smoke(identity);
  await runSourceScript(source, 'check-deployment.mjs', [identity.url]);
}

export async function deletePreview(api, accountId, identity) {
  // Resolve exact owned resources before removing anything. A failed or partial
  // deployment is retryable; permission failures must never look like absence.
  const database = await findDatabase(api, accountId, identity.database);
  const scriptPath = `/accounts/${accountId}/workers/scripts/${identity.worker}`;
  const settings = await api(`${scriptPath}/settings`, { missingCodes: [10007] });
  for (const binding of settings?.result?.bindings ?? []) {
    if (binding.type === "d1" && binding.id !== database?.uuid) throw new Error("Preview Worker uses an unexpected D1 database; refusing cleanup");
    if (binding.type === "r2_bucket" && binding.bucket_name !== identity.bucket) throw new Error("Preview Worker uses an unexpected R2 bucket; refusing cleanup");
  }
  const zoneResult = await api(`/zones?name=${ZONE}&account.id=${accountId}`);
  const zone = zoneResult.result?.find(z => z.name === ZONE && z.account?.id === accountId);
  if (!zone || !/^[a-f0-9]{32}$/.test(zone.id)) throw new Error(`Cannot find ${ZONE} in this Cloudflare account`);
  const routeResult = await api(`/zones/${zone.id}/workers/routes`);
  if (!Array.isArray(routeResult.result)) throw new Error("Invalid Worker routes response");
  const ownedRoutes = routeResult.result.filter(route => route.script === identity.worker);
  if (ownedRoutes.some(route => !identity.routes.includes(route.pattern))) {
    throw new Error("Preview Worker has an unexpected route; refusing cleanup");
  }
  for (const route of ownedRoutes) await api(`/zones/${zone.id}/workers/routes/${route.id}`, { method: "DELETE" });
  if (settings) await api(scriptPath, { method: "DELETE" });
  // With the Worker gone, no request or alarm can create more preview objects.
  const bucketPath = `/accounts/${accountId}/r2/buckets/${identity.bucket}`;
  const bucket = await api(bucketPath, { missingCodes: [10006] });
  if (bucket) {
    if (bucket.result?.name !== identity.bucket) throw new Error("Unexpected R2 bucket; refusing cleanup");
    // Delete each returned page, then list from the beginning: deleting objects
    // must not invalidate a cursor and accidentally leave the next page behind.
    for (;;) {
      const page = await api(`${bucketPath}/objects?per_page=1000`);
      if (!Array.isArray(page.result)) throw new Error("Invalid R2 object list");
      if (!page.result.length) {
        if (page.result_info?.is_truncated) throw new Error("R2 returned an empty truncated page");
        break;
      }
      for (const object of page.result) {
        if (typeof object.key !== "string" || !object.key) throw new Error("R2 object has no key");
        // Slashes separate the object path, while reserved characters are encoded.
        // Dot segments are refused because URL normalization could change the key.
        if (object.key.split("/").some(part => part === "." || part === "..")) throw new Error("R2 object has an unsafe path segment");
        const key = object.key.split("/").map(encodeURIComponent).join("/");
        await api(`${bucketPath}/objects/${key}`, { method: "DELETE" });
      }
    }
    await api(bucketPath, { method: "DELETE" });
  }
  if (database) await api(`/accounts/${accountId}/d1/database/${database.uuid}`, { method: "DELETE" });
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    branch: { type: "string" }, sha: { type: "string" }, source: { type: "string", default: process.cwd() },
  } });
  const [command] = positionals;
  if (positionals.length !== 1 || !["plan", "deploy", "delete"].includes(command)) {
    throw new Error("Usage: node scripts/branch-preview.mjs plan|deploy|delete --branch <branch> [--sha <commit>] [--source <checkout>]");
  }
  const identity = previewIdentity(values.branch, values.sha);
  if (command === "plan") return console.log(JSON.stringify(identity, null, 2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const api = cloudflareClient({ accountId, token: process.env.CLOUDFLARE_API_TOKEN });
  if (command === "delete") {
    await deletePreview(api, accountId, identity);
    console.log(`Removed branch preview ${identity.worker}`);
    return;
  }
  if (!identity.sha) throw new Error("Deploy requires --sha <checked commit>");
  const source = resolve(values.source);
  const template = await readPreviewTemplate(source);
  const secrets = previewSecrets(process.env);
  const databaseId = await provisionPreview(api, accountId, identity);
  const configPath = resolve(source, "server/wrangler.branch-preview.json");
  const config = previewConfig(identity, template, databaseId, accountId);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  await runWrangler(source, ["d1", "migrations", "apply", "ACCOUNTS", "--remote", "--config", configPath]);
  await runSourceScript(source, 'publish-runtime.mjs', ['--config', configPath]);
  await runWrangler(source, ["deploy", "--config", configPath, "--durable-objects-code-update-mode", "immediate"]);
  if (Object.keys(secrets).length) await runWrangler(source, ["secret", "bulk", "--config", configPath], JSON.stringify(secrets));
  await verifyPreview(identity, source);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `url=${identity.url}\npreview_key=${identity.key}\nworker=${identity.worker}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Live branch preview\n\n[Open preview](${identity.url}) · commit \`${identity.sha}\`\n\n`
    + "Storage is isolated from staging and production. New previews start with page creation paused; OAuth/Turnstile setup is separate.\n"
    );
  console.log(`Branch preview verified: ${identity.url} (${identity.sha})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
