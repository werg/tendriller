import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, CORE_RELEASE } from "@tendriller/core/contract";

const cli = fileURLToPath(new URL("../bin/tendril.mjs", import.meta.url));
const run = (args, env) => new Promise(resolve => execFile(process.execPath, [cli, ...args],
  { env: { ...process.env, ...env }, timeout: 15000 },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

test("timer CLI recovers original commands after lost replies without refreshing revisions or generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "tendriller-timers-"));
  const requests = [], receipts = new Map();
  let creations = 0, timerReads = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname.replace("/api/t/abcdefghijkl", "");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/service") return json({ contract: CONTRACT_VERSION, core_release: CORE_RELEASE, workflows: [], limits: {} });
    if (req.method === "GET") { timerReads++; return json({ error: { code: "unexpected_read" } }, 500); }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ method: req.method, path, body });
    const prior = receipts.get(body.cid);
    if (prior) { assert.deepEqual(body, prior.body); return json(prior.result); }
    assert.deepEqual(body.expected_generations, { schedule: "reviewed-generation" });
    assert.equal(body.scope, "schedule");
    const base = { id: "timer-id", revision: 1, title: "Review", due_at: 1794810000000, timezone: "UTC",
      missed: "fire_once", notify: false, state: "scheduled", created_at: 1000, updated_at: 1000 };
    let result;
    if (req.method === "POST") { creations++; result = { ...base, id: `timer-${creations}` }; }
    else {
      assert.equal(body.expected_revision, 7, "the explicitly reviewed revision must be preserved");
      result = req.method === "DELETE" ? { id: base.id, revision: 8, deleted: true }
        : { ...base, revision: 8, state: body.state ?? "scheduled", title: body.title ?? base.title };
    }
    receipts.set(body.cid, { body, result });
    res.destroy(); // Commit happened; the first response never reaches the caller.
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const env = { TENDRIL_API: `http://127.0.0.1:${server.address().port}/api/t/abcdefghijkl`,
      TENDRIL_TOKEN: "tk_test", TENDRIL_CONFIG_DIR: join(root, "config") };
    for (const [name, args] of [
      ["create", ["timers", "add", '{"title":"Review","due_at":1794810000000}']],
      ["update", ["timers", "update", "timer-id", '{"title":"Revised"}', "--revision", "7"]],
      ["cancel", ["timers", "cancel", "timer-id", "--revision", "7"]],
      ["delete", ["timers", "rm", "timer-id", "--revision", "7"]],
    ]) {
      const record = join(root, `${name}.json`);
      const command = [...args, "--resume-file", record, "--scope", "schedule", "--generations", '{"schedule":"reviewed-generation"}'];
      const lost = await run(command, env); assert.notEqual(lost.code, 0);
      const pending = JSON.parse(readFileSync(record, "utf8"));
      assert.equal(pending.phase, "pending"); assert.match(pending.request.cid, /^[a-f0-9-]+$/);
      const retry = await run(command, env); assert.equal(retry.code, 0, retry.stderr);
      assert.deepEqual(JSON.parse(retry.stdout), receipts.get(pending.request.cid).result);
      const count = requests.length;
      const known = await run(command, env); assert.equal(known.code, 0, known.stderr);
      assert.equal(requests.length, count, "a saved accepted receipt needs no repeat request");
      assert.deepEqual(JSON.parse(known.stdout), JSON.parse(retry.stdout));
      const changed = await run([...command, "--generations", '{"schedule":"newer-generation"}'], env);
      assert.notEqual(changed.code, 0); assert.match(changed.stderr, /does not match this intent/);
      assert.equal(requests.length, count, "new guards must not replace the reviewed command");
    }
    assert.equal(creations, 1); assert.equal(timerReads, 0); assert.equal(requests.length, 8);

    const distinct = ["timers", "add", '{"title":"Review","due_at":1794810000000}', "--cid", "deliberately-new",
      "--scope", "schedule", "--generations", '{"schedule":"reviewed-generation"}'];
    assert.notEqual((await run(distinct, env)).code, 0);
    const recovered = await run(distinct, env); assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(creations, 2, "an explicit new CID can intentionally create otherwise identical work");

    const before = requests.length;
    const changedReview = await run(["timers", "cancel", "timer-id", "--revision", "8", "--resume-file", join(root, "cancel.json"),
      "--scope", "schedule", "--generations", '{"schedule":"reviewed-generation"}'], env);
    assert.notEqual(changedReview.code, 0); assert.match(changedReview.stderr, /does not match this intent/);
    assert.equal(requests.length, before);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("timer CLI preserves a rejected reviewed command and exposes its conflict without retrying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tendriller-timer-conflict-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/service") return res.end(JSON.stringify({ contract: CONTRACT_VERSION, core_release: CORE_RELEASE, workflows: [], limits: {} }));
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw)); res.statusCode = 409;
    res.end(JSON.stringify({ error: { code: "timer_conflict", message: "Timer changed; review its current revision", current: 9 } }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const env = { TENDRIL_API: `http://127.0.0.1:${server.address().port}/api/t/abcdefghijkl`,
      TENDRIL_TOKEN: "tk_test", TENDRIL_CONFIG_DIR: join(root, "config") };
    const record = join(root, "stale.json"), args = ["timers", "rm", "timer-id", "--revision", "7", "--resume-file", record];
    const first = await run(args, env); assert.equal(first.code, 4); assert.match(first.stderr, /timer_conflict/);
    assert.equal(requests.length, 1); assert.equal(JSON.parse(readFileSync(record, "utf8")).request.expected_revision, 7);
    assert.equal((await run(args, env)).code, 4); assert.deepEqual(requests[1], requests[0]);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
