import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";

// Exercise both adapters to the shared semantics, including their error paths.
const browserBuilt = buildSync({ entryPoints: [new URL("../src/state.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const browser = await import("data:text/javascript;base64," + Buffer.from(browserBuilt.outputFiles[0].text).toString("base64"));
const built = buildSync({ entryPoints: [new URL("../../server/src/state.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const server = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

test("browser/server path operations agree for explicit null, subtree replacement and delete", () => {
  const operations = [
    { op: "set", path: ["reading"], value: null },
    { op: "set", path: ["people", "a"], value: { name: "Ana", active: true } },
    { op: "set", path: ["people", "b"], value: { name: "Bo" } },
    { op: "delete", path: ["people", "a", "active"] },
    { op: "set", path: ["series"], value: [1, null, 3] },
  ];
  let a = {}, b = {};
  for (const operation of operations) {
    a = browser.applyOps(a, [structuredClone(operation)]);
    b = server.applyOps(b, server.validateOps([structuredClone(operation)]));
    assert.deepEqual(a, b);
  }
  assert.equal(Object.hasOwn(a, "reading"), true);
  assert.equal(a.reading, null);
});

test("merge patches agree after offline edits to separate object paths", () => {
  const initial = { people: { a: { checked: false }, b: { checked: false } }, reading: null };
  const changes = [{ people: { a: { checked: true } } }, { people: { b: { checked: true } } }, { reading: null }, { added: { nullable: null, value: 4 } }];
  let a = structuredClone(initial), b = structuredClone(initial);
  for (const patch of changes) {
    a = browser.applyOps(a, browser.mergePatchToOps(a, structuredClone(patch)));
    b = server.applyOps(b, server.mergePatchToOps(b, structuredClone(patch)));
    assert.deepEqual(a, b);
  }
  assert.deepEqual(a.people, { a: { checked: true }, b: { checked: true } });
});

test("browser/server reject incompatible explicit paths and agree on literal and dotted keys", () => {
  for (const path of [".a..b.", ["a.b", "x/y"], ["", 0]]) {
    const serverOp = server.validateOps([{ op: "set", path, value: null }]);
    const browserOp = [{ op: "set", path: browser.toPath(path), value: null }];
    assert.deepEqual(browserOp, serverOp);
    assert.deepEqual(browser.applyOps({}, browserOp), server.applyOps({}, serverOp));
  }
  for (const parent of [null, 5, "text", [1]]) {
    const op = { op: "set", path: ["parent", "child"], value: 2 };
    assert.throws(() => browser.applyOps({ parent }, [op]), /parent explicitly/);
    assert.throws(() => server.applyOps({ parent }, server.validateOps([op])), /parent explicitly/);
    const patch = { parent: { child: 2, removed: null } };
    assert.deepEqual(browser.applyOps({ parent }, browser.mergePatchToOps({ parent }, patch)), server.applyOps({ parent }, server.mergePatchToOps({ parent }, patch)));
  }
  assert.equal(browser.getPath({}, ["toString"]), undefined);
  assert.equal(browser.getPath({ items: [1] }, ["items", "0"]), undefined);
});
