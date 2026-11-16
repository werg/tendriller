import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import { attachRuntime } from "../lib/preview-runtime.mjs";

function storeCapture(adapter, data, device = "capture-device", cid = "upload-1") {
  const session = adapter.storage.start({ cid, size: data.length, type: "image/png", name: "photo",
    sha256: createHash("sha256").update(data).digest("hex") }, device);
  if (session.upload_required) adapter.storage.put(session.id, device, data, "application/octet-stream");
  return adapter.storage.complete(session.id, device).blob;
}

test("preview state uses the public runtime support primitives, including null, deletes and rejected reserved keys", async () => {
  const adapter = await attachRuntime(new EventEmitter(), { state: { reading: 2 } });
  try {
    adapter.updateState([{ op: "set", path: ["reading"], value: null }]);
    assert.equal(adapter.state.reading, null);
    assert.equal(adapter.rev, 1);
    adapter.updateState([{ op: "delete", path: ["reading"] }]);
    assert.equal(Object.hasOwn(adapter.state, "reading"), false);
    assert.throws(() => adapter.updateState([{ op: "set", path: ["__proto__", "unsafe"], value: true }]));
    assert.equal(adapter.rev, 2);
    assert.throws(() => adapter.setRole("admin"));
    adapter.setRole("display");
    assert.equal(adapter.role, "display");
  } finally { await adapter.close(); }
});

