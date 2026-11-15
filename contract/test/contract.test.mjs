import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertValid, validate, schemas, schemaDocument, ContractError } from "../index.mjs";
import { createPage, createClient, ApiError } from "../client.mjs";

test("public creation rejects the obsolete CLI contract before a request", async () => {
  let called = false;
  const fetch = async () => { called = true; throw Error("unexpected request"); };
  await assert.rejects(createPage("https://example.test", { name: "Kitchen", lifetime: "resident" }, { fetch }), ContractError);
  assert.equal(called, false);
  assert.equal(validate("create", { owner: "owner@example.test", name: "Kitchen" }).length, 0);
  for (const body of [{ owner: "not-an-email" }, { owner: "owner@example.test", pairing: "open" }, { owner: "owner@example.test", lifetime: "resident" }])
    assert.ok(validate("create", body).length);
});

test("schemas distinguish accepted, queued and rejected results", () => {
  for (const result of [{ status: "accepted", queued: false, seq: 1 }, { status: "queued", queued: true }, { status: "rejected", queued: false, error: "forbidden" }])
    assert.equal(validate("sendResult", result).length, 0);
  assert.ok(validate("sendResult", { queued: false }).length);
  assert.ok(validate("sendResult", { status: "queued", queued: true, seq: 1 }).length);
  const blob = { id: "b_" + "a".repeat(20), url: "_tendril/blob/photo", retention: { keep: false, expires_at: 1000 } };
  assert.equal(validate("captureResult", { capture_id: "capture-1", status: "accepted", queued: false, seq: 1, blob }).length, 0);
  assert.ok(validate("captureResult", { capture_id: "capture-1", status: "accepted", queued: false, seq: 1 }).length);
  assert.ok(validate("captureResult", { status: "queued", queued: true }).length);
});

test("set(null) and delete are distinct public operations; UI blocks are bounded", () => {
  assert.deepEqual(assertValid("stateOperations", [{ op: "set", path: ["reading"], value: null }]), [{ op: "set", path: ["reading"], value: null }]);
  assert.ok(validate("stateOperations", [{ op: "delete", path: ["reading"], value: 1 }]).length);
  assert.ok(validate("interface", { blocks: [{ id: "missing", type: "unknown" }] }).length);
  assert.ok(validate("interface", { blocks: Array.from({ length: 41 }, (_, i) => ({ id: String(i), type: "text" })) }).length);
  assert.ok(validate("interface", { blocks: [], unrecognised: true }).length);
});

test("generated schemas match the executable and MCP-facing schema", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("../v1.json", import.meta.url))), schemaDocument);
  const ui = JSON.parse(readFileSync(new URL("../../recipes/ui-schema.json", import.meta.url)));
  assert.deepEqual(ui.properties, schemas.interface.properties);
});

test("client keeps explicit cursor, validates writes and returns actionable errors", async () => {
  const seen = [];
  const client = createClient({ api: "https://example.test/api/t/id/", token: "tk_test" }, {
    fetch: async (url, options) => { seen.push({ url, options }); return new Response(JSON.stringify({ events: [], cursor: 7 }), { status: 200 }); },
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
  assert.equal(validate("decisionUpdate", { expected_version: 2, status: "completed", result: "Published" }).length, 0);
  assert.ok(validate("decisionUpdate", { status: "completed" }).length);
  assert.ok(validate("decisionUpdate", { expected_version: 1, status: "approved" }).length);
  assert.equal(validate("decisionResponse", { expected_version: 1, decision: "approve" }).length, 0);
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
  assert.equal(validate("sayMessage", { t: "say", text: "Look here", present: false, speak: true }).length, 0);
  assert.ok(validate("say", { text: "Look here", present: false }).length);
});

test("typed experience client carries compare-and-set versions and encodes resource IDs", async () => {
  const seen = [];
  const client = createClient({ api: "https://example.test/api/t/id", token: "tk_test" }, { fetch: async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ session: {}, revision: 3 }), { status: 200 });
  } });
  await client.updateSession({ purpose: "Workshop", expected_revision: 2 });
  assert.equal(seen.at(-1).url, "https://example.test/api/t/id/session");
  assert.equal(JSON.parse(seen.at(-1).options.body).expected_revision, 2);
  await client.updateDecision("id/with space", { expected_version: 4, status: "working" });
  assert.match(seen.at(-1).url, /decisions\/id%2Fwith%20space$/);
  await client.exportBundle({ includeData: true });
  assert.match(seen.at(-1).url, /bundle\?include_data=true$/);
  const count = seen.length;
  assert.throws(() => client.updateDecision("decision", { status: "completed" }), ContractError);
  assert.throws(() => client.updateDevice("device", { role: "owner" }), ContractError);
  assert.equal(seen.length, count);
});
