import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertValid, validate, schemas, schemaDocument, ContractError } from "../index.mjs";
import { createPage, createClient, ApiError, requireService, describeService } from "../client.mjs";

test("public creation requires an owner and valid lifecycle", async () => {
  let called = false;
  const fetch = async () => { called = true; throw Error("unexpected request"); };
  await assert.rejects(createPage("https://example.test", { name: "Kitchen", lifetime: "resident" }, { fetch }), ContractError);
  assert.equal(called, false);
  assert.equal(validate("create", { owner: "owner@example.test", name: "Kitchen" }).length, 0);
  for (const body of [{ owner: "not-an-email" }, { owner: "owner@example.test", pairing: "open" }, { owner: "owner@example.test", lifetime: "resident" }])
    assert.ok(validate("create", body).length);
});

test("schemas distinguish accepted, queued and rejected results", () => {
  for (const result of [{ status: "accepted", seq: 1 }, { status: "queued" }, { status: "rejected", error: "forbidden" }])
    assert.equal(validate("sendResult", result).length, 0);
  assert.ok(validate("sendResult", { queued: false }).length);
  assert.ok(validate("sendResult", { status: "queued", seq: 1 }).length);
  const blob = { id: "b_" + "a".repeat(20), url: "_tendril/blob/photo", retention: { keep: false, expires_at: 1000 } };
  assert.equal(validate("captureResult", { capture_id: "capture-1", status: "accepted", seq: 1, blob }).length, 0);
  assert.ok(validate("captureResult", { capture_id: "capture-1", status: "accepted", seq: 1 }).length);
  assert.ok(validate("captureResult", { status: "queued" }).length);
});

test("set(null) and delete are distinct public operations", () => {
  assert.deepEqual(assertValid("stateOperations", [{ op: "set", path: ["reading"], value: null }]), [{ op: "set", path: ["reading"], value: null }]);
  assert.ok(validate("stateOperations", [{ op: "delete", path: ["reading"], value: 1 }]).length);
});

test("generated schemas match the executable and MCP-facing schema", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("../v2.json", import.meta.url))), schemaDocument);
});

test("client keeps explicit cursor, validates writes and returns actionable errors", async () => {
  const seen = [];
  const client = createClient({ api: "https://example.test/api/t/id/", token: "tk_test" }, {
    fetch: async (url, options) => { seen.push({ url, options }); return new Response(JSON.stringify({ events: [], cursor: 7, withheld: 0 }), { status: 200 }); },
  });
  assert.equal((await client.readEvents({ after: 7, wait: 3 })).cursor, 7);
  assert.match(seen[0].url, /events\?after=7&wait=3$/);
  assert.equal(seen[0].options.headers.Authorization, "Bearer tk_test");
  assert.throws(() => client.readEvents({}), /explicit/);
  assert.throws(() => client.say({ text: "Hi", unexpected: true }), ContractError);
  const denied = createClient({ api: "https://example.test", token: "tk_test" }, { fetch: async () => new Response(JSON.stringify({ error: { code: "listener_required", message: "Attach this conversation" } }), { status: 428 }) });
  await assert.rejects(denied.info(), error => error instanceof ApiError && error.status === 428 && error.code === "listener_required" && error.message === "Attach this conversation");
});

test("experience write contracts preserve revision checks, roles and bounded schedules", () => {
  assert.equal(validate("sessionWrite", { current_task: "Review readings", expected_revision: 2 }).length, 0);
  assert.ok(validate("sessionWrite", { expected_revision: -1 }).length);
  assert.ok(validate("deviceUpdate", { role: "owner" }).length);
  assert.equal(validate("focusRequest", { device: null }).length, 0);
  for (const repeat of [{ at: "25:00" }, { at: "10:15", days: [] }, { every_minutes: 0 }])
    assert.ok(validate("timerCreate", { title: "Repeat", repeat }).length);
  assert.equal(validate("timerCreate", { title: "Repeat", repeat: { at: "10:15", days: [1, 3] }, timezone: "Europe/Berlin" }).length, 0);
  assert.equal(validate("timerWrite", { repeat: null, device: null, state: "cancelled" }).length, 0);
});

