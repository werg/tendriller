import { describe, expect, it } from "vitest";
import { injectRuntime } from "../src/inject";
import { resolveType } from "../src/mime";
import { normalizeFilePath } from "../src/urls";

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
    const html = injectRuntime("<HEAD data-x='1'>t</HEAD>", { id: "x", base: "/b/", version: 1, documentPath: null, application: { id: "12".repeat(32) }, features: { shared_by: "</script>", speech: { model: "whistle", url: "x", sha256: "x", engine: {script:"engine.js",wasm:"engine.wasm",wasm_sha256:"x"} } } });
    expect(html).toContain(`<HEAD data-x='1'><base href="/b/">`);
    expect(html).toContain('<link rel="manifest" href="/b/_tendril/manifest.webmanifest">');
    expect(html).not.toContain('"</script>"');
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("keeps a published page's own web-app manifest", () => {
    const cfg = { id: "x", base: "/b/", version: 1, documentPath: null, application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" } } as any;
    const html = injectRuntime('<head><link rel="icon manifest" href="/b/my-app.webmanifest"></head><body></body>', cfg);
    expect(html).toContain('href="/b/my-app.webmanifest"');
    expect(html).not.toContain('_tendril/manifest.webmanifest');
    expect((html.match(/rel="icon manifest"/g) || []).length).toBe(1);
  });

});
