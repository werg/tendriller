import { expect, it } from "vitest";
import { api, apiJson, create, inDO, PageClient, req } from "./helpers";
import { sha256Hex } from "../src/ids";

it("accepts exact immutable bytes once and applies shared-file CAS with durable replay", async () => {
  const page = await create();
  const bytes = new TextEncoder().encode("field note α");
  const sha256 = await sha256Hex(bytes);
  const intent = { cid: "upload-field-note", sha256, size: bytes.byteLength, type: "text/plain", name: "note's α.txt" };
  const started = await apiJson(page, "POST", "uploads", intent, 201);
  expect(started).toMatchObject({ sha256, size: bytes.byteLength, phase: "reserved", upload_required: true });
  expect((await apiJson(page, "POST", "uploads", intent, 201)).id).toBe(started.id);
  expect((await api(page, "POST", "uploads", { ...intent, size: bytes.byteLength + 1 })).status).toBe(409);
  expect((await api(page, "PUT", `uploads/${started.id}/content`, new TextEncoder().encode("wrong"),
    { "Content-Type": "application/octet-stream" })).status).toBe(422);
  expect((await api(page, "PUT", `uploads/${started.id}/content`, bytes,
    { "Content-Type": "application/octet-stream" })).status).toBe(204);
  const receipt = await apiJson(page, "POST", `uploads/${started.id}/complete`, {});
  expect(receipt.blob).toMatchObject({ id: started.blob_id, sha256, size: bytes.byteLength });
  expect((await apiJson(page, "POST", `uploads/${started.id}/complete`, {})).blob.id).toBe(started.blob_id);
  const download = await api(page, "GET", `blobs/${started.blob_id}`);
  expect(download.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''note%27s%20%CE%B1.txt");
  expect(download.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await download.text()).toBe("field note α");
  const inline = await api(page, "HEAD", `blobs/${started.blob_id}?disposition=inline`);
  expect(inline.headers.get("Content-Disposition")).toMatch(/^inline;/);
  expect(inline.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  expect(inline.headers.get("Content-Length")).toBe(String(bytes.byteLength));
  expect(await inline.text()).toBe("");
  const partial = await api(page, "GET", `blobs/${started.blob_id}`, undefined, { Range: "bytes=0-4" });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("Content-Range")).toBe(`bytes 0-4/${bytes.byteLength}`);
  expect(await partial.text()).toBe("field");

  const write = { cid: "file-note-1", expected_generations: {}, path: "notes/note.txt",
    expected_revision: 0, blob_id: started.blob_id, type: "text/plain" };
  const first = await apiJson(page, "PUT", "file-refs", write);
  expect(first).toMatchObject({ file: { path: "notes/note.txt", revision: 1, blob_id: started.blob_id }, cursor: 1 });
  expect(await apiJson(page, "PUT", "file-refs", write)).toEqual(first);
  expect((await api(page, "PUT", "file-refs", { ...write, cid: "file-note-stale" })).status).toBe(409);
  expect((await apiJson(page, "GET", "file-refs/snapshot")).files).toHaveLength(1);
  expect((await apiJson(page, "GET", "file-refs/changes?after=0")).changes).toHaveLength(1);
  const deleted = await apiJson(page, "DELETE", "file-refs", { cid: "file-note-2", expected_generations: {},
    path: "notes/note.txt", expected_revision: 1 });
  expect(deleted.file.blob_id).toBeNull();
  expect(await apiJson(page, "GET", "file-refs?path=notes%2Fnote.txt")).toMatchObject({ revision: 2, blob_id: null });
});

it("publishes complete blob manifests with head CAS and replays the same command", async () => {
  const page = await create({ mode: "dashboard" });
  const bytes = new TextEncoder().encode("<!doctype html><h1>Field notes</h1>");
  const sha256 = await sha256Hex(bytes);
  const upload = await apiJson(page, "POST", "uploads", { cid: "upload-index", sha256,
    size: bytes.byteLength, type: "text/html", name: "index.html" }, 201);
  expect((await api(page, "PUT", `uploads/${upload.id}/content`, bytes,
    { "Content-Type": "application/octet-stream" })).status).toBe(204);
  await apiJson(page, "POST", `uploads/${upload.id}/complete`, {});
  const publish = { cid: "publish-index", expected_generations: {}, expected_head_revision: 0,
    entry: "index.html", files: [{ path: "index.html", blob_id: upload.blob_id, type: "text/html" }] };
  const first = await apiJson(page, "POST", "publications", publish);
  expect(first).toEqual({ version: 1, head_revision: 1 });
  expect(await apiJson(page, "POST", "publications", publish)).toEqual(first);
  expect((await apiJson(page, "GET", "publications")).versions).toHaveLength(1);
  expect((await apiJson(page, "GET", "publications/1")).files).toEqual(publish.files.map(file => ({ ...file, sha256, size: bytes.byteLength })));
  expect((await api(page, "POST", "publications", { ...publish, cid: "stale-publish" })).status).toBe(409);
  const second = await apiJson(page, "POST", "publications", { ...publish, cid: "publish-index-2", expected_head_revision: 1 });
  expect(second).toEqual({ version: 2, head_revision: 2 });
  const rollback = { cid: "restore-index", expected_generations: {}, expected_head_revision: 2, version: 1 };
  expect(await apiJson(page, "POST", "publications/rollback", rollback)).toEqual({ version: 1, head_revision: 3 });
  expect(await apiJson(page, "POST", "publications/rollback", rollback)).toEqual({ version: 1, head_revision: 3 });
});

it("serves a publication's declared HTML entry at the page root", async () => {
  const page = await create({ mode: "dashboard" });
  const bytes = new TextEncoder().encode("<!doctype html><h1>Alternate entry</h1>");
  const sha256 = await sha256Hex(bytes);
  const upload = await apiJson(page, "POST", "uploads", { cid: "alternate-upload", sha256,
    size: bytes.byteLength, type: "text/html" }, 201);
  await api(page, "PUT", `uploads/${upload.id}/content`, bytes, { "Content-Type": "application/octet-stream" });
  await apiJson(page, "POST", `uploads/${upload.id}/complete`, {});
  await apiJson(page, "POST", "publications", { cid: "alternate-publish", expected_generations: {},
    expected_head_revision: 0, entry: "start.html",
    files: [{ path: "start.html", blob_id: upload.blob_id, type: "text/html" }] });
  expect(await (await req(page.page_url)).text()).toContain("Alternate entry");
});

it("rejects false size attestations on both deduplicated reservation and completion", async () => {
  const page = await create();
  const bytes = new TextEncoder().encode("known immutable bytes");
  const blob = await inDO(page.id, t => t.storeBlob(bytes.buffer as ArrayBuffer, "text/plain", null, null, "agent"));
  const request = { cid: "dedupe-correct", sha256: blob.sha256, size: bytes.byteLength, type: "text/plain" };
  const wrong = await api(page, "POST", "uploads", { ...request, cid: "dedupe-wrong", size: bytes.byteLength + 1 });
  expect(wrong.status).toBe(422);
  const start = await apiJson(page, "POST", "uploads", request, 201);
  expect(start.upload_required).toBe(false);
  const completed = await apiJson(page, "POST", `uploads/${start.id}/complete`, {});
  expect(completed.blob).toMatchObject({ sha256: blob.sha256, size: bytes.byteLength });
  const guarded = await apiJson(page, "POST", "uploads", { ...request, cid: "dedupe-completion-guard" }, 201);
  await inDO(page.id, t => t.db.run("UPDATE upload_sessions SET size=size+1 WHERE id=?", guarded.id));
  expect((await api(page, "POST", `uploads/${guarded.id}/complete`, {})).status).toBe(422);
  expect(await inDO(page.id, t => t.db.one("SELECT 1 AS present FROM blobs WHERE id=?", guarded.blob_id))).toBeNull();
  expect((await apiJson(page, "GET", `blobs/${blob.id}/info`)).size).toBe(bytes.byteLength);
});

it("requires verified page upload identity and enforces file read/write roles", async () => {
  const page = await create();
  const bytes = new TextEncoder().encode("page data");
  const upload = { cid: "page-upload", sha256: await sha256Hex(bytes), size: bytes.length, type: "text/plain" };
  const startURL = page.page_url + "_tendril/uploads";
  expect((await req(startURL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(upload) })).status).toBe(401);
  const device = await PageClient.connect(page.page_url);
  const headers = { "Content-Type": "application/json", "X-Tendril-Device": device.deviceId, "X-Tendril-Device-Secret": device.secret };
  const startedResponse = await req(startURL, { method: "POST", headers, body: JSON.stringify(upload) });
  expect(startedResponse.status).toBe(201);
  const started = await startedResponse.json<any>();
  expect((await req(`${startURL}/${started.id}/content`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes })).status).toBe(204);
  const completed = await req(`${startURL}/${started.id}/complete`, { method: "POST", headers, body: "{}" });
  expect(completed.status).toBe(200);
  const blob = (await completed.json<any>()).blob;
  const write = { cid: "page-file", expected_generations: {}, expected_revision: 0, path: "shared.txt", blob_id: blob.id };
  expect((await req(page.page_url + "_tendril/file-refs", { method: "PUT", headers, body: JSON.stringify(write) })).status).toBe(200);
  const display = await inDO(page.id, async t => t.renderLink(await t.createLink("display", null, null)));
  expect((await req(display.url + "_tendril/file-refs/snapshot", { anonymous: true })).status).toBe(200);
  expect((await req(display.url + "_tendril/file-refs", { anonymous: true, method: "PUT", headers: { "Content-Type": "application/json", Origin: new URL(display.url).origin }, body: JSON.stringify(write) })).status).toBe(403);
  device.close();
});

