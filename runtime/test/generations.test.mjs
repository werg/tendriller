import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const source = await build({ entryPoints: [new URL("../src/generations.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const { captureContext, matchesContext, requiredScopes } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString("base64")}`);
const scopes = [
  { id: "opaque-a", generation: "gen-1", paths: [["notebook", "entries"]], operations: [] },
  { id: "opaque-b", generation: "gen-2", paths: [["runs"]], operations: ["capture"] },
];
const set = path => ({ op: "set", path, value: {} });

test("state guards cover descendants, ancestors and whole-document writes", () => {
  for (const path of [["notebook", "entries", "new"], ["notebook"], []]) {
    const context = captureContext(scopes, "state", {}, [set(path)]);
    assert.equal(context.expected_generations["opaque-a"], "gen-1");
    assert.equal(matchesContext(scopes, context, "state", [set(path)]), true);
  }
  assert.deepEqual(captureContext(scopes, "state", {}, [set(["notebookish"])]).expected_generations, {});
});

test("event and capture guards follow explicit bindings and scope, never payload names", () => {
  assert.deepEqual(captureContext(scopes, "event"), { expected_generations: {} });
  assert.deepEqual(captureContext(scopes, "event", { scope: "opaque-a" }), { scope: "opaque-a", expected_generations: { "opaque-a": "gen-1" } });
  assert.deepEqual(captureContext(scopes, "capture").expected_generations, { "opaque-b": "gen-2" });
  assert.throws(() => captureContext(scopes, "event", { scope: "not-installed" }), { code: "unknown_scope" });
});

test("captured metadata is immutable across rotation, retirement and rebinding", () => {
  const ops = [set(["notebook"])];
  const context = captureContext(scopes, "state", {}, ops);
  const original = structuredClone(context);
  for (const current of [
    [{ ...scopes[0], generation: "gen-next" }, scopes[1]],
    [scopes[1]],
    [{ ...scopes[0], generation: "new-meaning", paths: [["other"]] }, scopes[1]],
  ]) {
    assert.equal(matchesContext(current, context, "state", ops), false);
    assert.deepEqual(context, original);
  }
  const unguarded = captureContext([], "state", {}, ops);
  assert.equal(matchesContext(scopes, unguarded, "state", ops), false, "newly protected paths suppress old optimism");
});

test("independent work remains optimistic when a different scope changes", () => {
  const ops = [set(["unrelated"])];
  const context = captureContext(scopes, "state", {}, ops);
  assert.deepEqual(context.expected_generations, {});
  assert.equal(matchesContext([{ ...scopes[0], generation: "gen-next" }], context, "state", ops), true);
});

test("explicit expectations are copied without rebasing and stale expectations never match", () => {
  const expected_generations = { "opaque-a": "old" };
  const context = captureContext(scopes, "event", { scope: "opaque-a", expected_generations });
  expected_generations["opaque-a"] = "gen-1";
  assert.equal(context.expected_generations["opaque-a"], "old");
  assert.equal(matchesContext(scopes, context, "event"), false);
});

test("every operation rejects malformed supplied guards before copying or choosing scopes", () => {
  for (const operation of ["event", "state", "capture", "blob.pin", "timer.write"]) {
    for (const expected_generations of [null, [], "abc", false, { "opaque-a": 2 }, { "opaque-a": "" }])
      assert.throws(() => captureContext(scopes, operation, { expected_generations }), { code: "bad_request" });
    for (const scope of [null, "", 0, "constructor", "has spaces"])
      assert.throws(() => captureContext(scopes, operation, { scope }), { code: "bad_request" });
    for (const options of [null, [], "abc"])
      assert.throws(() => captureContext(scopes, operation, options), TypeError);
  }
});

test("generation capture rejects exotic or disappearing metadata without evaluating accessors", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "opaque-a", { enumerable: true, get() { reads++; return "gen-1"; } });
  const hidden = Object.defineProperty({}, "opaque-a", { value: "gen-1" });
  for (const expected_generations of [new Map([["opaque-a", "gen-1"]]), new Date(), accessor, hidden,
    { [Symbol("scope")]: "gen-1" }, Object.create({ "opaque-a": "gen-1" })])
    assert.throws(() => captureContext(scopes, "event", { expected_generations }), { code: "bad_request" });
  for (const key of ["scope", "expected_generations"]) {
    const options = Object.defineProperty({}, key, { enumerable: true, get() { reads++; return undefined; } });
    assert.throws(() => captureContext(scopes, "event", options), { code: "bad_request" });
    assert.throws(() => captureContext(scopes, "event", Object.defineProperty({}, key, { value: undefined })), { code: "bad_request" });
  }
  assert.equal(reads, 0);
  const expected_generations = Object.assign(Object.create(null), { "opaque-a": "gen-1" });
  assert.deepEqual(captureContext(scopes, "event", { expected_generations }), { expected_generations: { "opaque-a": "gen-1" } });
});
