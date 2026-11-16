import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../cli/bin/tendril.mjs");
const token = "tk_" + "a".repeat(32);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let n = 0; n < 150; n++) {
    if (predicate()) return;
    await pause(20);
  }
  throw Error("Timed out waiting for the CLI socket or result");
}
function launch(args, env) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.on("exit", code => resolve(code)));
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function fixture() {
  const seen = [];
  let connected, waking = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push(url);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer " + token) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "unauthorized" } }));
      return;
    }
    const events = [
      { seq: 1, ts: 1, type: "event", data: { passive: true }, wake: false, role: "owner" },
      ...(waking ? [{ seq: 2, ts: 2, type: "instruction", data: { text: "go" }, wake: true, role: "owner" }] : []),
    ].filter(event => event.seq > Number(url.searchParams.get("after") || 0));
    res.end(JSON.stringify({ events, cursor: events.at(-1)?.seq ?? Number(url.searchParams.get("after") || 0), withheld: 0 }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", socket => { connected = socket; });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    get socket() { return connected; },
    env: { TENDRIL_API: "http://127.0.0.1:" + server.address().port + "/api/t/aaaaaaaaaaaa",
      TENDRIL_TOKEN: token, TENDRIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "tendril-ws-")) },
    wake() { waking = true; connected.send(JSON.stringify({ t: "wake", seq: 2 })); },
    async close() {
      connected?.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test("CLI wait uses a socket wake and immediate reads without a held HTTP request", async () => {
  const fx = await fixture();
  const run = launch(["wait", "--timeout", "5"], fx.env);
  try {
    await until(() => fx.socket && fx.seen.length > 0);
    assert.equal(run.stdout, "");
    fx.wake();
    assert.equal(await run.done, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).events.map(event => event.seq), [1, 2]);
    assert.equal(readFileSync(join(fx.env.TENDRIL_CONFIG_DIR, "cursors", "aaaaaaaaaaaa.cursor"), "utf8").trim(), "2");
    assert.ok(fx.seen.every(url => !url.searchParams.has("wait")));
  } finally { run.child.kill("SIGKILL"); await fx.close(); }
});

test("CLI events --follow replays after socket connection and streams new wakes", async () => {
  const fx = await fixture();
  const run = launch(["events", "--follow", "--wakes"], fx.env);
  try {
    await until(() => fx.socket && fx.seen.length > 0);
    assert.equal(run.stdout, ""); // the non-waking event is not printed
    fx.wake();
    await until(() => run.stdout.includes('"seq":2'));
    assert.deepEqual(run.stdout.trim().split("\n").map(line => JSON.parse(line).seq), [2]);
    assert.ok(fx.seen.every(url => !url.searchParams.has("wait")));
  } finally { run.child.kill("SIGKILL"); await fx.close(); }
});

test("legacy long-poll options fail locally rather than opening an HTTP request", async () => {
  const env = { TENDRIL_API: "http://127.0.0.1:9/api/t/aaaaaaaaaaaa", TENDRIL_TOKEN: token };
  for (const args of [["events", "--wait", "0"], ["events", "--wait", "300"],
    ["wait", "--timeout", "-1"], ["wait", "--timeout", "NaN"],
    ["events", "--after", "1.5"], ["events", "--limit", "0"]]) {
    const run = launch(args, env);
    assert.equal(await run.done, 64, run.stderr);
  }
});