it("enforces complete shared-file capacity without consuming a rejected command", async () => {
  const page = await create();
  const blob = await inDO(page.id, t => t.storeBlob(new Uint8Array([1]).buffer, "application/octet-stream", null, null, "agent"));
  await inDO(page.id, t => {
    for (let i = 0; i < 512; i++) t.db.run("INSERT INTO file_refs(path,revision,blob_id,updated_at,by_actor) VALUES(?,1,?,?,?)", `f${i}`, blob.id, t.now(), "fixture");
  });
  const input = { cid: "over-capacity", expected_generations: {}, path: "extra", expected_revision: 0, blob_id: blob.id };
  expect((await api(page, "PUT", "file-refs", input)).status).toBe(429);
  expect((await apiJson(page, "GET", "file-refs/snapshot")).files).toHaveLength(512);
  expect(await inDO(page.id, t => t.db.one("SELECT 1 AS present FROM commands WHERE cid=?", input.cid))).toBeNull();
  await apiJson(page, "DELETE", "file-refs", { cid: "free-one", expected_generations: {}, path: "f0", expected_revision: 1 });
  expect((await apiJson(page, "PUT", "file-refs", input)).file.revision).toBe(1);
});

it("bounds history while preserving tombstone revisions and reporting cursor gaps", async () => {
  const page = await create();
  const blob = await inDO(page.id, t => t.storeBlob(new Uint8Array([1]).buffer, "application/octet-stream", null, null, "agent"));
  for (let i = 0; i < 14; i++) await apiJson(page, "PUT", "file-refs", {
    cid: `history-${i}`, expected_generations: {}, path: "log", expected_revision: i, blob_id: blob.id,
  });
  expect((await apiJson(page, "GET", "file-refs/history?path=log")).versions).toHaveLength(11);
  expect((await api(page, "GET", "file-refs/changes?after=0")).status).toBe(410);
  const snapshot = await apiJson(page, "GET", "file-refs/snapshot");
  expect((await apiJson(page, "GET", `file-refs/changes?after=${snapshot.cursor}`)).changes).toEqual([]);
  await apiJson(page, "DELETE", "file-refs", { cid: "history-delete", expected_generations: {}, path: "log", expected_revision: 14 });
  expect((await apiJson(page, "GET", "file-refs?path=log")).revision).toBe(15);
  expect((await api(page, "PUT", "file-refs", { cid: "unsafe-recreate", expected_generations: {}, path: "log", expected_revision: 0, blob_id: blob.id })).status).toBe(409);
});

it("advances publication CAS when service recovery selects a different version", async () => {
  const page = await create({ mode: "dashboard" });
  const blob = await inDO(page.id, t => t.storeBlob(new TextEncoder().encode("<h1>Version</h1>").buffer as ArrayBuffer, "text/html", null, null, "agent"));
  const manifest = { expected_generations: {}, entry: "index.html", files: [{ path: "index.html", blob_id: blob.id, type: "text/html" }] };
  await apiJson(page, "POST", "publications", { ...manifest, cid: "head-1", expected_head_revision: 0 });
  await apiJson(page, "POST", "publications", { ...manifest, cid: "head-2", expected_head_revision: 1 });
  const recovery = await req(page.page_url + "_tendril/manage", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "action=select-version&head_revision=2&version=1" });
  expect(recovery.status).toBe(200);
  expect((await apiJson(page, "GET", "publications")).head_revision).toBe(3);
  expect((await api(page, "POST", "publications", { ...manifest, cid: "stale-head-2", expected_head_revision: 2 })).status).toBe(409);
});
