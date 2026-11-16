import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../lib/preview.mjs";

test("HTTP fixtures compare JSON values without depending on object key order", async t => {
  const dir = mkdtempSync(join(tmpdir(), "tendril-preview-http-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>HTTP fixture</title>");
  const server = await startServer(dir, {}, { http: [{ method: "POST", path: "/_tendril/workflows/example/respond",
    expect_body: { data: { expected_version: 1, response: { choice: "revise", note: "Keep the introduction" }, id: "proposal-1" } }, json: { accepted: true } }] });
  t.after(async () => { await server.stopPreview(); rmSync(dir, { recursive: true, force: true }); });
  const request = data => fetch(`http://127.0.0.1:${server.address().port}/_tendril/workflows/example/respond`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cid: "command-1", expected_generations: {}, data }),
  });
  const data = { id: "proposal-1", response: { note: "Keep the introduction", choice: "revise" }, expected_version: 1 };
  const accepted = await request(data);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: true });
  const rejected = await request({ ...data, expected_version: 2 });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, "fixture_mismatch");
  assert.deepEqual(server.mockedHttp.map(request => request.matched), [true, false]);
});
