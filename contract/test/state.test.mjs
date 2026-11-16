import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, assertValid } from "../index.mjs";
import { normalizeStateChecks, stateConflict, statePath, normalizeStateOps, applyStateOps, stateMergePatch, STATE_CONDITIONS_BYTES } from "../state.mjs";

const command = extra => ({ cid: "edit-1", expected_generations: {}, ops: [], ...extra });
test("conditional state envelopes accept exactly one predicate and finite JSON", () => {
  assertValid("stateUpdate", command({ conditions: [{ path: ["a"], exists: false }, { path: [], equals: {} }], expected_revision: 0 }));
  const cyclic = {}; cyclic.self = cyclic;
  for (const equals of [undefined, NaN, Infinity, 1n, () => 0, cyclic, new Date(), [ , 1], { a: undefined }])
    assert.ok(validate("stateUpdate", command({ conditions: [{ path: ["a"], equals }] })).length, String(equals));
  for (const conditions of [[{ path: [], equals: null, exists: true }], [{ path: [] }], Array(129).fill({ path: [], exists: true }),
    [{ path: [], equals: "x".repeat(STATE_CONDITIONS_BYTES) }], [{ path: ["constructor"], exists: true }], [ , { path: [], exists: true }]])
    assert.ok(validate("stateUpdate", command({ conditions })).length);
  for (const expected_revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined])
    assert.ok(validate("stateUpdate", command({ expected_revision })).length);
  assert.ok(validate("stateOperations", [{ op: "set", path: ["a"], value: undefined }]).length);
});

test("browser state options reject misspelled guards and malformed metadata before serialization", () => {
  for (const options of [{ expected_revison: 1 }, { condition: [] }, { expected_generations: null },
    { expected_generations: [] }, { expected_generations: "wrong" }, { expected_generations: new Map() },
    { scope: 1 }, { get expected_revision() { return 1; } }])
    assert.ok(validate("stateWriteOptions", options).length);
  assertValid("stateWriteOptions", { expected_revision: 1, expected_generations: { source: "v1" }, conditions: [{ path: [], equals: {} }] });
});

test("conditions distinguish missing, null, own keys and incompatible ancestors", () => {
  const state = { nullable: null, nested: { value: 3 }, series: [1, null], "a.b": { "x/y": true } };
  const check = condition => stateConflict(state, 7, normalizeStateChecks({ conditions: [condition] }));
  for (const condition of [{ path: ["missing"], exists: false }, { path: ["nullable"], equals: null },
    { path: ["series"], equals: [1, null] }, { path: ["a.b", "x/y"], equals: true }, { path: ["toString"], exists: false }])
    assert.equal(check(condition), null);
  for (const condition of [{ path: ["missing"], equals: null }, { path: ["nullable"], exists: false },
    { path: ["nullable", "child"], exists: false }, { path: ["series", 0], equals: 1 }, { path: ["series"], equals: [null, 1] }])
    assert.equal(check(condition).kind, "condition");
  assert.equal(stateConflict({ x: { a: 1, b: [2] } }, 1, normalizeStateChecks({ conditions: [{ path: ["x"], equals: { b: [2], a: 1 } }] })), null);
  assert.deepEqual(stateConflict(state, 7, { expected_revision: 6 }), { kind: "revision" });
  assert.deepEqual(statePath(".nested..value."), ["nested", "value"]);
  assert.deepEqual(statePath(["", "a.b", "x/y", 0]), ["", "a.b", "x/y", "0"]);
});

test("explicit incompatible nested writes are atomic while merge patch replaces its parent", () => {
  for (const parent of [null, 5, "text", [], [1]]) {
    const before = { parent, keep: true };
    for (const op of ["set", "delete"]) assert.throws(() => applyStateOps(before, normalizeStateOps([
      { op: "set", path: ["keep"], value: false },
      { op, path: ["parent", "child"], ...(op === "set" ? { value: 4 } : {}) },
    ])), /parent explicitly/);
    assert.deepEqual(before, { parent, keep: true });
    assert.deepEqual(applyStateOps(before, stateMergePatch(before, { parent: { child: 4, removed: null } })), { parent: { child: 4 }, keep: true });
  }
  assert.deepEqual(applyStateOps({}, normalizeStateOps([{ op: "set", path: ["missing", "child"], value: null }])), { missing: { child: null } });
});

test("normalization detaches predicates and operation values from caller mutation", () => {
  const input = { conditions: [{ path: ["item"], equals: { version: 1 } }], expected_revision: 2 };
  const captured = normalizeStateChecks(input);
  input.conditions[0].path[0] = "other"; input.conditions[0].equals.version = 9; input.expected_revision = 10;
  assert.deepEqual(captured, { conditions: [{ path: ["item"], equals: { version: 1 } }], expected_revision: 2 });
});
