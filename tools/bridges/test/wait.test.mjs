// tendril-wait.sh and `tendril wait` against a mock events endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../scripts/tendril-wait.sh");
const cli = join(here, "../../cli/bin/tendril.mjs");

function mock() {
  const seen = [];
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; }
    const u = new URL(req.url, "http://x");
    seen.push({ path: u.pathname, after: u.searchParams.get("after"), wait: u.searchParams.get("wait"), auth: req.headers.authorization });
    calls++;
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer tk_test") { res.statusCode = 401; return res.end('{"error":{"code":"unauthorized"}}'); }
    if (calls === 1) { res.statusCode = 503; return res.end("{}"); }
    if (calls === 2) return res.end(JSON.stringify({ events: [], cursor: Number(u.searchParams.get("after")), timeout: true, withheld: 0 }));
    res.end(JSON.stringify({
      events: [
        { seq: 8, ts: 1, type: "event", data: { note: "\"cursor\":999" }, device: "d_1", role: "owner", wake: false, withheld: false, by: null },
        { seq: 9, ts: 2, type: "instruction", data: { text: "add milk", via: "text" }, device: "d_1", role: "owner", wake: true, withheld: false, by: null },
      ],
      cursor: 9, withheld: 1,
    }));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

const run = (cmd, args, env) => new Promise((ok) => {
  execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 20000 }, (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
});

for (const noPy of ["", "1"]) {
  test(`tendril-wait.sh exits on a wake and advances the cursor${noPy ? " (no python)" : ""}`, async () => {
    const { server, seen, base } = await mock();
    const dir = mkdtempSync(join(tmpdir(), "tw-"));
    const cursor = join(dir, "c");
    writeFileSync(cursor, "7\n");
    const r = await run("sh", [script, cursor], { TENDRIL_API: `${base}/api/t/abc234abc234`, TENDRIL_TOKEN: "tk_test", TENDRIL_NO_PYTHON: noPy });
    server.close();
    assert.equal(r.code, 0, r.stderr);
    const [summary, json] = r.stdout.split("\n");
    assert.match(summary, /^tendril: 2 event\(s\) waiting, 1 owner instruction\(s\), 1 wake\(s\) withheld; cursor 7 -> 9/);
    assert.equal(JSON.parse(json).cursor, 9);
    assert.equal(readFileSync(cursor, "utf8").trim(), "9");
    assert.equal(readFileSync(cursor + ".prev", "utf8").trim(), "7");
    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map((s) => s.after), ["7", "7", "7"]);
    assert.ok(seen.every((s) => s.wait === "300" && s.path === "/api/t/abc234abc234/events"));
  });
}

test("tendril-wait.sh exits 1 on a rejected token", async () => {
  const { server, base } = await mock();
  const dir = mkdtempSync(join(tmpdir(), "tw-"));
  const r = await run("sh", [script, join(dir, "c")], { TENDRIL_API: `${base}/api/t/x`, TENDRIL_TOKEN: "tk_bad" });
  server.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 401/);
});

test("tendril wait (CLI) behaves the same", async () => {
  const { server, base } = await mock();
  const dir = mkdtempSync(join(tmpdir(), "tw-"));
  const r = await run("node", [cli, "wait"], { TENDRIL_API: `${base}/api/t/abc234abc234`, TENDRIL_TOKEN: "tk_test", TENDRIL_CONFIG_DIR: dir });
  server.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).events.length, 2);
  assert.equal(readFileSync(join(dir, "cursors", "abc234abc234.cursor"), "utf8").trim(), "9");
});

test("invalid polling numbers fail locally instead of starting an endless retry loop", async () => {
  const { server, seen, base } = await mock();
  const dir = mkdtempSync(join(tmpdir(), "tw-"));
  try {
    for (const args of [["wait", "--timeout", "NaN"], ["wait", "--timeout", "-1"],
      ["events", "--follow", "--wait", "-1"], ["events", "--wait", "301"], ["events", "--limit", "0"], ["events", "--after", "1.5"]]) {
      const r = await run("node", [cli, ...args], { TENDRIL_API: `${base}/api/t/abc234abc234`, TENDRIL_TOKEN: "tk_test", TENDRIL_CONFIG_DIR: dir });
      assert.equal(r.code, 64, r.stderr);
    }
    assert.equal(seen.length, 0);
  } finally { server.close(); }
});

test("permanent HTTP errors stop follow and wait without retrying", async () => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.writeHead(403, { "content-type": "application/json" }); res.end('{"error":{"code":"forbidden","message":"Access denied"}}'); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "tw-"));
  try {
    for (const args of [["wait"], ["events", "--follow"]]) {
      const r = await run("node", [cli, ...args], { TENDRIL_API: `http://127.0.0.1:${server.address().port}/api/t/abc234abc234`, TENDRIL_TOKEN: "tk_test", TENDRIL_CONFIG_DIR: dir });
      assert.equal(r.code, 1, r.stderr);
      assert.equal(JSON.parse(r.stderr).status, 403);
    }
    assert.equal(calls, 2);
  } finally { server.close(); }
});
