import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import { attachRuntime } from "../lib/preview-runtime.mjs";

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

test("preview retries upload acknowledgements without duplicating media and speaks through real say messages", async () => {
  const adapter = await attachRuntime(new EventEmitter(), {});
  try {
    const first = adapter.storeBlob(Buffer.from("photo"), "image/png", "photo", "capture-1", false);
    const again = adapter.storeBlob(Buffer.from("photo"), "image/png", "photo", "capture-1", false);
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
  const upload = adapter.storeBlob(Buffer.from("photo"), "image/png", "photo", "upload-1");
  const command = { t: "capture_complete", cid: "completion-1", blob: upload.id,
    data: { type: "observation", blob: upload.id, note: "Keep this with the photo" }, expected_generations: { photos: "generation-1" } };

  assert.equal((await client.call({ ...command, expected_generations: {} })).error, "stale_generation");
  assert.equal((await client.call({ ...command, blob: "b_missing" })).error, "bad_capture");
  assert.equal((await client.call({ ...command, kind: "instruction", text: "Do something" })).error, "bad_capture");
  assert.equal(adapter.events.length, 0);
  const accepted = await client.call(command);
  assert.equal(accepted.error, undefined);
  assert.equal(adapter.events.length, 1);
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
