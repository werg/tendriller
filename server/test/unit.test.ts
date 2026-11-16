import { describe, expect, it } from "vitest";
import { injectRuntime } from "../src/inject";
import { resolveType } from "../src/mime";
import { computePresence, type PresenceFacts } from "../src/presence";
import { applyOps, mergePatchToOps, replaceToOps, validateOps } from "../src/state";
import { normalizeFilePath } from "../src/urls";
import { apiJson, create, inDO, PageClient, req } from "./helpers";

describe("state ops", () => {
  it("merge patch follows RFC 7396 semantics", () => {
    const cases: [any, any, any][] = [
      [{ a: "b" }, { a: "c" }, { a: "c" }],
      [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
      [{ a: "b" }, { a: null }, {}],
      [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
      [{ a: ["b"] }, { a: "c" }, { a: "c" }],
      [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
      [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
      [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
      [{ e: null }, { a: 1 }, { e: null, a: 1 }],
      [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
    ];
    for (const [doc, patch, want] of cases) {
      const ops = mergePatchToOps(doc, patch);
      expect(applyOps(structuredClone(doc), ops), JSON.stringify([doc, patch])).toEqual(want);
    }
  });

  it("replace produces top-level ops; validate rejects bad input", () => {
    const ops = replaceToOps({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(ops).toEqual([
      { op: "delete", path: ["a"] },
      { op: "set", path: ["b"], value: 3 },
      { op: "set", path: ["c"], value: 4 },
    ]);
    expect(validateOps([{ op: "set", path: "a.b", value: 1 }])).toEqual([{ op: "set", path: ["a", "b"], value: 1 }]);
    expect(() => validateOps([{ op: "delete", path: [] }])).toThrow();
    expect(() => validateOps([{ op: "set", path: ["constructor"], value: 1 }])).toThrow();
    expect(() => validateOps({})).toThrow();
  });
});

describe("helpers", () => {
  it("content types", () => {
    expect(resolveType("a.html", null)).toBe("text/html; charset=utf-8");
    expect(resolveType("a.html", "text/plain;charset=UTF-8")).toBe("text/html; charset=utf-8");
    expect(resolveType("a.css", "application/x-www-form-urlencoded")).toBe("text/css; charset=utf-8");
    expect(resolveType("notes", "text/plain")).toBe("text/plain; charset=utf-8");
    expect(resolveType("a.bin", null)).toBe("application/octet-stream");
    expect(resolveType("a.png", "image/webp")).toBe("image/webp");
  });

  it("file paths", () => {
    expect(normalizeFilePath("/a/b.js")).toBe("a/b.js");
    for (const bad of ["", "a/", "../x", "a//b", "_tendril/x", "a/./b"]) expect(normalizeFilePath(bad), bad).toBeNull();
  });

  it("injection escapes the config", () => {
    const html = injectRuntime("<HEAD data-x='1'>t</HEAD>", { id: "x", base: "/b/", version: 1, features: { push: false, vapid: "</script>", shared_by: "owner", speech: { model: "whistle", url: "x", sha256: "x", engine: {script:"engine.js",wasm:"engine.wasm",wasm_sha256:"x"} } } });
    expect(html).toContain(`<HEAD data-x='1'><base href="/b/">`);
    expect(html).toContain('<link rel="manifest" href="/b/_tendril/manifest.webmanifest">');
    expect(html).not.toContain('"</script>"');
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("keeps a published page's own web-app manifest", () => {
    const cfg = { id: "x", base: "/b/", version: 1, features: { push: false, vapid: null, shared_by: "owner" } } as any;
    const html = injectRuntime('<head><link rel="icon manifest" href="/b/my-app.webmanifest"></head><body></body>', cfg);
    expect(html).toContain('href="/b/my-app.webmanifest"');
    expect(html).not.toContain('_tendril/manifest.webmanifest');
    expect((html.match(/rel="icon manifest"/g) || []).length).toBe(1);
  });

});
