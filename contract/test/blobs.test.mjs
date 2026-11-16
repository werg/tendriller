import test from "node:test";
import assert from "node:assert/strict";
import { validate, assertValid } from "../index.mjs";
import { assertFilePath, assertAttachments, assertPublicationEntries } from "../blobs.mjs";
const sha256 = "ab".repeat(32);
const blob_id = "b_" + "a".repeat(20);
const guards = { cid: "request-123", expected_generations: {} };
test("canonical file names reject traversal, aliases, reserved paths and control chars", () => {
  for (const path of ["inputs/über.csv", "a/b", "測定/0.csv"]) assert.equal(assertFilePath(path), path);
  for (const path of ["", "/absolute", "../a", "a/../b", "a/./b", "a//b", "a/", "./a",
    "_tendril/settings", "_publications/2/a", "a\\b", "x\u0000y", "a\u007fy",
    "u\u0308ber.csv"]) {
    assert.throws(() => assertFilePath(path), { name: "TypeError" }, path);
    assert.notEqual(validate("filePath", path).length, 0, `schema accepted unsafe path ${JSON.stringify(path)}`);
  }
});
test("upload fingerprint fields are mandatory; hashes, IDs and sizes are bounded", () => {
  const valid = { cid: "b-1", sha256, size: 0, type: "application/octet-stream", name: "zero.dat" };
  assert.deepEqual(validate("uploadStart", valid), []);
  for (const patch of [{ sha256: sha256.toUpperCase() }, { sha256: "a" }, { size: -1 },
    { size: 25 * 1024 * 1024 + 1 }, { cid: "../" }, { type: "" }, { type: "text/🌝" }, { type: "text/café" }, { type: "text/plain\r\nX-Injected: yes" }, { extra: 1 }])
    assert.notEqual(validate("uploadStart", { ...valid, ...patch }).length, 0, JSON.stringify(patch));
  assert.notEqual(validate("uploadStart", { cid: "b-1", sha256, size: 0 }).length, 0);
  assert.deepEqual(validate("uploadCompletion", { status: "completed",
    blob: { id: blob_id, sha256, size: 0, type: "application/octet-stream", url: `_tendril/blobs/${blob_id}`, created_at: 0, retention: { reasons: ["unreferenced_upload"], expires_at: 1000 } } }), []);
});
test("file commands require original CAS and generation conditions", () => {
  const valid = { ...guards, path: "inputs/über.csv", expected_revision: 0, blob_id };
  assertValid("fileWrite", valid);
  for (const change of [
    { expected_revision: undefined }, { expected_revision: -1 },
    { expected_generations: undefined }, { blob_id: "b_bad" },
    { path: "a/../b" }, { cid: undefined },
  ]) {
    const body = { ...valid, ...change };
    if (change.expected_revision === undefined) delete body.expected_revision;
    if (change.expected_generations === undefined) delete body.expected_generations;
    if (change.cid === undefined) delete body.cid;
    assert.notEqual(validate("fileWrite", body).length, 0);
  }
  assert.deepEqual(validate("fileDelete", { ...guards, path: "x", expected_revision: 7 }), []);
  assert.notEqual(validate("fileDelete", { ...guards, path: "x" }).length, 0);
  assert.ok(validate("fileWrite", { ...valid, type: "text/🌝" }).some(issue => issue.path === "$.type"));
});
test("attachment roots reject duplicates and invalid handles", () => {
  const second = "b_" + "b".repeat(20);
  assert.equal(assertAttachments([{ blob_id }, { blob_id: second }]).length, 2);
  assert.throws(() => assertAttachments([{ blob_id }, { blob_id }]), /duplicate/);
  assert.throws(() => assertAttachments(Array.from({ length: 17 }, (_, i) => ({ blob_id: `b_${String(i).padStart(20, "a")}` }))), /At most/);
  assert.throws(() => assertAttachments([{ blob_id: "not-a-blob" }]), /Invalid/);
});
test("page manifests are complete, ordered and contain only exact blobs", () => {
  const files = [{ path: "index.html", blob_id, type: "text/html" },
    { path: "styles/app.css", blob_id, type: "text/css" }];
  assertValid("publicationWrite", { ...guards, expected_head_revision: 0, entry: "index.html", files });
  assert.equal(assertPublicationEntries(files, "index.html"), files);
  assert.throws(() => assertPublicationEntries([...files].reverse(), "index.html"), /sorted/);
  assert.throws(() => assertPublicationEntries([...files, files[1]], "index.html"), /unique/);
  assert.throws(() => assertPublicationEntries(files, "missing.html"), /missing/);
  assert.notEqual(validate("publicationWrite", { ...guards, entry: "index.html", files }).length, 0);
  assert.ok(validate("publicationWrite", { ...guards, expected_head_revision: 0, entry: "index.html",
    files: [{ ...files[0], type: "text/🌝" }] }).some(issue => issue.path === "$.files[0].type"));
});

