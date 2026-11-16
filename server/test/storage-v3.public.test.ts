import { expect, it } from "vitest";
import { api, apiJson, create } from "./helpers";
import { sha256Hex } from "../src/ids";

it("accepts exact immutable bytes once and applies shared-file CAS with durable replay", async () => {
  const page = await create();
  const bytes = new TextEncoder().encode("field note α");
  const sha256 = await sha256Hex(bytes);
  const intent = { cid: "upload-field-note", sha256, size: bytes.byteLength, type: "text/plain", name: "note.txt" };
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
  expect(await (await api(page, "GET", `blobs/${started.blob_id}`)).text()).toBe("field note α");
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
  expect((await api(page, "GET", "file-refs?path=notes%2Fnote.txt")).status).toBe(404);
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
  expect((await apiJson(page, "GET", "publications/1")).files).toEqual(publish.files);
  expect((await api(page, "POST", "publications", { ...publish, cid: "stale-publish" })).status).toBe(409);
  const second = await apiJson(page, "POST", "publications", { ...publish, cid: "publish-index-2", expected_head_revision: 1 });
  expect(second).toEqual({ version: 2, head_revision: 2 });
  const rollback = { cid: "restore-index", expected_generations: {}, expected_head_revision: 2, version: 1 };
  expect(await apiJson(page, "POST", "publications/rollback", rollback)).toEqual({ version: 1, head_revision: 3 });
  expect(await apiJson(page, "POST", "publications/rollback", rollback)).toEqual({ version: 1, head_revision: 3 });
});
