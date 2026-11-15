import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";
import { cloudflareClient, deletePreview, findDatabase, previewConfig, previewIdentity, previewSecrets,
  provisionPreview, readPreviewTemplate, smokePreview, verifyPreview } from "../branch-preview.mjs";

const account = "a".repeat(32), commit = "b".repeat(40), dbId = "11111111-2222-4333-8444-555555555555";
const identity = previewIdentity("feat/branch-previews", commit);

test("preview success requires the selected source checkout's pinned deployment check", async t => {
  const scratch = resolve(import.meta.dirname, "../../.build");
  await mkdir(scratch, { recursive: true });
  const source = await mkdtemp(resolve(scratch, "preview-check-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(resolve(source, "scripts"));
  const script = resolve(source, "scripts/check-deployment.mjs");
  const output = resolve(source, "checked.json");
  await writeFile(script, `import { writeFileSync } from 'node:fs';
    writeFileSync('checked.json', JSON.stringify({ cwd: process.cwd(), base: process.argv[2] }));`);
  let provenanceChecked = false;
  const smoke = async checked => { assert.equal(checked, identity); provenanceChecked = true; };
  await verifyPreview(identity, source, { smoke });
  assert.equal(provenanceChecked, true);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { cwd: source, base: identity.url });
  await writeFile(script, "process.exitCode = 1;");
  await assert.rejects(verifyPreview(identity, source, { smoke }), /check-deployment.mjs failed/);
});

test("branch names cannot target master or collide after slug normalization", () => {
  for (const branch of ["master", "", "refs/heads/main", "../master", "-main", "a..b", "x.lock", "a\nb", "x@{1}", "a//b"]) {
    assert.throws(() => previewIdentity(branch));
  }
  const branches = ["fix/a-b", "fix-a/b", "Fix/a-b", "fix/a_b", "f/ü", "fix/$(echo-pwned)"];
  const previews = branches.map(branch => previewIdentity(branch, commit));
  assert.equal(new Set(previews.map(p => p.worker)).size, branches.length);
  for (const p of previews) {
    assert.match(p.worker, /^tendriller-preview-[a-f0-9]{12}$/);
    assert.ok(p.bucket.length <= 63);
    assert.equal(new URL(p.url).hostname.split(".").length, 3);
  }
  assert.deepEqual(previewIdentity(identity.branch, commit), identity);
  assert.throws(() => previewIdentity("feature", "short-sha"));
});

test("preview config cannot carry staging resources, routes, or variables into deployment", async () => {
  const template = JSON.parse(await readFile(new URL("../../server/wrangler.staging.jsonc", import.meta.url), "utf8"));
  const config = previewConfig(identity, { ...template, vars: { ...template.vars, GITHUB_CLIENT_SECRET: "never-copy" } }, dbId, account);
  assert.equal(config.name, identity.worker);
  assert.equal(config.vars.PUBLIC_BASE, identity.url);
  assert.equal(config.vars.PAGE_HOST_SUFFIX, identity.suffix);
  assert.equal(config.vars.BRANCH_PREVIEW_SHA, commit);
  assert.deepEqual(config.d1_databases.map(d => [d.database_name, d.database_id]), [[identity.database, dbId]]);
  assert.deepEqual(config.r2_buckets.map(b => b.bucket_name), [identity.bucket]);
  assert.ok(config.routes.every(r => identity.routes.includes(r.pattern) && !r.custom_domain));
  assert.ok(!JSON.stringify(config).includes("never-copy"));
  assert.ok(!JSON.stringify(config).includes("tendriller-staging"));
  assert.ok(!JSON.stringify(config).includes(template.d1_databases[0].database_id));
  assert.ok(config.ratelimits.every(r => !template.ratelimits.some(old => old.namespace_id === r.namespace_id)));
  assert.equal(new Set(config.ratelimits.map(r => r.namespace_id)).size, config.ratelimits.length);
  const other = previewConfig(previewIdentity("other", commit), template, dbId, account);
  assert.ok(config.ratelimits.every(r => !other.ratelimits.some(b => b.namespace_id === r.namespace_id)));
  assert.throws(() => previewConfig(identity, { ...template, durable_objects: { bindings: [
    { name: "TENDRIL", class_name: "Tendril", script_name: "tendriller-production" },
  ] } }, dbId, account));
  assert.throws(() => previewConfig(identity, { ...template, migrations: [{ tag: "v3", transferred_classes: [
    { from_script: "tendriller-production", from: "Tendril", to: "Tendril" },
  ] }] }, dbId, account), /cannot transfer/);
});

test("only dedicated complete preview credential pairs are installed", () => {
  assert.deepEqual(previewSecrets({ GITHUB_CLIENT_SECRET: "production-secret", CLOUDFLARE_API_TOKEN: "api" }), {});
  assert.throws(() => previewSecrets({ PREVIEW_GITHUB_CLIENT_ID: "id" }));
  assert.deepEqual(previewSecrets({ PREVIEW_GITHUB_CLIENT_ID: "id", PREVIEW_GITHUB_CLIENT_SECRET: "preview-secret" }),
    { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "preview-secret" });
});

test("the deployment template supports actual Wrangler JSONC", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = resolve(root, ".build");
  await mkdir(scratch, { recursive: true });
  const source = await mkdtemp(resolve(scratch, "preview-config-"));
  try {
    await mkdir(resolve(source, "server"));
    await writeFile(resolve(source, "server/wrangler.staging.jsonc"), `{
      // The deployment template may contain comments and trailing commas.
      "durable_objects": { "bindings": [{"name":"TENDRIL","class_name":"Tendril",}], },
      "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Tendril"], }],
    }`);
    assert.equal((await readPreviewTemplate(source)).migrations[0].tag, "v1");
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("D1 lookup follows documented pagination instead of assuming a first-page match", async () => {
  const pages = [];
  const database = await findDatabase(async path => {
    const page = Number(new URL(path, "https://api.cloudflare.com").searchParams.get("page")); pages.push(page);
    return { result: page === 1 ? [{ name: `${identity.database}-old`, uuid: dbId }] : [{ name: identity.database, uuid: dbId }],
      result_info: { page, per_page: 1, count: 1, total_count: 2 } };
  }, account, identity.database);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(database.uuid, dbId);
});

test("Cloudflare permission errors fail instead of triggering resource recreation", async () => {
  const api = cloudflareClient({ accountId: account, token: "secret-token", fetcher: async (url, options) => {
    assert.ok(url.startsWith("https://api.cloudflare.com/client/v4/accounts/"));
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
  } });
  await assert.rejects(api(`/accounts/${account}/r2/buckets/example`, { missingCodes: [10006] }), error =>
    error.message.includes("HTTP 403") && !error.message.includes("secret-token"));
});

test("provisioning reuses the exact branch resources across pushes", async () => {
  let database, bucket;
  const creates = [];
  const api = async (path, options = {}) => {
    if (path.includes("/d1/database?")) return { result: database ? [database] : [] };
    if (path.endsWith("/d1/database") && options.method === "POST") {
      creates.push(options.body.name);
      database = { uuid: dbId, name: options.body.name };
      return { result: database };
    }
    if (path.endsWith(`/r2/buckets/${identity.bucket}`)) return bucket ? { result: bucket } : null;
    if (path.endsWith("/r2/buckets") && options.method === "POST") {
      creates.push(options.body.name); bucket = options.body; return { result: bucket };
    }
    throw new Error(`Unexpected ${path}`);
  };
  assert.equal(await provisionPreview(api, account, identity), dbId);
  assert.equal(await provisionPreview(api, account, identity), dbId);
  assert.deepEqual(creates, [identity.database, identity.bucket]);
});

function cleanupApi({ wrongDatabase = false, extraRoute = false, exists = true } = {}) {
  const changes = [], objects = ["uploads/a b#?.png", "nested/file.json"];
  let worker = exists, bucket = exists, database = exists, routes = exists;
  const api = async (path, options = {}) => {
    const method = options.method ?? "GET";
    if (method !== "GET") changes.push([method, path]);
    if (path.includes("/d1/database?")) return { result: database ? [{ name: identity.database, uuid: dbId }] : [] };
    if (path.endsWith(`/scripts/${identity.worker}/settings`)) return worker ? { result: { bindings: [
      { type: "d1", id: wrongDatabase ? "production-id" : dbId }, { type: "r2_bucket", bucket_name: identity.bucket },
    ] } } : null;
    if (path.startsWith("/zones?")) return { result: [{ name: "tendriller.dev", id: "c".repeat(32), account: { id: account } }] };
    if (path.endsWith("/workers/routes")) return { result: routes ? [
      { id: "route1", script: identity.worker, pattern: extraRoute ? "tendriller.dev/*" : identity.routes[0] },
      { id: "production", script: "tendriller-production", pattern: "*.tendriller.site/*" },
    ] : [] };
    if (path.endsWith("/workers/routes/route1") && method === "DELETE") { routes = false; return {}; }
    if (path.endsWith(`/scripts/${identity.worker}`) && method === "DELETE") { worker = false; return {}; }
    if (path.endsWith(`/r2/buckets/${identity.bucket}`)) {
      if (method === "DELETE") { assert.equal(objects.length, 0); bucket = false; return {}; }
      return bucket ? { result: { name: identity.bucket } } : null;
    }
    if (path.includes("/objects?")) {
      assert.equal(worker, false, "stop writers before emptying storage");
      return { result: objects.slice(0, 1).map(key => ({ key })), result_info: { is_truncated: objects.length > 1 } };
    }
    if (path.includes("/objects/") && method === "DELETE") {
      assert.equal(decodeURIComponent(path.split("/objects/")[1]), objects.shift()); return {};
    }
    if (path.endsWith(`/d1/database/${dbId}`) && method === "DELETE") { database = false; return {}; }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { api, changes };
}

test("cleanup stops routing/writers, empties every R2 page, and deletes only exact preview resources", async () => {
  const { api, changes } = cleanupApi();
  await deletePreview(api, account, identity);
  assert.equal(changes.length, 6);
  assert.ok(changes[0][1].endsWith("/workers/routes/route1"));
  assert.ok(changes[1][1].endsWith(`/scripts/${identity.worker}`));
  assert.ok(changes[2][1].endsWith("/objects/uploads/a%20b%23%3F.png"));
  assert.ok(changes.at(-1)[1].endsWith(`/d1/database/${dbId}`));
  assert.ok(changes.every(([, path]) => !path.includes("production") && !path.includes("staging")));
  await deletePreview(api, account, identity);
  assert.equal(changes.length, 6, "cleanup is idempotent after partial or complete removal");
});

test("cleanup refuses a resource name that has acquired an unrelated binding or route", async () => {
  for (const options of [{ wrongDatabase: true }, { extraRoute: true }]) {
    const { api, changes } = cleanupApi(options);
    await assert.rejects(deletePreview(api, account, identity), /unexpected/);
    assert.deepEqual(changes, []);
  }
});

test("live smoke waits for exact deployed commit and checks database-backed service content", async () => {
  const paths = [];
  let attempts = 0;
  await smokePreview(identity, { delay: async () => {}, fetcher: async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === "/health") return Response.json({ ok: true, preview: { commit: ++attempts === 1 ? "old" : commit } });
    if (path === "/api/service") return Response.json({contract:2});
    return new Response(`Tendriller ${identity.url}`);
  } });
  assert.equal(attempts, 2);
  assert.deepEqual(paths.slice(2), ["/", "/status", "/api/service", "/agent.md"]);
});