test("preview conditional writes preserve read guards, atomic state and terminal conflict retries", { timeout: 5000 }, async t => {
  const server = createServer();
  const binding = { id: "source", generation: "v1", paths: [["source"]], operations: [] };
  const adapter = await attachRuntime(server, { scopes: [binding], state: { source: { version: 1 }, array: [1] } });
  t.after(async () => { await adapter.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/_tendril/ws`);
  await once(ws, "open");
  const welcome = once(ws, "message");
  ws.send(JSON.stringify({ t: "hello", device_id: "conditional-device", device_secret: "fixture" })); await welcome;
  const frames = [];
  ws.on("message", raw => frames.push(JSON.parse(String(raw))));
  const call = message => new Promise(resolve => {
    const received = raw => {
      const frame = JSON.parse(String(raw));
      if (["ack", "state_snapshot"].includes(frame.t) && frame.cid === message.cid) { ws.off("message", received); resolve(frame); }
    };
    ws.on("message", received); ws.send(JSON.stringify(message));
  });
  const initial = adapter.state;
  for (const [index, extra] of [{ expected_revison: 99 }, { condition: [{ path: ["owner"], exists: false }] }].entries()) {
    const cid = `unknown-guard-${index}`;
    const rejected = await call({ t: "state", cid, expected_generations: {}, ...extra,
      ops: [{ op: "set", path: ["owner"], value: "must not be admitted" }] });
    assert.equal(rejected.error, "bad_request"); assert.match(rejected.message, /Unknown field/);
    assert.deepEqual(adapter.state, initial); assert.equal(adapter.rev, 0);
    // A corrected no-op with the same CID proves validation did not consume a
    // receipt. Waiting for it also observes the preceding ordered state reset.
    assert.equal((await call({ t: "state", cid, expected_generations: {}, ops: [] })).rev, 0);
    assert.ok(frames.some(frame => frame.t === "state_reset" && frame.cid === cid && frame.rev === 0));
  }
  const replacement = { t: "state", cid: "replacement-requires-ops", expected_generations: {}, state: { overwritten: true } };
  const rejectedReplacement = await call(replacement);
  assert.equal(rejectedReplacement.error, "bad_request"); assert.match(rejectedReplacement.message, /require ops/);
  assert.deepEqual(adapter.state, initial); assert.equal(adapter.rev, 0);
  assert.equal((await call({ t: "state", cid: replacement.cid, expected_generations: {}, ops: [] })).rev, 0);
  const body = { t: "state", cid: "claim-a", expected_generations: {},
    conditions: [{ path: ["source", "version"], equals: 1 }, { path: ["owner"], exists: false }],
    ops: [{ op: "set", path: ["owner"], value: "a" }, { op: "set", path: ["status"], value: "claimed" }] };
  assert.equal((await call(body)).error, "stale_generation");
  body.expected_generations.source = "v1";
  assert.equal((await call(body)).rev, 1);
  const competitor = { ...body, cid: "claim-b" };
  const rejected = await call(competitor);
  assert.equal(rejected.error, "state_conflict");
  assert.equal(rejected.conflict.condition, 1);
  assert.equal(adapter.state.owner, "a");
  assert.equal(adapter.state.status, "claimed");
  adapter.updateState([{ op: "delete", path: ["owner"] }]);
  adapter.setScopes([{ ...binding, generation: "v2" }]);
  assert.deepEqual(await call(competitor), rejected);
  assert.equal(adapter.state.owner, undefined);
  assert.equal((await call({ ...competitor, conditions: [] })).error, "command_conflict");
  assert.ok(frames.some(frame => frame.t === "state_reset" && frame.rev === 2 && frame.state.owner === undefined));
  assert.throws(() => adapter.updateState([{ op: "set", path: ["status"], value: "wrong" }, { op: "set", path: ["array", "0"], value: 2 }]), { code: "state_conflict" });
  assert.equal(adapter.state.status, "claimed"); assert.equal(adapter.rev, 2);
  const snapshot = await call({ t: "state_snapshot", cid: "claim-a" });
  assert.deepEqual(snapshot.state, adapter.state);
  assert.equal(snapshot.rev, 2); assert.equal(snapshot.scopes[0].generation, "v2");
  adapter.updateState([{ op: "set", path: ["later"], value: true }]);
  assert.equal((await call({ t: "state_snapshot", cid: "claim-a" })).rev, 3, "a read correlation ID is not a cached mutation receipt");
});

test("preview retries upload acknowledgements without duplicating media and speaks through real say messages", async () => {
  const adapter = await attachRuntime(new EventEmitter(), {});
  try {
    const first = storeCapture(adapter, Buffer.from("photo"), "capture-device", "capture-1");
    const again = storeCapture(adapter, Buffer.from("photo"), "capture-device", "capture-1");
    assert.deepEqual(again, first);
    assert.equal(adapter.blobs.size, 1);
    assert.match(first.id, /^b_[a-z2-7]{20}$/);
    assert.ok(first.retention.expires_at > Date.now());
    const id = adapter.say({ text: "Readout received", in_reply_to: 1 });
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(adapter.activity[0].kind, "say");
    assert.throws(() => adapter.say({ text: "x", bad: true }));
  } finally { await adapter.close(); }
});

test("preview capture completion checks upload references and original scope guards, and replays accepted receipts once", { timeout: 5000 }, async t => {
  const server = createServer();
  const binding = { id: "photos", generation: "generation-1", paths: [], operations: ["capture"] };
  const adapter = await attachRuntime(server, { scopes: [binding] });
  t.after(async () => { await adapter.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/_tendril/ws`);
    await once(ws, "open");
    const welcome = once(ws, "message");
    ws.send(JSON.stringify({ t: "hello", device_id: "capture-device" }));
    await welcome;
    return { ws, call: message => new Promise(resolve => {
      const onMessage = raw => {
        const frame = JSON.parse(String(raw));
        if (frame.t === "ack" && frame.cid === message.cid) { ws.off("message", onMessage); resolve(frame); }
      };
      ws.on("message", onMessage); ws.send(JSON.stringify(message));
    }) };
  };
  let client = await connect();
  const upload = storeCapture(adapter, Buffer.from("photo"));
  const command = { t: "capture_complete", cid: "completion-1", blob: upload.id,
    data: { type: "observation", blob: upload.id, note: "Keep this with the photo" }, expected_generations: { photos: "generation-1" } };

  assert.equal((await client.call({ ...command, expected_generations: {} })).error, "stale_generation");
  assert.equal((await client.call({ ...command, blob: "b_missing" })).error, "bad_capture");
  assert.equal((await client.call({ ...command, kind: "instruction", text: "Do something" })).error, "bad_capture");
  assert.equal(adapter.events.length, 0);
  const accepted = await client.call(command);
  assert.equal(accepted.error, undefined);
  assert.equal(adapter.events.length, 1);
  assert.equal((await client.call({ ...command, data: { changed: true } })).error, "command_conflict");
  assert.deepEqual(adapter.events[0].data, command.data);
  assert.deepEqual(adapter.events[0].context, { generations: { photos: "generation-1" } });

  const closed = once(client.ws, "close"); client.ws.close(); await closed;
  adapter.setScopes([{ ...binding, generation: "generation-2" }]);
  client = await connect();
  assert.deepEqual(await client.call(command), accepted, "a lost acknowledgement must not duplicate an accepted capture after reconnect or rotation");
  assert.equal((await client.call({ ...command, cid: "completion-2" })).error, "stale_generation");
  assert.equal(adapter.events.length, 1);
  const next = { ...command, cid: "completion-2", expected_generations: { photos: "generation-2" } };
  assert.equal((await client.call(next)).error, undefined, "a rejected command must not commit a receipt");
  assert.equal(adapter.events.length, 2);
  adapter.setRole("display");
  assert.equal((await client.call({ ...next, cid: "completion-3" })).error, "forbidden");
  assert.equal(adapter.events.length, 2);
});
