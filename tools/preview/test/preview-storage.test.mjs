import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { assertValid } from "@tendriller/core/contract";
import { startServer } from "../lib/preview.mjs";

const sha = data => createHash("sha256").update(data).digest("hex");
const payload = Buffer.from([0, 255, 3, 128, 10, 0, 42]);

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "preview-storage-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Storage fixture</title>");
  const server = await startServer(root, {}, options);
  t.after(async () => { await server.stopPreview(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async id => {
    const ws = new WebSocket(origin.replace("http", "ws") + "/_tendril/ws");
    await once(ws, "open");
    const welcome = once(ws, "message");
    ws.send(JSON.stringify({ t: "hello", device_id: id, device_secret: id + "-secret" }));
    await welcome;
    return { "X-Tendril-Device": id, "X-Tendril-Device-Secret": id + "-secret" };
  };
  const headers = await register("device-a");
  const call = (path, method = "GET", body, extra = {}) => fetch(origin + "/_tendril" + path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  });
  const start = (cid, data = payload) => call("/uploads", "POST", { cid, sha256: sha(data), size: data.length, type: "application/octet-stream" });
  const upload = async cid => {
    const session = await (await start(cid)).json();
    if (session.upload_required) assert.equal((await call(`/uploads/${session.id}/content`, "PUT", payload, { "Content-Type": "application/octet-stream" })).status, 204);
    const response = await call(`/uploads/${session.id}/complete`, "POST", {});
    assert.equal(response.status, 200);
    return { session, receipt: assertValid("uploadCompletion", await response.json()) };
  };
  return { server, origin, call, start, upload, register };
}

test("preview binary transfers attest exact bytes and replay the same completed upload", async t => {
  const { call, start, server } = await fixture(t);
  const session = assertValid("uploadSession", await (await start("one-upload")).json());
  assert.equal(session.upload_required, true);
  const changed = await start("one-upload", Buffer.from("different"));
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, "command_conflict");
  assert.equal((await call(`/uploads/${session.id}/content`, "PUT", Buffer.from("wrong"), { "Content-Type": "application/octet-stream" })).status, 422);
  assert.equal(server.preview.blobs.size, 0);
  assert.equal((await call(`/uploads/${session.id}/content`, "PUT", payload, { "Content-Type": "application/octet-stream" })).status, 204);
  const received = await (await start("one-upload")).json();
  assert.equal(received.id, session.id);
  assert.equal(received.phase, "received");
  assert.equal(received.upload_required, false, "a lost completion reply must not resend content");
  const receipt = assertValid("uploadCompletion", await (await call(`/uploads/${session.id}/complete`, "POST", {})).json());
  assert.equal(receipt.blob.id, session.blob_id);
  assert.equal(receipt.blob.sha256, sha(payload));
  assert.equal(receipt.blob.size, payload.length);
  assert.deepEqual(await (await call(`/uploads/${session.id}/complete`, "POST", {})).json(), receipt);
  assert.deepEqual(await (await call(`/blobs/${receipt.blob.id}/info`)).json(), receipt.blob);
  assert.deepEqual(Buffer.from(await (await call(`/blobs/${receipt.blob.id}`)).arrayBuffer()), payload);
  const part = await call(`/blobs/${receipt.blob.id}`, "GET", undefined, { Range: "bytes=1-3" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 1-3/7");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), payload.subarray(1, 4));
  assert.equal(server.preview.blobs.size, 1);
});

test("preview deduplication rejects a false size and isolates device upload identities", async t => {
  const { call, start, upload, register, server } = await fixture(t);
  const original = await upload("original");
  const bad = await call("/uploads", "POST", { cid: "wrong-size", sha256: sha(payload), size: 1, type: "application/octet-stream" });
  assert.equal(bad.status, 422);
  const reused = await (await start("same-bytes")).json();
  assert.equal(reused.upload_required, false);
  assert.notEqual(reused.blob_id, original.receipt.blob.id);
  assert.equal((await call(`/uploads/${reused.id}/complete`, "POST", {})).status, 200);
  const firstPage = await (await call("/blobs?limit=1")).json();
  assert.equal(firstPage.blobs.length, 1);
  assert.equal(firstPage.cursor, firstPage.blobs[0].id);
  const lastPage = await (await call(`/blobs?limit=1&after=${firstPage.cursor}`)).json();
  assert.equal(lastPage.blobs.length, 1);
  assert.notEqual(lastPage.blobs[0].id, firstPage.blobs[0].id);
  assert.equal(lastPage.cursor, null);
  const other = await register("device-b");
  assert.equal((await call(`/uploads/${original.session.id}`, "GET", undefined, other)).status, 404);
  assert.equal((await call("/uploads", "POST", {}, { "X-Tendril-Device-Secret": "wrong" })).status, 401);
  server.preview.setRole("display");
  assert.equal((await start("display-upload")).status, 403);
});

test("preview pin commands preserve original guards and accepted receipts", async t => {
  const scope = { id: "photos", generation: "first", paths: [], operations: ["blob.pin"] };
  const { call, upload, server } = await fixture(t, { scopes: [scope] });
  const { receipt } = await upload("pin-photo");
  const path = `/blobs/${receipt.blob.id}/pin`;
  const command = { cid: "pin-once", expected_generations: { photos: "first" }, keep: true };
  const pinned = await call(path, "PUT", command);
  assert.equal(pinned.status, 200);
  const result = assertValid("blobMetadata", await pinned.json());
  assert.equal(result.retention.expires_at, null);
  server.preview.setScopes([{ ...scope, generation: "second" }]);
  assert.deepEqual(await (await call(path, "PUT", command)).json(), result);
  assert.equal((await call(path, "PUT", { ...command, keep: false })).status, 409);
  assert.equal((await call(path, "PUT", { ...command, cid: "stale-pin" })).status, 409);
  server.preview.setRole("guest");
  assert.equal((await call(path, "PUT", command)).status, 403);
});

test("preview shared-file reads require an explicit fixture and never invent a service", async t => {
  const { call, server } = await fixture(t);
  assert.equal((await call("/file-refs/snapshot")).status, 501);
  const snapshot = { files: [{ path: "report/data.bin", revision: 2, blob_id: null }], cursor: 4 };
  server.setHttpFixtures([{ method: "GET", path: "/_tendril/file-refs/snapshot", json: snapshot }]);
  assert.deepEqual(await (await call("/file-refs/snapshot")).json(), snapshot);
  const head = snapshot.files[0];
  server.setHttpFixtures([{ method: "GET", path: "/_tendril/file-refs", query: { path: head.path }, json: head }]);
  assert.deepEqual(await (await call("/file-refs?path=" + encodeURIComponent(head.path))).json(), head);
  assert.equal((await call("/file-refs?path=missing.bin")).status, 501);
  assert.equal((await call("/publications", "POST", {})).status, 501);
});
