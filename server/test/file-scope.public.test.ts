import { expect, it } from "vitest";
import { api, apiJson, create, inDO } from "./helpers";
import { assertValid } from "../../contract/index.mjs";

const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });

it("derives file guards from the registry through rotation, replay, retirement and monotonic deletion", async () => {
  const page = await create();
  const blob = await inDO(page.id, t => t.storeBlob(new Uint8Array([1, 2, 3]).buffer, "application/octet-stream", null, null, "agent"));
  const path = "reports/result.json", scope = "file-review";
  const registered = await apiJson(page, "PUT", `scopes/${scope}`, command({ paths: [["files", path]], operations: [] }));
  const firstGuard = { [scope]: registered.generation };
  const input = { path, expected_revision: 0, blob_id: blob.id };

  // A path binding covers one canonical filename, not every file or the directory.
  await apiJson(page, "PUT", "file-refs", command({ ...input, path: "reports/other.json" }));
  const omitted = await api(page, "PUT", "file-refs", command(input));
  expect(omitted.status).toBe(428);
  expect(await omitted.json()).toMatchObject({ error: { code: "generation_required" } });
  const stale = await api(page, "PUT", "file-refs", command({ ...input, expected_generations: { [scope]: "obsolete" } }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_generation" } });

  const original = command({ ...input, scope, expected_generations: firstGuard });
  const accepted = await apiJson(page, "PUT", "file-refs", original);
  expect(accepted.file).toMatchObject({ path, revision: 1, blob_id: blob.id });
  expect(accepted.file).not.toHaveProperty("scope");
  assertValid("fileResult", accepted);
  const rotated = await apiJson(page, "POST", `scopes/${scope}/rotate`, command({ expected_generations: firstGuard }));
  expect(await apiJson(page, "PUT", "file-refs", original)).toEqual(accepted);

  const next = { ...input, expected_revision: 1 };
  expect((await api(page, "PUT", "file-refs", command(next))).status).toBe(428);
  expect((await api(page, "PUT", "file-refs", command({ ...next, expected_generations: firstGuard }))).status).toBe(409);
  const currentGuard = { [scope]: rotated.generation };
  const second = await apiJson(page, "PUT", "file-refs", command({ ...next, expected_generations: currentGuard }));
  expect(second.file.revision).toBe(2);

  const oldDelete = command({ path, expected_revision: 2, expected_generations: currentGuard });
  await apiJson(page, "DELETE", `scopes/${scope}`, command({ expected_generations: currentGuard }));
  const retired = await api(page, "DELETE", "file-refs", oldDelete);
  expect(retired.status).toBe(409);
  expect(await retired.json()).toMatchObject({ error: { code: "stale_generation" } });

  const deletion = command({ path, expected_revision: 2 });
  const deleted = await apiJson(page, "DELETE", "file-refs", deletion);
  expect(deleted.file).toMatchObject({ path, revision: 3, blob_id: null });
  expect(await apiJson(page, "DELETE", "file-refs", deletion)).toEqual(deleted);
  expect(await apiJson(page, "GET", `file-refs?path=${encodeURIComponent(path)}`)).toEqual(deleted.file);
  expect((await api(page, "PUT", "file-refs", command(input))).status).toBe(409);
  const recreated = await apiJson(page, "PUT", "file-refs", command({ ...input, expected_revision: 3 }));
  expect(recreated.file.revision).toBe(4);
  expect(await apiJson(page, "PUT", "file-refs", original)).toEqual(accepted);
  expect((await apiJson(page, "GET", `file-refs?path=${encodeURIComponent(path)}`)).revision).toBe(4);

  const history = await apiJson(page, "GET", `file-refs/history?path=${encodeURIComponent(path)}`);
  expect(history.versions.map((file: any) => file.revision)).toEqual([4, 3, 2, 1]);
  const snapshot = await apiJson(page, "GET", "file-refs/snapshot");
  const changes = await apiJson(page, "GET", "file-refs/changes?after=0");
  for (const file of [...history.versions, ...snapshot.files, ...changes.changes.map((change: any) => change.file)]) {
    expect(file).not.toHaveProperty("scope");
    assertValid("fileHead", file);
  }
});

it("treats a selected command scope as a one-operation guard without creating a file binding", async () => {
  const page = await create();
  const blob = await inDO(page.id, t => t.storeBlob(new Uint8Array([4]).buffer, "application/octet-stream", null, null, "agent"));
  const scope = await apiJson(page, "PUT", "scopes/review-intent", command({ paths: [], operations: [] }));
  const input = { path: "unbound.txt", expected_revision: 0, blob_id: blob.id };
  const first = await apiJson(page, "PUT", "file-refs", command({ ...input, scope: scope.id,
    expected_generations: { [scope.id]: scope.generation } }));
  expect(first.file).not.toHaveProperty("scope");
  const next = await apiJson(page, "PUT", "file-refs", command({ ...input, expected_revision: 1 }));
  expect(next.file.revision).toBe(2);
  expect(next.file).not.toHaveProperty("scope");
});
