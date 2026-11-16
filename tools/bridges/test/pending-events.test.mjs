import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingEvents, acknowledgeEvents } from "../lib/pending-events.mjs";

const cli = fileURLToPath(new URL("../../cli/bin/tendril.mjs", import.meta.url));
const standalone = fileURLToPath(new URL("../bin/tendril-events.mjs", import.meta.url));
const token = "tk_" + "b".repeat(32);
const application = seq => ({ seq, ts: 1000 + seq, type: "instruction", role: "owner", device: "d_owner", by: null, wake: true, withheld: false, data: { text: `Request ${seq}` } });
const probe = seq => ({ ...application(seq), type: "event", role: null, device: null, by: "agent_probe", data: { kind: "delivery_probe", nonce: "a".repeat(19) + "abcdefghijklmnopqrstuvwxyz234567"[seq % 32] } });

async function fixture(t, events) {
  const directory = mkdtempSync(join(tmpdir(), "tendril-pending-"));
  const checkpoint = join(directory, "events.json");
  const seen = [];
  const options = { events, response: null, failProbe: null, afterRead: null };
  let readThrough = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; }
    const url = new URL(req.url, "http://localhost");
    seen.push({ method: req.method, path: url.pathname, after: url.searchParams.get("after"), auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"error":{"code":"unauthorized"}}'); return; }
    if (url.pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("after"));
      const entries = options.events.filter(event => event.seq > after).slice(0, Number(url.searchParams.get("limit") || 100));
      const cursor = entries.at(-1)?.seq ?? after;
      readThrough = Math.max(readThrough, cursor);
      if (options.afterRead) await options.afterRead();
      res.end(JSON.stringify(options.response || { events: entries, cursor, withheld: 0 })); return;
    }
    const nonce = /\/wake\/probe\/([a-z2-7]{20})\/ack$/.exec(url.pathname)?.[1];
    const event = options.events.find(event => event.data.nonce === nonce);
    if (options.failProbe === event?.seq) { res.statusCode = 503; res.end('{"error":{"code":"unavailable"}}'); return; }
    if (options.expiredProbe === event?.seq) { res.statusCode = 404; res.end('{"error":{"code":"not_found","message":"Delivery probe is unknown or expired"}}'); return; }
    if (event && readThrough >= event.seq) { res.end(JSON.stringify({ nonce, seq: event.seq, created_at: event.ts, ack_at: 2000 })); return; }
    res.statusCode = 404; res.end('{"error":{"code":"not_found"}}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const cfg = { id: "aaaaaaaaaaaa", api: `http://127.0.0.1:${server.address().port}/api/t/aaaaaaaaaaaa`, token };
  const handle = join(directory, "page.json");
  writeFileSync(handle, JSON.stringify(cfg), { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { cfg, directory, checkpoint, handle, options, seen };
}

async function run(script, args, f) {
  return new Promise(resolve => execFile(process.execPath, [script, ...args], {
    cwd: f.directory, timeout: 5000,
    env: { ...process.env, TENDRIL_API: f.cfg.api, TENDRIL_TOKEN: token, TENDRIL_CONFIG_DIR: f.directory, TENDRIL_NAME: "", TENDRIL_CHECKPOINT_FILE: f.checkpoint },
  }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
}
const saved = f => JSON.parse(readFileSync(f.checkpoint, "utf8"));

test("probe-only pending saves handled progress and the next read is empty", async t => {
  const f = await fixture(t, [probe(1), probe(2)]);
  const first = await run(cli, ["pending"], f);
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.deepEqual(result.events, []);
  assert.equal(result.handled_cursor, 2);
  assert.equal(result.cursor, 2);
  assert.deepEqual(result.probes.map(p => p.status), ["acknowledged", "acknowledged"]);
  assert.equal(saved(f).handled_cursor, 2);
  assert.equal(statSync(f.checkpoint).mode & 0o777, 0o600);
  const second = await run(cli, ["pending"], f);
  assert.equal(JSON.parse(second.stdout).cursor, 2);
  assert.equal(f.seen.at(-1).after, "2");
  assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token));
});

test("mixed input replays until explicit acknowledgement and never skips an unhandled event", async t => {
  const f = await fixture(t, [probe(1), application(2), probe(3), application(4)]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await pendingEvents(f.cfg, f.checkpoint);
    assert.deepEqual(result.events.map(e => e.seq), [2, 4]);
    assert.equal(result.handled_cursor, 1);
    assert.equal(result.cursor, 4);
    assert.equal(saved(f).handled_cursor, 1);
  }
  assert.equal((await run(cli, ["ack", "2"], f)).code, 0);
  const next = await pendingEvents(f.cfg, f.checkpoint);
  assert.deepEqual(next.events.map(e => e.seq), [4]);
  assert.equal(next.handled_cursor, 3);
  const beyond = await run(cli, ["ack", "5"], f);
  assert.equal(beyond.code, 1); assert.equal(JSON.parse(beyond.stderr).error.code, "unseen_cursor");
  await assert.rejects(acknowledgeEvents(f.cfg, f.checkpoint, 2), { code: "checkpoint_regression" });
  assert.equal(saved(f).handled_cursor, 3);
  await acknowledgeEvents(f.cfg, f.checkpoint, 4);
  await acknowledgeEvents(f.cfg, f.checkpoint, 4); // acknowledgement is idempotent
  assert.deepEqual((await pendingEvents(f.cfg, f.checkpoint)).events, []);
});

test("a batch is bounded, and application data cannot impersonate a probe or choose an ack URL", async t => {
  const fake = { ...application(1), data: { kind: "delivery_probe", nonce: probe(1).data.nonce, ack_url: "https://untrusted.invalid/" } };
  const f = await fixture(t, [fake, probe(2), application(3)]);
  const result = await pendingEvents(f.cfg, f.checkpoint, { limit: 2 });
  assert.deepEqual(result.events, [fake]);
  assert.equal(result.handled_cursor, 0);
  assert.equal(result.cursor, 2);
  assert.equal(result.has_more, true);
  assert.equal(f.seen.filter(r => r.method === "POST").length, 1);
  assert.match(f.seen.at(-1).path, /\/wake\/probe\/[a-z2-7]{20}\/ack$/);
  await assert.rejects(acknowledgeEvents(f.cfg, f.checkpoint, 3), { code: "unseen_cursor" });
});

test("failed probe acknowledgement leaves all input replayable; expired probes are explicit", async t => {
  const f = await fixture(t, [probe(1), application(2), probe(3)]);
  f.options.failProbe = 3;
  await assert.rejects(pendingEvents(f.cfg, f.checkpoint), e => e.status === 503);
  assert.equal(existsSync(f.checkpoint), false);
  assert.equal(existsSync(f.checkpoint + ".lock"), false);
  f.options.failProbe = null;
  f.options.expiredProbe = 1;
  const retry = await pendingEvents(f.cfg, f.checkpoint);
  assert.equal(f.seen.findLast(r => r.method === "GET").after, "0");
  assert.deepEqual(retry.events.map(e => e.seq), [2]);
  assert.deepEqual(retry.probes.map(p => p.status), ["expired", "acknowledged"]);
  assert.equal(retry.handled_cursor, 1);
});

test("malformed batches, corrupt files and mismatched pages cannot advance a checkpoint", async t => {
  const f = await fixture(t, [probe(1)]);
  f.options.response = { events: [probe(1)], cursor: 500, withheld: 0 };
  await assert.rejects(pendingEvents(f.cfg, f.checkpoint), { code: "invalid_response" });
  assert.equal(f.seen.length, 1); // did not even acknowledge the probe
  assert.equal(existsSync(f.checkpoint), false);
  writeFileSync(f.checkpoint, '{"handled_cursor":999');
  await assert.rejects(pendingEvents(f.cfg, f.checkpoint), { code: "invalid_checkpoint" });
  assert.equal(f.seen.length, 1);
  writeFileSync(f.checkpoint, JSON.stringify({ version: 1, api: "https://other.invalid/api/t/page", handled_cursor: 0, delivered_cursor: 0 }));
  await assert.rejects(pendingEvents(f.cfg, f.checkpoint), { code: "checkpoint_mismatch" });
  assert.equal(f.seen.length, 1);
});

test("a checkpoint write failure is reported and acknowledged probes can safely replay", async t => {
  const f = await fixture(t, [probe(1), application(2)]);
  f.options.afterRead = () => mkdirSync(f.checkpoint);
  await assert.rejects(pendingEvents(f.cfg, f.checkpoint), e => ["EISDIR", "ENOTDIR"].includes(e.code));
  assert.equal(existsSync(f.checkpoint + ".lock"), false);
  rmSync(f.checkpoint, { recursive: true });
  f.options.afterRead = null;
  const retry = await pendingEvents(f.cfg, f.checkpoint);
  assert.equal(retry.after, 0);
  assert.equal(retry.handled_cursor, 1);
  assert.deepEqual(retry.events.map(e => e.seq), [2]);
  assert.equal(f.seen.filter(r => r.method === "POST").length, 2);
});

test("concurrent commands cannot race a handled checkpoint backwards", async t => {
  const f = await fixture(t, [application(1)]);
  let release, observed;
  const reading = new Promise(resolve => { observed = resolve; });
  f.options.afterRead = () => { observed(); return new Promise(resolve => { release = resolve; }); };
  const pending = pendingEvents(f.cfg, f.checkpoint);
  await reading;
  await assert.rejects(acknowledgeEvents(f.cfg, f.checkpoint, 0), { code: "checkpoint_busy" });
  release(); await pending;
  await acknowledgeEvents(f.cfg, f.checkpoint, 1);
  assert.equal(saved(f).handled_cursor, 1);
});

test("standalone helper starts a fresh handled checkpoint and validates options", async t => {
  const f = await fixture(t, [application(7), probe(8), application(9)]);
  writeFileSync(f.handle, JSON.stringify({ ...f.cfg, cursor: 7 }));
  const first = await run(standalone, [f.handle], f);
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.after, 0);
  assert.equal(result.handled_cursor, 0);
  assert.equal(result.checkpoint_file, f.handle + ".events.json");
  assert.deepEqual(result.events.map(e => e.seq), [7, 9]);
  assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token));
  // A read cursor must not move handling past the unprocessed event.
  writeFileSync(f.handle, JSON.stringify({ ...f.cfg, cursor: 100 }));
  const replay = await run(standalone, [f.handle, "pending"], f);
  assert.equal(JSON.parse(replay.stdout).after, 0);
  assert.equal((await run(standalone, [f.handle, "ack", "9"], f)).code, 0);
  for (const args of [["pending", "--limit", "501"], ["pending", "--limit", "NaN"], ["pending", "--after", "100"], ["ack", "9", "--limit", "2"]])
    assert.equal((await run(standalone, [f.handle, ...args], f)).code, 64);
  writeFileSync(f.handle, `{"token":"${token}", broken`);
  const broken = await run(standalone, [f.handle], f);
  assert.equal(broken.code, 1);
  assert.ok(!broken.stderr.includes(token));
});
