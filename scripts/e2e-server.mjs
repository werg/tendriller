// Isolated, credential-free local Worker for Playwright. All state lives in a temp directory.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const state = mkdtempSync(join(tmpdir(), "tendriller-e2e-"));
const config = "server/wrangler.jsonc";
const token = "tendriller-local-e2e-session";
const hash = createHash("sha256").update(token).digest("hex");
const otherHash = createHash("sha256").update("tendriller-local-e2e-other-session").digest("hex");
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
    `INSERT INTO accounts (id, created_at, email) VALUES ('e2e-other', ${now}, 'other@example.test')`,
    `INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', 'e2e-other-subject', 'e2e-other', 'e2e-other', 'other@example.test', ${now})`,
    `INSERT INTO identity_emails (provider, subject, email) VALUES ('google', 'e2e-other-subject', 'other@example.test')`,
    `INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES ('${otherHash}', 'e2e-other', ${now}, ${now + 86_400_000})`,
  ].join("; ") + ";";
  await run(["d1", "execute", "ACCOUNTS", "--local", "--config", config, "--persist-to", state, "--command", sql]);
  worker = spawn("npx", ["wrangler", "dev", "--config", config, "--ip", "127.0.0.1", "--port", "8790",
    "--local-protocol", "https", "--persist-to", state, "--var", "PUBLIC_BASE:https://service.localhost:8790",
    "--var", "PAGE_BASE_DOMAIN:pages.localhost"], { stdio: "inherit" });
  worker.once("exit", code => { console.error(`local Worker exited ${code}`); cleanup(); process.exit(code ?? 1); });
}

function cleanup() { worker?.kill("SIGTERM"); rmSync(state, { recursive: true, force: true }); }
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
main().catch(err => { console.error(err); cleanup(); process.exit(1); });