test("scope operation contract accepts publication and shared-file generation guards", () => {
  for (const operation of ["file.write", "publication.publish", "bundle.publish", "blob.pin", "event", "capture"])
    assert.deepEqual(validate("scopeOperation", operation), [], operation);
  for (const operation of ["file.read", "publication.write", "file.write.extra", "_tendril"])
    assert.ok(validate("scopeOperation", operation).length > 0, operation);
});

test("paths and transfer names preserve valid Unicode and reject lone surrogates", () => {
  const valid = "観測/🌒.txt";
  assert.equal(assertFilePath(valid), valid);
  assert.deepEqual(validate("filePath", valid), []);
  for (const name of ["high\ud800.txt", "low\udfff.txt", "pair\ud800x\udc00.txt"]) {
    assert.throws(() => assertFilePath(name), TypeError);
    assert.ok(validate("filePath", name).length);
    assert.ok(validate("uploadStart", { cid: guards.cid, sha256, size: 0, type: "text/plain", name }).length);
    assert.ok(validate("fileWrite", { ...guards, path: "valid.txt", expected_revision: 0, blob_id, name }).length);
    assert.ok(validate("captureOptions", { name }).length);
    assert.ok(validate("blobMetadata", { id: blob_id, sha256, size: 0, type: "text/plain", name,
      url: `_tendril/blobs/${blob_id}`, created_at: 0, retention: { reasons: ["unreferenced_upload"], expires_at: 1000 } }).some(issue => issue.path === "$.name"));
    assert.ok(validate("blobAttachment", { blob_id, name }).length);
    assert.throws(() => assertAttachments([{ blob_id, name }]), TypeError);
    assert.ok(validate("bundle", { format: "tendriller-bundle", version: 3, name: "Copy", entry: "index.html",
      files: [{ path: "index.html", type: "text/html", base64: "AA==" }], media: [{ id: blob_id, type: "text/plain", name, base64: "AA==" }] }).length);
  }
  assert.deepEqual(validate("uploadStart", { cid: guards.cid, sha256, size: 0, type: "text/plain", name: "🌒.txt" }), []);
  assert.equal(assertAttachments([{ blob_id, name: "🌒.txt" }])[0].name, "🌒.txt");
  const metadata = { id: blob_id, sha256, size: 0, type: "text/plain; charset=utf-8", url: `_tendril/blobs/${blob_id}`,
    created_at: 0, retention: { reasons: ["unreferenced_upload"], expires_at: 1000 } };
  assert.deepEqual(validate("blobMetadata", metadata), []);
  assert.ok(validate("blobMetadata", { ...metadata, type: "text/🌝" }).some(issue => issue.path === "$.type"));
  const bundle = { format: "tendriller-bundle", version: 3, name: "Copy", entry: "index.html",
    files: [{ path: "index.html", type: "text/html", base64: "AA==" }],
    media: [{ id: blob_id, type: "text/plain", name: "🌒.txt", base64: "AA==" }],
    shared_files: [{ path: "🌒.txt", blob_id, type: "text/plain" }] };
  assert.deepEqual(validate("bundle", bundle), []);
  for (const field of ["files", "media", "shared_files"]) {
    const invalid = { ...bundle, [field]: [{ ...bundle[field][0], type: "text/🌝" }] };
    assert.ok(validate("bundle", invalid).some(issue => issue.path === `$.${field}[0].type`));
  }
});
