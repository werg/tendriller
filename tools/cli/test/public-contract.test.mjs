import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/tendril.mjs", import.meta.url));
const requests = [];
let server, origin, configDir;
before(async () => {
  configDir = mkdtempSync(join(tmpdir(), "tendril-public-cli-"));
  server = createServer(async (req, res) => {
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; }
    let body = "";
    for await (const part of req) body += part;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tendrils") {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "abcdefghijkl", name: "Contract page", lifetime: "ad_hoc", token: "tk_private",
        mode: body ? JSON.parse(body).mode || "interactive" : "interactive",
        api: `${origin}/api/t/abcdefghijkl`, page_url: `${origin}/page/`, agent_setup: { event_delivery: "not_configured" } }));
    } else res.end(JSON.stringify({ ok: true, role: "guest", id: "l_test", url: `${origin}/guest/` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(configDir, { recursive: true, force: true });
});

function cli(args, extra = {}) {
  return new Promise((resolve) => execFile(process.execPath, [cliPath, ...args], { timeout: 10000,
    env: { ...process.env, TENDRIL_CONFIG_DIR: configDir, TENDRIL_SERVER: origin,
      TENDRIL_API: `${origin}/api/t/abcdefghijkl`, TENDRIL_TOKEN: "tk_private", TENDRIL_OWNER: "", ...extra },
  }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
}

test("new requires a verified owner before making a request", async () => {
  const before = requests.length;
  const result = await cli(["new", "A page"]);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /--owner <verified-email>/);
  assert.equal(requests.length, before);
});

test("new creates ad_hoc with owner and never sends a retired creation key", async () => {
  const result = await cli(["new", "A page", "--owner", "person@example.com"], { TENDRIL_CREATE_KEY: "retired-secret" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1), { method: "POST", path: "/api/tendrils", authorization: undefined,
    body: { name: "A page", owner: "person@example.com", lifetime: "ad_hoc" } });
  assert.equal(JSON.parse(result.stdout).lifetime, "ad_hoc");
  assert.match(result.stderr, /verifying the live listener/);
  assert.equal((await cli(["new", "Environment owner"], { TENDRIL_OWNER: "owner@example.com" })).code, 0);
  assert.equal(requests.at(-1).body.owner, "owner@example.com");
});

test("creation selects either supported mode and rejects misspelled options before creating a page", async () => {
  for (const mode of ["interactive", "dashboard"]) {
    const result = await cli(["new", "Mode test", "--owner", "person@example.com", "--mode", mode]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.at(-1).body.mode, mode);
    assert.equal(JSON.parse(result.stdout).mode, mode);
    if (mode === "dashboard") assert.match(result.stderr, /Dashboard URL:/);
  }
  const count = requests.length;
  for (const flags of [["--mode", "hybrid"], ["--mdoe", "dashboard"], ["--mode", "--pretty"]]) {
    const result = await cli(["new", "--owner", "person@example.com", ...flags]);
    assert.equal(result.code, 64, result.stderr);
  }
  assert.equal(requests.length, count);
});

test("retired creation, pairing, role and link options fail locally with recovery guidance", async () => {
  const cases = [
    [["new", "--owner", "person@example.com", "--resident"], /does not support/],
    [["new", "--owner", "person@example.com", "--create-key", "secret"], /does not support/],
    [["new", "--owner", "person@example.com", "--pairing", "open"], /does not support/],
    [["meta", "--pairing", "required"], /does not support/],
    [["devices", "approve", "d_example"], /cannot approve devices or change roles/],
    [["link", "display"], /owner page control/],
    [["link", "owner"], /main link is the owner link/],
    [["link", "rm"], /link rm <id>/],
  ];
  const before = requests.length;
  for (const [args, message] of cases) {
    const result = await cli(args);
    assert.equal(result.code, 64, result.stderr);
    assert.match(result.stderr, message);
  }
  assert.equal(requests.length, before);
});

test("supported mutations match the current public service routes", async () => {
  assert.equal((await cli(["meta", "--lifetime", "resident"])).code, 0);
  assert.deepEqual(requests.at(-1).body, { lifetime: "resident" });
  assert.equal((await cli(["devices", "rename", "d_example", "Kitchen", "tablet"])).code, 0);
  assert.deepEqual(requests.at(-1).body, { name: "Kitchen tablet" });
  assert.equal((await cli(["link", "guest", "--label", "Workshop", "--expires", "3600"])).code, 0);
  assert.deepEqual(requests.at(-1).body, { role: "guest", label: "Workshop", expires_in: 3600 });
  assert.equal((await cli(["link", "rotate"])).code, 0);
  assert.equal(requests.at(-1).path, "/api/t/abcdefghijkl/links/l_main/rotate");
  const blob = "b_aaaaaaaaaaaaaaaaaaaa";
  assert.equal((await cli(["blobs", "keep", blob])).code, 0);
  assert.deepEqual(requests.at(-1).body, { keep: true });
  assert.equal((await cli(["blobs", "expire", blob])).code, 0);
  assert.deepEqual(requests.at(-1).body, { keep: false });
});

test("push notification commands expose readiness and preserve delivery targeting", async () => {
  const status = await cli(["notifications"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(requests.at(-1).method, "GET");
  assert.equal(requests.at(-1).path, "/api/t/abcdefghijkl/notify");
  assert.equal(requests.at(-1).authorization, "Bearer tk_private");
  const notification = await cli(["notify", "Decision needed", "Please approve this job",
    "--url", "/page/", "--device", "d_example", "--tag", "approval-42"]);
  assert.equal(notification.code, 0, notification.stderr);
  assert.deepEqual(requests.at(-1), {
    method: "POST", path: "/api/t/abcdefghijkl/notify", authorization: "Bearer tk_private",
    body: { title: "Decision needed", body: "Please approve this job",
      url: "/page/", device: "d_example", tag: "approval-42" },
  });
});

test("durable work commands preserve targets, revisions and explicit publication review", async () => {
  for (const [args, method, path, body] of [
    [["devices", "purpose", "d_example", "speaker"], "PATCH", "/devices/d_example", { purpose: "speaker" }],
    [["focus", "d_example", "--ttl", "60"], "POST", "/focus", { device: "d_example", ttl_seconds: 60 }],
    [["focus", "off"], "POST", "/focus", { device: null }],
    [["say", "Next step", "--device", "d_display", "--speak-on", "d_speaker"], "POST", "/say", { text: "Next step", speak: true, device: "d_display", speak_on: "d_speaker" }],
    [["timers", "add", '{"title":"Check","due_at":1794810000000}'], "POST", "/timers", { title: "Check", due_at: 1794810000000 }],
    [["timers", "cancel", "timer-id"], "PATCH", "/timers/timer-id", { state: "cancelled" }],
    [["session", "set", '{"purpose":"Garden","expected_revision":4}'], "PUT", "/session", { purpose: "Garden", expected_revision: 4 }],
    [["bundle", "publish", "--expected-version", "0"], "POST", "/bundle/publish", { expected_version: 0 }],

  ]) {
    const result = await cli(args); assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.at(-1).method, method); assert.equal(requests.at(-1).path, "/api/t/abcdefghijkl" + path); const actual = requests.at(-1).body; if (path === "/bundle/publish") { assert.match(actual.cid, /^[a-f0-9-]+$/); assert.deepEqual(actual.expected_generations, {}); delete actual.cid; delete actual.expected_generations; } assert.deepEqual(actual, body);
  }
  const count = requests.length;
  assert.equal((await cli(["bundle", "publish"])).code, 64);
  assert.equal((await cli(["devices", "purpose", "d_example", "owner"])).code, 64);
  assert.equal((await cli(["remix"])).code, 64);
  assert.equal(requests.length, count);
  assert.equal((await cli(["bundle", "export", "--include-data"])).code, 0);
  assert.equal(requests.at(-1).path, "/api/t/abcdefghijkl/bundle?include_data=true");
});