test("exported bundle media can have no name and multi-file templates keep the service bounds", () => {
  const bundle = { format: "tendriller-bundle", version: 1, name: "N".repeat(200), files: [{ path: "index.html", type: "text/html", base64: "AA==" }],
    media: [{ id: "b_" + "a".repeat(20), type: "image/png", name: null, base64: "AA==" }] };
  assert.equal(validate("bundle", bundle).length, 0);
  assert.ok(validate("bundle", { ...bundle, version: 2 }).length);
  assert.ok(validate("bundle", { ...bundle, files: [] }).length);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const manyCaptures = Array.from({ length: 201 }, (_, i) => ({ ...bundle.media[0],
    id: "b_" + "a".repeat(18) + alphabet[Math.floor(i / 32)] + alphabet[i % 32] }));
  assert.equal(validate("bundle", { ...bundle, media: manyCaptures }).length, 0);
  assert.equal(validate("sayMessage", { t: "say", text: "Look here", present: false, speak: true }).length, 0);
  assert.ok(validate("say", { text: "Look here", present: false }).length);
});

test("generic commands keep concurrency context outside opaque data", async () => {
  const body = { cid: "persisted-id", expected_generations: { "opaque-scope": "generation" }, scope: "opaque-scope",
    data: { type: "job.status", session: "application session", experiment: { session_id: "also opaque" } } };
  assert.deepEqual(assertValid("command", body), body);
  assert.ok(validate("command", {...body, expected_generations: undefined}).length);
  assert.ok(validate("stateUpdate", {cid:"write-1",expected_generations:{},ops:[{op:"set",path:[],value:{notebook:1}}]}).length === 0);
  assert.ok(validate("stateUpdate", {notebook:1}).length);
  for (const name of ["decision", "archive", "assignment", "participantResponse", "interface"]) assert.equal(schemas[name], undefined);
  const seen = [];
  const client = createClient({api:"https://example.test/api/t/id",token:"private"}, {fetch: async (url, options) => {
    seen.push({url,body:JSON.parse(options.body)}); return new Response(JSON.stringify({ok:true}));
  }});
  await client.workflow("module/one", "write item", body);
  assert.match(seen[0].url, /workflows\/module%2Fone\/write%20item$/);
  assert.deepEqual(seen[0].body, body);
});

test("service requirements compare interfaces independently of contrib release", async () => {
  const descriptor = {contract:2,core_release:"0.2.0-rc.1",limits:{},workflows:[{id:"sessions",interface_version:"1",schema_version:"1",operations:{}}]};
  assert.equal(requireService(descriptor,{workflows:{sessions:{interface_version:"1",schema_version:"1"}}}), descriptor);
  assert.throws(() => requireService(descriptor,{contract:3}), error => error.code === "contract_mismatch");
  assert.throws(() => requireService(descriptor,{workflows:{sessions:{interface_version:"2",schema_version:"1"}}}), error => error.code === "workflow_mismatch");
  const fetched = await describeService("https://service.example/",{fetch: async url => {
    assert.equal(url,"https://service.example/api/service"); return new Response(JSON.stringify(descriptor));
  }});
  assert.deepEqual(fetched,descriptor);
});

test("typed clients reject successful HTTP responses that break the wire contract", async () => {
  const client = createClient({ api: "https://example.test", token: "tk_test" }, { fetch: async () => new Response(JSON.stringify({ rev: "wrong", state: [] }), { status: 200 }) });
  await assert.rejects(client.state(), error => error instanceof ApiError && error.code === "invalid_response" && error.details.some(issue => issue.path === "$.rev"));
  await assert.rejects(createPage("https://example.test", { owner: "owner@example.test" }, { fetch: async () => new Response('{"id":"page-with-no-credentials"}', { status: 201 }) }), error => error.code === "invalid_response");
});
