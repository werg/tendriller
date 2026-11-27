#!/usr/bin/env node
/**
 * Genuine Tendriller Copy Editor — workspace orchestrator & repo-agent bridge.
 *
 * Provisions a real Tendriller workspace under `.tendriller-dev-host/copy-editor-workspaces/`,
 * registers an agent (`tendril workspace init`), creates a genuine page (`copy-editor`),
 * prepares its Chronolog application (`setup.mjs init`), builds and publishes a signed
 * UI bundle rendering Tendriller's live pages (`server/src/*.ts` + `server/src/site-copy.json`),
 * and runs the optional native participant (`tendril agent run`) so replicated signed
 * `copy.submit` batches flow into the local inbox for repo agents (`--wait` / `--apply`).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COPY_JSON = join(ROOT, "server/src/site-copy.json");
const APP_SRC = join(ROOT, "scripts/copy-editor-app");
const TUTORIAL_DIR = join(ROOT, "docs/tutorial");
const PAGE_SLUG = "copy-editor-v2";

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    service: { type: "string", default: process.env.TENDRILLER_SERVICE || "http://localhost:8787" },
    owner: { type: "string", default: process.env.TENDRILLER_OWNER || "dev@local.dev" },
    handle: { type: "string", default: "copy-editor" },
    workspace: { type: "string" },
    "display-origin": { type: "string", default: "https://tendriller.dev" },
    republish: { type: "boolean", default: false },
    "no-agent": { type: "boolean", default: false },
    wait: { type: "boolean", default: false },
    after: { type: "string" },
    timeout: { type: "string", default: "3600" },
    inbox: { type: "boolean", default: false },
    apply: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(`Tendriller Copy Editor (genuine Tendriller page)

Usage:
  node scripts/copy-editor.mjs [options]

Options:
  --service <origin>          Tendriller host origin (default: http://localhost:8787)
  --owner <email>             Owner email for local workspace init (default: dev@local.dev)
  --handle <handle>           Agent handle (default: copy-editor)
  --workspace <dir>           Override workspace directory
  --display-origin <origin>   Origin shown inside previewed pages (default: https://tendriller.dev)
  --no-agent                  Prepare & publish the page, print URL, and exit without running tendril agent run
  --republish                 Rebuild from current server/src/site-copy.json and publish a new signed version
  --wait [--timeout <s>]      Wait for the next replicated Chronolog copy.submit batch and print JSON
  --inbox                     Print all received Chronolog batches
  --apply <latest|batchId>    Apply a received batch's edits to server/src/site-copy.json
`);
  process.exit(0);
}

const serviceOrigin = flags.service.replace(/\/+$/, "");
const originSlug = new URL(serviceOrigin).host.replace(/[^a-zA-Z0-9.-]+/g, "-").replace(/[:.]+/g, "-").toLowerCase();
const workspaceDir = flags.workspace
  ? resolve(flags.workspace)
  : join(ROOT, ".tendriller-dev-host", "copy-editor-workspaces", `v2-${originSlug}`);
const inboxPath = join(workspaceDir, ".tendriller", "copy-inbox.jsonl");
const tendrilBin = join(workspaceDir, "node_modules/@tendriller/tools/bin/tendril.mjs");

function runCmd(cmd, args, { cwd = ROOT, env = process.env, capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const msg = (stderr || stdout || `${cmd} ${args.join(" ")} exited ${code}`).trim();
        reject(Object.assign(new Error(msg), { code, stdout, stderr }));
      }
    });
  });
}

function readInbox() {
  if (!existsSync(inboxPath)) return [];
  const items = [];
  for (const line of readFileSync(inboxPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch {}
  }
  return items;
}

function setByPath(obj, dotPath, value) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur == null || !(k in cur)) throw new Error(`Unknown copy key path: ${dotPath}`);
    cur = cur[k];
  }
  const last = /^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1);
  if (cur == null || !(last in cur)) throw new Error(`Unknown copy key path: ${dotPath}`);
  cur[last] = value;
}

function applyBatchToRepo(batch) {
  const copy = JSON.parse(readFileSync(COPY_JSON, "utf8"));
  const applied = [];
  for (const edit of batch.edits ?? []) {
    if (!edit?.key || typeof edit.after !== "string") continue;
    setByPath(copy, edit.key, edit.after.replace(/\u00a0/g, " "));
    applied.push(edit.key);
  }
  writeFileSync(COPY_JSON, JSON.stringify(copy, null, 2) + "\n", "utf8");
  return applied;
}

function ensureLink(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
      rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {}
  symlinkSync(target, linkPath, "dir");
}

function ensureFileLink(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  try { rmSync(linkPath, { force: true }); } catch {}
  symlinkSync(target, linkPath, "file");
}

async function ensureBuiltPackages() {
  const sdkPkg = join(ROOT, "dist/sdk/package.json");
  const toolsPkg = join(ROOT, "dist/tools/package.json");
  if (!existsSync(sdkPkg) || !existsSync(toolsPkg)) {
    console.error("Building local Tendriller SDK and tools artifacts...");
    await runCmd("npm", ["run", "build:artifacts"], { cwd: ROOT });
  }
}

function prepareWorkspaceSkeleton() {
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "package.json"), readFileSync(join(TUTORIAL_DIR, "package.json"), "utf8"));

  // Wire workspace node_modules directly to local repo packages (zero network).
  // Copy @tendriller/{core,tools} so Node ESM realpath resolution always finds peer packages in workspace node_modules.
  const nm = join(workspaceDir, "node_modules");
  mkdirSync(join(nm, "@tendriller"), { recursive: true });
  rmSync(join(nm, "@tendriller/core"), { recursive: true, force: true });
  rmSync(join(nm, "@tendriller/tools"), { recursive: true, force: true });
  cpSync(join(ROOT, "dist/sdk"), join(nm, "@tendriller/core"), { recursive: true });
  cpSync(join(ROOT, "dist/tools"), join(nm, "@tendriller/tools"), { recursive: true });
  ensureLink(join(ROOT, "node_modules/@chronolog/authority"), join(nm, "@chronolog/authority"));
  ensureLink(join(ROOT, "node_modules/@chronolog/peer-session"), join(nm, "@chronolog/peer-session"));
  ensureLink(join(ROOT, "node_modules/@chronolog/signals"), join(nm, "@chronolog/signals"));
  ensureLink(join(ROOT, "node_modules/@jitl/quickjs-ng-wasmfile-release-sync"), join(nm, "@jitl/quickjs-ng-wasmfile-release-sync"));
  ensureLink(join(ROOT, "node_modules/quickjs-emscripten-core"), join(nm, "quickjs-emscripten-core"));
  ensureLink(join(ROOT, "node_modules/esbuild"), join(nm, "esbuild"));
  const wsPkg = join(ROOT, "tools/node_modules/ws");
  if (existsSync(wsPkg)) ensureLink(wsPkg, join(nm, "ws"));
  else if (existsSync(join(ROOT, "node_modules/ws"))) ensureLink(join(ROOT, "node_modules/ws"), join(nm, "ws"));
  ensureFileLink(tendrilBin, join(nm, ".bin/tendril"));

  // Copy tutorial shared helpers & setup.mjs.
  cpSync(join(TUTORIAL_DIR, "shared"), join(workspaceDir, "shared"), { recursive: true, force: true });
  cpSync(join(TUTORIAL_DIR, "setup.mjs"), join(workspaceDir, "setup.mjs"), { force: true });
}

function syncAppSource() {
  const targetDir = join(workspaceDir, "pages", PAGE_SLUG);
  mkdirSync(targetDir, { recursive: true });
  for (const name of readdirSync(APP_SRC)) {
    cpSync(join(APP_SRC, name), join(targetDir, name), { recursive: true, force: true });
  }
}

async function checkReadiness() {
  let res;
  try {
    res = await fetch(`${serviceOrigin}/api/readiness`, { redirect: "error" });
  } catch (err) {
    throw new Error(
      `Cannot reach Tendriller service at ${serviceOrigin}/api/readiness (${err.message}).\n` +
      `Start the local host first with: npm run dev`
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    throw new Error(`Readiness check at ${serviceOrigin}/api/readiness failed (HTTP ${res.status}).`);
  }
  if (body.creation?.available !== true) {
    throw new Error(`Service ${serviceOrigin} is not open for page creation: ${JSON.stringify(body.creation ?? body)}`);
  }
}

function workspaceEnv() {
  return {
    ...process.env,
    TENDRILLER_REPO_ROOT: ROOT,
    TENDRILLER_COPY_DISPLAY_ORIGIN: flags["display-origin"],
    TENDRILLER_COPY_INBOX: inboxPath,
  };
}

async function ensureProvisionedPage({ republish = false } = {}) {
  await ensureBuiltPackages();
  prepareWorkspaceSkeleton();
  await checkReadiness();

  const configPath = join(workspaceDir, "tendriller.json");
  if (!existsSync(configPath)) {
    const res = await runCmd(
      process.execPath,
      [
        tendrilBin, "workspace", "init",
        "--service", serviceOrigin,
        "--owner", flags.owner,
        "--handle", flags.handle,
        "--bio", "Live inline copy editor for Tendriller pages",
      ],
      { cwd: workspaceDir, env: workspaceEnv(), capture: true },
    );
    if (res.stderr.trim()) console.error(res.stderr.trim());
  }

  let config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.service !== serviceOrigin) {
    throw new Error(`Workspace ${workspaceDir} belongs to ${config.service}, not ${serviceOrigin}`);
  }

  if (!config.pages?.[PAGE_SLUG]) {
    await runCmd(
      process.execPath,
      [tendrilBin, "page", "new", PAGE_SLUG, "--name", "Tendriller Copy Editor"],
      { cwd: workspaceDir, env: workspaceEnv(), capture: true },
    );
    config = JSON.parse(readFileSync(configPath, "utf8"));
  }

  syncAppSource();

  const pageMeta = config.pages[PAGE_SLUG];
  const preparedFile = join(workspaceDir, ".tendriller", "pages", pageMeta.id, "prepared.json");
  const initializedFile = join(workspaceDir, ".tendriller", "pages", pageMeta.id, "initialized.json");
  if (!existsSync(preparedFile) || !existsSync(initializedFile)) {
    await runCmd(process.execPath, ["setup.mjs", "init", PAGE_SLUG], {
      cwd: workspaceDir,
      env: workspaceEnv(),
      capture: true,
    });
  }

  let deploy;
  for (let attempt = 1; ; attempt++) {
    try {
      deploy = await runCmd(process.execPath, ["setup.mjs", "deploy", PAGE_SLUG], {
        cwd: workspaceDir,
        env: workspaceEnv(),
        capture: true,
      });
      break;
    } catch (err) {
      if (attempt < 4 && /non-JSON response|fetch failed|503|ECONNRESET/i.test(err.message)) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
  const receipt = JSON.parse(deploy.stdout.trim());
  return { config, pageMeta, receipt, republished: republish };
}

// ── Mode: --inbox ─────────────────────────────────────────────────────────────
if (flags.inbox) {
  console.log(JSON.stringify(readInbox(), null, 2));
  process.exit(0);
}

// ── Mode: --wait ──────────────────────────────────────────────────────────────
if (flags.wait) {
  const rawTimeout = Number(flags.timeout);
  const timeoutMs = rawTimeout === 0 ? 0 : Math.max(1, rawTimeout || 3600) * 1000;
  mkdirSync(dirname(inboxPath), { recursive: true });
  const cursorPath = `${inboxPath}.cursor`;
  const readCursor = () => {
    if (flags.after) return flags.after;
    try { return readFileSync(cursorPath, "utf8").trim() || null; } catch { return null; }
  };
  const writeCursor = (id) => {
    try { writeFileSync(cursorPath, `${id}\n`, "utf8"); } catch {}
  };
  const seenId = readCursor();
  const initialItems = readInbox();
  const baselineLen = seenId ? -1 : initialItems.length;

  const nextBatch = () => {
    const items = readInbox();
    if (seenId) {
      const idx = items.findIndex((b) => b.id === seenId);
      if (idx === -1) return items[0] ?? null;
      return items[idx + 1] ?? null;
    }
    return items.length > baselineLen ? items[baselineLen] : null;
  };

  await new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (batch) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (batch.id) writeCursor(batch.id);
      console.log(JSON.stringify(batch, null, 2));
      resolvePromise();
    };
    const check = () => {
      const batch = nextBatch();
      if (batch) finish(batch);
    };
    const watcher = watch(dirname(inboxPath), () => { if (!settled) check(); });
    const poll = setInterval(() => { if (!settled) check(); }, 400);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          watcher?.close();
          reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for a replicated Chronolog batch in ${inboxPath}`));
        }, timeoutMs)
      : null;
    check();
  });
  process.exit(0);
}

// ── Mode: --apply ─────────────────────────────────────────────────────────────
if (flags.apply) {
  const items = readInbox();
  if (!items.length) {
    console.error(`No replicated batches found in ${inboxPath}`);
    process.exit(1);
  }
  const batch = flags.apply === "latest" ? items.at(-1) : items.find((b) => b.id === flags.apply);
  if (!batch) {
    console.error(`Batch not found: ${flags.apply}`);
    process.exit(1);
  }
  const keys = applyBatchToRepo(batch);
  // Best-effort: record `copy.applied` in the running native Chronolog agent so submitted highlights clear cleanly.
  if (existsSync(tendrilBin) && keys.length) {
    try {
      await runCmd(
        process.execPath,
        [tendrilBin, "--page", PAGE_SLUG, "command", "markApplied", JSON.stringify({ batchId: batch.id, keys }), "--operation", `apply-${batch.id}`],
        { cwd: workspaceDir, env: workspaceEnv(), capture: true },
      );
    } catch {}
  }
  let receipt = null;
  if (flags.republish) {
    receipt = (await ensureProvisionedPage({ republish: true })).receipt;
  }
  console.log(JSON.stringify({ appliedBatch: batch.id, keys, note: batch.note ?? "", republished: Boolean(receipt), receipt }, null, 2));
  process.exit(0);
}

// ── Mode: --republish or default launch ───────────────────────────────────────
const { config, pageMeta, receipt } = await ensureProvisionedPage({ republish: flags.republish });
const summary = {
  page_url: receipt.page_url,
  page_id: pageMeta.id,
  service: serviceOrigin,
  owner: flags.owner,
  agent: config.agent,
  version: receipt.version,
  publicationId: receipt.publicationId,
  workspace: workspaceDir,
  inbox: inboxPath,
};

if (flags.republish || flags["no-agent"]) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(JSON.stringify(summary, null, 2));
console.error(`\nGenuine Tendriller Copy Editor ready:`);
console.error(`  Page URL:  ${receipt.page_url}`);
console.error(`  Service:   ${serviceOrigin}`);
console.error(`  Owner:     ${flags.owner}`);
console.error(`  Workspace: ${workspaceDir}`);
console.error(`  Inbox:     ${inboxPath}`);
console.error(`\nStarting native participant (tendril agent run)...`);
console.error(`This agent holds the page's keys and automatically admits your signed-in browser over E2EE — no manual pairing required.`);
console.error(`Once admitted, browser reads and inline edits stay locally durable even offline.\n`);

const agentProc = spawn(process.execPath, [tendrilBin, "agent", "run"], {
  cwd: workspaceDir,
  env: workspaceEnv(),
  stdio: "inherit",
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { agentProc.kill(sig); });
}
agentProc.on("exit", (code) => { process.exit(code ?? 0); });
