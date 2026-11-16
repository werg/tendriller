import { expect, it } from "vitest";
import { api, apiJson, advance, create, inDO, publishFilesJson, req, uploadBlobJson, type Handle } from "./helpers";
import { fileKey } from "../src/files";

const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });
const sourceId = "b_" + "a".repeat(20);
const portable = () => ({
  format: "tendriller-bundle", version: 3, entry: "pages/review.html", name: "Reviewed copy",
  files: [{ path: "pages/review.html", type: "text/html", base64: btoa("<h1>Reviewed copy</h1>") }],
  media: [{ id: sourceId, type: "text/plain", name: "report.txt", base64: btoa("Reviewed findings") }],
  shared_files: [{ path: "reports/current.txt", blob_id: sourceId, name: "Current findings", type: "text/plain" }],
});
const putFile = (h: Handle, path: string, blob_id: string, expected_revision = 0) =>
  apiJson(h, "PUT", "file-refs", command({ path, blob_id, expected_revision }));

it("preserves an authored nested entry and does not accumulate publication media across copies", async () => {
  let h = await create();
  await publishFilesJson(h, { "pages/review.html": "<h1>Reviewed copy</h1>", "pages/app.js": "export const ready = true" }, { entry: "pages/review.html" });
  for (let copy = 0; copy < 3; copy++) {
    const bundle = await apiJson(h, "GET", "bundle?include_data=true");
    expect(bundle).toMatchObject({ version: 3, entry: "pages/review.html", media: [], shared_files: [] });
    expect(bundle.files).toHaveLength(2);
    const next = await create();
    await apiJson(next, "PUT", "bundle", bundle, 202);
    await apiJson(next, "POST", "bundle/publish", command({ expected_head_revision: 0 }));
    expect((await apiJson(next, "GET", "publications/1")).entry).toBe("pages/review.html");
    expect(await (await req(next.page_url)).text()).toContain("Reviewed copy");
    expect(await inDO(next.id, t => t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")?.n)).toBe(2);
    h = next;
  }
});

it("includes publication handles explicitly referenced by state or active shared files", async () => {
  const h = await create();
  await publishFilesJson(h, { "index.html": "<h1>Home</h1>", "app.js": "source", "style.css": "body{}" });
  const files = (await apiJson(h, "GET", "publications/1")).files;
  const html = files.find((file: any) => file.path === "index.html").blob_id;
  const script = files.find((file: any) => file.path === "app.js").blob_id;
  const media = await uploadBlobJson(h, "Observation", { type: "text/plain" });
  await putFile(h, "reviewed/page.html", html);
  await apiJson(h, "PUT", "state", command({ state: { reviewed: { [script]: "Exact source" } } }));
  const bundle = await apiJson(h, "GET", "bundle?include_data=true");
  expect(bundle.media.map((item: any) => item.id).sort()).toEqual([html, script, media.id].sort());
  expect(bundle.shared_files).toEqual([{ path: "reviewed/page.html", blob_id: html }]);
  const copy = await create();
  await apiJson(copy, "PUT", "bundle", bundle, 202);
  await apiJson(copy, "POST", "bundle/publish", command({ expected_head_revision: 0 }));
  const reviewed = (await apiJson(copy, "GET", "state")).state.reviewed;
  expect(Object.keys(reviewed)).toHaveLength(1); expect(Object.keys(reviewed)[0]).not.toBe(script);
  expect(await (await api(copy, "GET", `blobs/${Object.keys(reviewed)[0]}`)).text()).toBe("source");
  const codeOnly = await apiJson(h, "GET", "bundle");
  expect(codeOnly.media).toEqual([]); expect(codeOnly.shared_files).toBeUndefined(); expect(codeOnly.state).toBeUndefined();
});

it("roundtrips active shared-file heads and rewrites their identities without importing history", async () => {
  const h = await create();
  await publishFilesJson(h, { "index.html": "<h1>Source</h1>" });
  const old = await uploadBlobJson(h, "Old report", { type: "text/plain" });
  const current = await uploadBlobJson(h, "Reviewed report", { type: "text/plain" });
  await putFile(h, "reports/current.txt", old.id);
  await apiJson(h, "PUT", "file-refs", command({ path: "reports/current.txt", expected_revision: 1, blob_id: current.id, name: "Findings", type: "text/plain" }));
  await putFile(h, "removed.txt", old.id);
  await apiJson(h, "DELETE", "file-refs", command({ path: "removed.txt", expected_revision: 1 }));
  await apiJson(h, "PUT", "state", command({ state: { current: current.id } }));
  const bundle = await apiJson(h, "GET", "bundle?include_data=true"), copy = await create();
  expect(bundle.shared_files).toHaveLength(1);
  await apiJson(copy, "PUT", "bundle", bundle, 202);
  expect((await apiJson(copy, "GET", "file-refs/snapshot")).files).toEqual([]);
  const accept = command({ expected_head_revision: 0 });
  const receipt = await apiJson(copy, "POST", "bundle/publish", accept);
  expect(await apiJson(copy, "POST", "bundle/publish", accept)).toEqual(receipt);
  const head = await apiJson(copy, "GET", "file-refs?path=reports%2Fcurrent.txt");
  expect(head).toMatchObject({ path: "reports/current.txt", revision: 1, name: "Findings", type: "text/plain" });
  expect(head.blob_id).not.toBe(current.id);
  expect((await apiJson(copy, "GET", "state")).state.current).toBe(head.blob_id);
  expect(await (await api(copy, "GET", `blobs/${head.blob_id}`)).text()).toBe("Reviewed report");
  expect((await apiJson(copy, "GET", "file-refs/history?path=reports%2Fcurrent.txt")).versions).toHaveLength(1);
  expect((await apiJson(copy, "GET", "file-refs/changes")).changes).toHaveLength(1);
  expect((await api(copy, "GET", "file-refs?path=removed.txt")).status).toBe(404);
});

it.each([
  ["obsolete format", (bundle: any) => { bundle.version = 1; }],
  ["missing entry", (bundle: any) => { delete bundle.entry; }],
  ["missing authored entry", (bundle: any) => { bundle.entry = "absent.html"; }],
  ["non-HTML entry", (bundle: any) => { bundle.files[0].type = "text/plain"; }],
  ["unavailable shared media", (bundle: any) => { bundle.shared_files[0].blob_id = "b_" + "b".repeat(20); }],
  ["duplicate shared path", (bundle: any) => { bundle.shared_files.push({ ...bundle.shared_files[0] }); }],
])("rejects %s before any import side effects", async (_name, change) => {
  const h = await create(), bundle = portable(); change(bundle);
  expect((await api(h, "PUT", "bundle", bundle)).status).toBe(400);
  expect(await inDO(h.id, t => ({ bytes: t.storageUsed(), staged: t.db.get("staged_bundle", null), blobs: t.db.all("SELECT id FROM blobs") })))
    .toEqual({ bytes: 0, staged: null, blobs: [] });
});

it("rolls back the entire import if a shared-file destination changes after staging", async () => {
  const h = await create(), before = await uploadBlobJson(h, "Before");
  await putFile(h, "reports/current.txt", before.id);
  await apiJson(h, "PUT", "state", command({ state: { note: "Keep current work" } }));
  const bundle = { ...portable(), state: { note: "Imported work" }, shared_files: [
    { path: "alpha.txt", blob_id: sourceId }, ...portable().shared_files,
  ] };
  await apiJson(h, "PUT", "bundle", bundle, 202);
  const newer = await uploadBlobJson(h, "Edited during review");
  await putFile(h, "reports/current.txt", newer.id, 1);
  const rejected = await api(h, "POST", "bundle/publish", command({ expected_head_revision: 0 }));
  expect(rejected.status).toBe(409); expect((await rejected.json<any>()).error.code).toBe("file_conflict");
  expect((await apiJson(h, "GET", "publications")).current).toBe(0);
  expect((await api(h, "GET", "file-refs?path=alpha.txt")).status).toBe(404);
  expect((await apiJson(h, "GET", "file-refs?path=reports%2Fcurrent.txt")).blob_id).toBe(newer.id);
  expect((await apiJson(h, "GET", "state")).state).toEqual({ note: "Keep current work" });
  expect((await apiJson(h, "GET", "session")).staged_remix).toBe(true);
});

it("requires current shared-file scope guards before changing any publication or file head", async () => {
  const h = await create(), scope = await apiJson(h, "PUT", "scopes/files", command({ paths: [["files"]], operations: [] }));
  await apiJson(h, "PUT", "bundle", portable(), 202);
  expect((await api(h, "POST", "bundle/publish", command({ expected_head_revision: 0 }))).status).toBe(428);
  const next = await apiJson(h, "POST", "scopes/files/rotate", command({ expected_generations: { files: scope.generation } }));
  expect((await api(h, "POST", "bundle/publish", command({ expected_head_revision: 0, expected_generations: { files: scope.generation } }))).status).toBe(409);
  expect((await apiJson(h, "GET", "publications")).current).toBe(0);
  expect((await apiJson(h, "GET", "file-refs/snapshot")).files).toEqual([]);
  await apiJson(h, "POST", "bundle/publish", command({ expected_head_revision: 0, expected_generations: { files: next.generation } }));
  expect((await apiJson(h, "GET", "file-refs/snapshot")).files).toHaveLength(1);
});

it("retains reviewed staged media across cleanup until imported heads commit", async () => {
  const h = await create();
  await apiJson(h, "PUT", "bundle", portable(), 202);
  const staged = await inDO(h.id, t => t.db.get<any>("staged_bundle", null));
  expect((await apiJson(h, "GET", `blobs/${staged.media[0]}/info`)).retention.reasons).toContain("staged_import");
  await advance(h.id, 31 * 86400_000); await inDO(h.id, t => t.cleanup());
  await apiJson(h, "POST", "bundle/publish", command({ expected_head_revision: 0 }));
  const head = await apiJson(h, "GET", "file-refs?path=reports%2Fcurrent.txt");
  expect(await (await api(h, "GET", `blobs/${head.blob_id}`)).text()).toBe("Reviewed findings");
});

it("refuses changed prepared bytes even when their length still matches", async () => {
  const h = await create();
  await apiJson(h, "PUT", "bundle", portable(), 202);
  await inDO(h.id, async t => {
    const staged = t.db.get<any>("staged_bundle", null), file = staged.files[0];
    await t.env.FILES.put(fileKey(t, file.hash), new Uint8Array(file.size).fill(120));
  });
  const rejected = await api(h, "POST", "bundle/publish", command({ expected_head_revision: 0 }));
  expect(rejected.status).toBe(409); expect((await rejected.json<any>()).error.code).toBe("incomplete_bundle");
  expect((await apiJson(h, "GET", "publications")).current).toBe(0);
  expect((await apiJson(h, "GET", "file-refs/snapshot")).files).toEqual([]);
});

it("bounds portable aliases by encoded transfer size even when physical bytes are deduplicated", async () => {
  const h = await create();
  const index = await uploadBlobJson(h, "<h1>Aliases</h1>", { type: "text/html" });
  const asset = await uploadBlobJson(h, new Uint8Array(1024 * 1024), { type: "application/octet-stream" });
  await apiJson(h, "POST", "publications", command({ expected_head_revision: 0, entry: "index.html", files: [
    ...Array.from({ length: 28 }, (_, i) => ({ path: `assets/${String(i).padStart(2, "0")}.bin`, blob_id: asset.id, type: asset.type })),
    { path: "index.html", blob_id: index.id, type: index.type },
  ] }));
  const response = await api(h, "GET", "bundle");
  expect(response.status).toBe(413); expect((await response.json<any>()).error.code).toBe("bundle_too_large");
  expect(await inDO(h.id, t => t.storageUsed())).toBe(index.size + asset.size);
});

it("rejects a reviewed import after rollback returns to the same publication version", async () => {
  const h = await create();
  await publishFilesJson(h, { "index.html": "<h1>First</h1>" });
  const staged = await apiJson(h, "PUT", "bundle", portable(), 202);
  expect(staged.expected_head_revision).toBe(1);
  await publishFilesJson(h, { "index.html": "<h1>Second</h1>" });
  await apiJson(h, "POST", "publications/rollback", command({ expected_head_revision: 2, version: 1 }));
  const head = await apiJson(h, "GET", "publications");
  expect(head).toMatchObject({ current: 1, head_revision: 3 });
  const rejected = await api(h, "POST", "bundle/publish", command({ expected_head_revision: staged.expected_head_revision }));
  expect(rejected.status).toBe(409); expect((await rejected.json<any>()).error.code).toBe("publication_conflict");
  expect((await apiJson(h, "GET", "publications")).current).toBe(1);
  expect((await apiJson(h, "GET", "file-refs/snapshot")).files).toEqual([]);
});

it.each([
  { name: "publication namespace", paths: [["publications"]], operations: [] },
  { name: "publication operation", paths: [], operations: ["publication.publish"] },
  { name: "bundle operation", paths: [], operations: ["bundle.publish"] },
  { name: "shared-file operation", paths: [], operations: ["file.write"] },
])("requires the $name scope for a complete import", async ({ paths, operations }) => {
  const h = await create();
  const scope = await apiJson(h, "PUT", "scopes/review", command({ paths, operations }));
  const staged = await apiJson(h, "PUT", "bundle", portable(), 202);
  const body = { expected_head_revision: staged.expected_head_revision };
  expect((await api(h, "POST", "bundle/publish", command(body))).status).toBe(428);
  expect((await apiJson(h, "GET", "publications")).current).toBe(0);
  expect((await apiJson(h, "GET", "file-refs/snapshot")).files).toEqual([]);
  const accepted = command({ ...body, expected_generations: { review: scope.generation } });
  const receipt = await apiJson(h, "POST", "bundle/publish", accepted);
  expect(receipt).toEqual({ version: 1, head_revision: 1, restored: true });
  await apiJson(h, "POST", "scopes/review/rotate", command({ expected_generations: { review: scope.generation } }));
  expect(await apiJson(h, "POST", "bundle/publish", accepted)).toEqual(receipt);
});

it("does not require a shared-file operation guard for a code-only import", async () => {
  const h = await create();
  await apiJson(h, "PUT", "scopes/files", command({ paths: [], operations: ["file.write"] }));
  const bundle = { ...portable(), media: [], shared_files: [] };
  const staged = await apiJson(h, "PUT", "bundle", bundle, 202);
  expect((await api(h, "POST", "bundle/publish", command({ expected_head_revision: staged.expected_head_revision }))).status).toBe(200);
});
