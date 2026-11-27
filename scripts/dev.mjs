// One development command: build, migrate, then supervise asset watch + Wrangler.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { createAttestationKey } from "./attestation-key.mjs";
import { ensureLocalRuntimeResources } from "./install-runtime-resources.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let stopping = false;
const child = (args, opts = {}) => {
  const process = spawn(globalThis.process.execPath, args, { cwd: root, stdio: "inherit", ...opts });
  children.add(process);
  process.on("exit", () => children.delete(process));
  return process;
};
const run = (args, opts = {}) => new Promise((resolve, reject) => {
  const process = child(args, opts);
  process.once("error", reject);
  process.once("exit", code => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
});
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const process of children) process.kill("SIGTERM");
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
/** Local pages pin the host attestation key in signed admission policy, so keep one stable key in server/.dev.vars (gitignored). */
function ensureAttestationKey() {
  const vars = join(root, "server/.dev.vars"), current = existsSync(vars) ? readFileSync(vars, "utf8") : "";
  if (/^HOST_ATTESTATION_KEY=/m.test(current)) return;
  const key = createAttestationKey();
  appendFileSync(vars, `${current && !current.endsWith("\n") ? "\n" : ""}HOST_ATTESTATION_KEY='${JSON.stringify(key)}'\n`, { mode: 0o600 });
  console.log(`Generated a local host attestation key in server/.dev.vars (public key ${key.publicKey}).`);
}
function defaultLocalVars(extra) {
  let protocol = "http", port = "8787";
  let hasPublicBase = false, hasLocalDevAuth = false;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i];
    if (arg === "--var" && extra[i + 1]?.startsWith("PUBLIC_BASE:")) hasPublicBase = true;
    else if (arg.startsWith("--var=PUBLIC_BASE:")) hasPublicBase = true;
    if (arg === "--var" && extra[i + 1]?.startsWith("LOCAL_DEV_AUTH:")) hasLocalDevAuth = true;
    else if (arg.startsWith("--var=LOCAL_DEV_AUTH:")) hasLocalDevAuth = true;
    if (arg === "--local-protocol" && extra[i + 1]) protocol = extra[++i];
    else if (arg.startsWith("--local-protocol=")) protocol = arg.slice("--local-protocol=".length);
    else if (arg === "--port" && extra[i + 1]) port = extra[++i];
    else if (arg.startsWith("--port=")) port = arg.slice("--port=".length);
  }
  const args = [];
  if (!hasPublicBase) args.push("--var", `PUBLIC_BASE:${protocol}://localhost:${port}`);
  if (!hasLocalDevAuth) args.push("--var", "LOCAL_DEV_AUTH:1");
  return args;
}
try {
  ensureAttestationKey();
  const nonInteractive = { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CI: "1" } };
  await run(["scripts/build.mjs"]);
  try {
    const seeded = await ensureLocalRuntimeResources();
    if (seeded.installed > 0) {
      console.log(`Installed ${seeded.installed} pinned local speech/runtime resource(s) into local R2.`);
    }
  } catch (error) {
    console.warn(`Warning: could not seed local speech/runtime resources (${error.message}). Voice recognition will stay unavailable until installed via scripts/install-runtime-resources.mjs.`);
  }
  await run(["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", "ACCOUNTS", "--local", "--config", "server/wrangler.jsonc"], nonInteractive);
  await run(["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "ACCOUNTS", "--local", "--config", "server/wrangler.jsonc", "--command", "UPDATE service_state SET mode='open', account_page_cap=NULL, account_resident_cap=NULL, account_storage_cap=NULL WHERE id=1"], nonInteractive);
  if (!stopping) {
    const extra = process.argv.slice(2);
    const watcher = child(["scripts/build.mjs", "--watch", "--skip-initial"]);
    const worker = child(["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "server/wrangler.jsonc", ...defaultLocalVars(extra), ...extra]);
    for (const process of [watcher, worker]) {
      process.once("error", error => { console.error(error); stop(1); });
      process.once("exit", code => { if (!stopping) stop(code || 1); });
    }
  }
} catch (error) { console.error(error.message); stop(1); }
