// One development command: build, migrate, then supervise asset watch + Wrangler.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { createAttestationKey } from "./attestation-key.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let stopping = false;
const child = args => {
  const process = spawn(globalThis.process.execPath, args, { cwd: root, stdio: "inherit" });
  children.add(process);
  process.on("exit", () => children.delete(process));
  return process;
};
const run = args => new Promise((resolve, reject) => {
  const process = child(args);
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
try {
  ensureAttestationKey();
  await run(["scripts/build.mjs"]);
  await run(["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", "ACCOUNTS", "--local", "--config", "server/wrangler.jsonc"]);
  if (!stopping) {
    const watcher = child(["scripts/build.mjs", "--watch", "--skip-initial"]);
    const worker = child(["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "server/wrangler.jsonc", ...process.argv.slice(2)]);
    for (const process of [watcher, worker]) {
      process.once("error", error => { console.error(error); stop(1); });
      process.once("exit", code => { if (!stopping) stop(code || 1); });
    }
  }
} catch (error) { console.error(error.message); stop(1); }
