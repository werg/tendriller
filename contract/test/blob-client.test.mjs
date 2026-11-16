import test from "node:test";
import assert from "node:assert/strict";
import { createClient, ApiError } from "../client.mjs";
import { createUploadClient } from "../blobs-client.mjs";
import { createHash } from "node:crypto";
const blobId = "b_" + "a".repeat(20);
const uploadId = "u_" + "a".repeat(20);
const bytes = Uint8Array.of(0, 255, 127, 1, 254, 0);
const sha256 = createHash("sha256").update(bytes).digest("hex");
function setup({ failComplete = false, corrupt = false } = {}) {
  const calls = [];
  let completed = 0;
  const mock = async (url, init) => {
    const path = new URL(url).pathname.replace("/api/t/t1", "");
    calls.push({ path, ...init });
    assert.equal(init.headers.Authorization, "Bearer tk_secret");
    let value, status = 200;
    if (path === "/uploads" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.sha256, sha256);
      assert.equal(body.size, bytes.length);
      value = { id: uploadId, blob_id: blobId, sha256, size: bytes.length, phase: "ready",
        upload_required: true, expires_at: 1700000000000 };
    } else if (path === `/uploads/${uploadId}/content`) {
      assert.equal(init.method, "PUT");
      assert.deepEqual(new Uint8Array(init.body), bytes);
      assert.equal(init.headers["Content-Type"], "application/octet-stream");
      assert.equal(init.headers["Content-Encoding"], undefined);
      return new Response(null, { status: 204 });
    } else if (path === `/uploads/${uploadId}/complete`) {
      completed++;
      if (failComplete) return Response.json({error:{code:"blob_unavailable",message:"Try again"}}, {status:503});
      value = { status: "completed", blob: { id: blobId, sha256, size: bytes.length, type:"application/octet-stream" } };
    } else if (path === `/blobs/${blobId}`) {
      assert.equal(init.method, "GET");
      return new Response(corrupt ? Uint8Array.of(1) : bytes, {status:200});
    } else if (path === "/file-refs") {
      assert.equal(init.method, "PUT");
      const body = JSON.parse(init.body);
      value = { file: { path:body.path, blob_id:body.blob_id, revision:1 }, cursor:1 };
    } else if (path === "/publications") {
      assert.equal(init.method, "POST");
      value = { version: 1, head_revision: 1 };
    } else throw new Error(`unexpected ${path}`);
    return Response.json(value, {status});
  };
  return { calls, client: createClient({api:"https://example.test/api/t/t1",token:"tk_secret"},{fetch:mock}), get completed(){return completed;} };
}
test("agent upload sends raw exact bytes, verifies hash and preserves caller CID", async () => {
  const {client,calls} = setup();
  const result = await client.blobs.upload(bytes,{cid:"stable-work",name:"data.bin"});
  assert.equal(result.blob.sha256,sha256);
  assert.equal(result.blob.size,bytes.length);
  assert.equal(JSON.parse(calls[0].body).cid,"stable-work");
  assert.deepEqual(calls.map(c=>c.path), ["/uploads",`/uploads/${uploadId}/content`,`/uploads/${uploadId}/complete`]);
});
test("non-JSON raw download remains a Response and supports range/cancel", async () => {
  const {client,calls} = setup();
  const controller = new AbortController();
  const response = await client.blobs.download(blobId,{signal:controller.signal,range:"bytes=0-3"});
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  assert.equal(calls[0].headers.Range,"bytes=0-3");
  assert.equal(calls[0].signal,controller.signal);
});
test("server failure remains retryable ApiError; accepted upload is not guessed", async () => {
  const {client} = setup({failComplete:true});
  await assert.rejects(client.blobs.upload(bytes,{cid:"same-cid"}),
    err => err instanceof ApiError && err.status===503 && err.code === "blob_unavailable");
});
test("CAS commands carry exact captured revision; missing guards rejected before network", async () => {
  const {client,calls}=setup();
  assert.throws(() => client.files.put({path:"x",expected_revision:0,blob_id:blobId}), /\$\.cid/);
  assert.equal(calls.length,0);
  const result=await client.files.put({cid:"write-once",expected_generations:{},path:"x",expected_revision:0,blob_id:blobId});
  assert.equal(result.file.revision,1);
  assert.equal(JSON.parse(calls.at(-1).body).expected_revision,0);
});
test("publication requires complete sorted asset graph and guards", async () => {
  const {client,calls}=setup();
  const req={cid:"publish",expected_generations:{},expected_head_revision:0,entry:"index.html",files:[
    {path:"index.html",blob_id:blobId,type:"text/html"},{path:"style.css",blob_id:blobId,type:"text/css"}]};
  assert.deepEqual(await client.publications.publish(req),{version:1,head_revision:1});
  const prior=calls.length;
  assert.throws(() => client.publications.publish({...req,files:[...req.files].reverse()}), /sorted/);
  assert.equal(calls.length,prior);
});

test("received and completed sessions resume the original command without resending bytes", async () => {
  for (const phase of ["received", "completed"]) {
    const commands = [];
    const transfer = createUploadClient(async (path, options) => {
      if (path === "/uploads") {
        commands.push(options.body);
        return { id: uploadId, blob_id: blobId, sha256, size: bytes.length, phase, upload_required: true };
      }
      assert.equal(path, `/uploads/${uploadId}/complete`);
      return { status: "completed", blob: { id: blobId, sha256, size: bytes.length, type: "application/octet-stream" } };
    }, async () => assert.fail("A received session must not send its bytes again"));
    await transfer.upload(bytes, { cid: "original-upload" });
    assert.equal(commands[0].cid, "original-upload");
  }
});

test("transfer refuses mismatched session and completion identities", async () => {
  for (const corrupt of ["session_hash", "session_size", "blob_id", "blob_hash", "blob_size"]) {
    let sent = false;
    const transfer = createUploadClient(async path => {
      if (path === "/uploads") return { id: uploadId, blob_id: blobId,
        sha256: corrupt === "session_hash" ? "0".repeat(64) : sha256,
        size: bytes.length + (corrupt === "session_size" ? 1 : 0), phase: "ready", upload_required: true };
      return { status: "completed", blob: {
        id: corrupt === "blob_id" ? "b_" + "b".repeat(20) : blobId,
        sha256: corrupt === "blob_hash" ? "0".repeat(64) : sha256,
        size: bytes.length + (corrupt === "blob_size" ? 1 : 0), type: "application/octet-stream",
      } };
    }, async () => { sent = true; return new Response(null, { status: 204 }); });
    await assert.rejects(transfer.upload(bytes, { cid: "original-upload" }), error => error.code === "invalid_response");
    assert.equal(sent, !corrupt.startsWith("session_"));
  }
});

test("closed sessions require explicit new work and cannot silently allocate another upload", async () => {
  for (const phase of ["aborted", "expired"]) {
    let starts = 0;
    const transfer = createUploadClient(async path => {
      assert.equal(path, "/uploads"); starts++;
      return { id: uploadId, blob_id: blobId, sha256, size: bytes.length, phase, upload_required: true };
    }, async () => assert.fail("Closed session must not receive bytes"));
    await assert.rejects(transfer.upload(bytes, { cid: "closed-upload" }), error => error.code === "upload_closed");
    assert.equal(starts, 1);
  }
});

test("oversized streamed input is cancelled before any network operation", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  const transfer = createUploadClient(async () => assert.fail("Oversized bytes must not reserve a session"), async () => assert.fail("Oversized bytes must not upload"));
  await assert.rejects(transfer.upload(stream), RangeError);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
