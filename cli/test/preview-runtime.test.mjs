import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { attachRuntime } from "../lib/preview-runtime.mjs";

test("preview state uses the built server implementation, including null, deletes and rejected reserved keys", async () => {
  const adapter = await attachRuntime(new EventEmitter(), { root: fileURLToPath(new URL("../../", import.meta.url)), state: { reading: 2 } });
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
  const adapter = await attachRuntime(new EventEmitter(), { root: fileURLToPath(new URL("../../", import.meta.url)) });
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
