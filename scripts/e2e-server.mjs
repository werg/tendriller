// Isolated, credential-free local Worker for Playwright. All state lives in a temp directory.
import { spawn } from "node:child_process";
import { LOCAL_WORKER_PORT, LOCAL_WORKER_SERVICE } from "./e2e-network.mjs";
import { createAttestationKey } from "./attestation-key.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { entry: { type: "string" }, 'no-bundle': { type: 'boolean', default: false } } });
const entry = values.entry ? [resolve(values.entry)] : [];
const bundle = values['no-bundle'] ? ['--no-bundle', '--local'] : [];

const state = mkdtempSync(join(tmpdir(), "tendriller-e2e-"));
const config = "server/wrangler.jsonc";
const token = "tendriller-local-e2e-session";
const hash = createHash("sha256").update(token).digest("hex");
const otherHash = createHash("sha256").update("tendriller-local-e2e-other-session").digest("hex");
const logoutHash = createHash("sha256").update("tendriller-local-e2e-logout-session").digest("hex");
const now = Date.now();
let worker;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`wrangler ${args[0]} exited ${code}`)));
  });
}

async function main() {
  await run(["d1", "migrations", "apply", "ACCOUNTS", "--local", "--config", config, "--persist-to", state]);
  const sql = [
    `UPDATE service_state SET mode = 'open' WHERE id = 1`,
    `INSERT INTO accounts (id, created_at, email) VALUES ('e2e-owner', ${now}, 'owner@example.test')`,
    `INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('github', 'e2e-subject', 'e2e-owner', 'e2e-owner', 'owner@example.test', ${now})`,
    `INSERT INTO identity_emails (provider, subject, email) VALUES ('github', 'e2e-subject', 'owner@example.test')`,
    `INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES ('${hash}', 'e2e-owner', ${now}, ${now + 86_400_000})`,
    `INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES ('${logoutHash}', 'e2e-owner', ${now}, ${now + 86_400_000})`,
    `INSERT INTO accounts (id, created_at, email) VALUES ('e2e-other', ${now}, 'other@example.test')`,
    `INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', 'e2e-other-subject', 'e2e-other', 'e2e-other', 'other@example.test', ${now})`,
    `INSERT INTO identity_emails (provider, subject, email) VALUES ('google', 'e2e-other-subject', 'other@example.test')`,
    `INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES ('${otherHash}', 'e2e-other', ${now}, ${now + 86_400_000})`,
  ].join("; ") + ";";
  await run(["d1", "execute", "ACCOUNTS", "--local", "--config", config, "--persist-to", state, "--command", sql]);
  worker = spawn("npx", ["wrangler", "dev", ...entry, ...bundle, "--config", config, "--ip", "127.0.0.1", "--port", String(LOCAL_WORKER_PORT),
    "--local-protocol", "https", "--persist-to", state, "--var", `PUBLIC_BASE:${LOCAL_WORKER_SERVICE}`,
    "--var", "PAGE_BASE_DOMAIN:pages.localhost", "--var", `HOST_ATTESTATION_KEY:${JSON.stringify(createAttestationKey())}`], { stdio: "inherit" });
  worker.once("exit", code => { console.error(`local Worker exited ${code}`); cleanup(); process.exit(code ?? 1); });
}

function cleanup() { worker?.kill("SIGTERM"); rmSync(state, { recursive: true, force: true }); }
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
main().catch(err => { console.error(err); cleanup(); process.exit(1); });
