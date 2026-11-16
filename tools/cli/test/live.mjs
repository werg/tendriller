// Run against a disposable dashboard page on a real service:
// TENDRIL_API=... TENDRIL_TOKEN=... node tools/cli/test/live.mjs
// Uses only the public CLI. The caller owns page creation and teardown.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.TENDRIL_API || !process.env.TENDRIL_TOKEN)
  throw new Error("Select a disposable dashboard page with TENDRIL_API and TENDRIL_TOKEN");
const cli = process.env.TENDRIL_CLI || fileURLToPath(new URL("../bin/tendril.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "tendril-storage-live-"));
const env = { ...process.env, TENDRIL_NAME: "", TENDRIL_CONFIG_DIR: join(root, "config") };
const run = (...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args],
  { env, timeout: 30_000 }, (error, stdout, stderr) => {
    let value; try { value = JSON.parse(stdout); } catch {}
    resolve({ code: error?.code || 0, value, stderr });
  }));
const command = async (...args) => {
  const result = await run(...args);
  assert.equal(result.code, 0, result.stderr);
  return result.value;
};
const payload = Buffer.from([0, 255, 1, 254, 128, 0, 42]);
const sha256 = createHash("sha256").update(payload).digest("hex");
try {
  const page = await command("info");
  assert.equal(page.mode, "dashboard", "This check requires a disposable dashboard page");
  const source = join(root, "payload.bin"); writeFileSync(source, payload);
  const uploaded = await command("blob", "upload", source);
  assert.equal(uploaded.status, "completed");
  assert.equal(uploaded.blob.sha256, sha256);
  assert.deepEqual(await command("blob", "upload", source), uploaded, "same intent retains its accepted receipt");
  const metadata = await command("blob", "info", uploaded.blob.id);
  assert.equal(metadata.size, payload.length);
  const destination = join(root, "download.bin");
  await command("blob", "download", uploaded.blob.id, destination);
  assert.deepEqual(readFileSync(destination), payload);

  const path = `checks/${randomUUID()}/payload.bin`;
  const first = await command("file", "put", path, source);
  assert.equal(first.file.revision, 1);
  const stale = await run("file", "put", path, source, "--revision", "0", "--cid", randomUUID());
  assert.equal(stale.code, 4, "a stale explicit revision must conflict");
  const removed = await command("file", "delete", path, "--revision", "1");
  assert.equal(removed.file.blob_id, null);
  const restored = await command("file", "put", path, source, "--cid", randomUUID());
  assert.equal(restored.file.revision, 3, "recreation captures the tombstone revision");
  const sharedDestination = join(root, "shared.bin");
  await command("file", "get", path, sharedDestination);
  assert.deepEqual(readFileSync(sharedDestination), payload);

  const directory = join(root, "page"); mkdirSync(directory);
  writeFileSync(join(directory, "report.html"), "<!doctype html><title>Verified storage publication</title>");
  writeFileSync(join(directory, "payload.bin"), payload);
  const publication = await command("push", directory, "--entry", "report.html", "--no-wait");
  assert.equal(publication.files, 2);
  const manifest = await command("publication", String(publication.version));
  assert.equal(manifest.entry, "report.html");
  assert.equal(manifest.files.find(file => file.path === "payload.bin").sha256, sha256);
  const repeated = await command("push", directory, "--entry", "report.html", "--no-wait", "--cid", randomUUID());
  assert.equal(repeated.reused, 2, "unchanged publication bytes reuse verified blob references");
  const selected = await command("rollback", String(publication.version));
  assert.ok(selected.head_revision > repeated.head_revision);
  console.log("PASS real-service immutable uploads, verified downloads, shared-file CAS/tombstones and publication reuse/rollback");
} finally {
  rmSync(root, { recursive: true, force: true });
}
