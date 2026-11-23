import { describe, expect, it } from "vitest";
import { emojiIconSvg, injectRuntime } from "../src/inject";
import { resolveType } from "../src/mime";
import { isEmojiIcon } from "../src/pwa";
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

  it("accepts one complete emoji, including keyboard sequences", () => {
    for (const emoji of ["🌱", "❤", "❤️", "👍🏽", "👩‍💻", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇦🇹", "1️⃣", "#⃣",
      "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"]) {
      expect(isEmojiIcon(emoji), emoji).toBe(true);
    }
  });

  it("rejects plain text, multiple emoji and markup as emoji icons", () => {
    for (const value of ["", " ", "A", "garden", "1", "#", ":seedling:", "🌱🌻", "🌱 garden", "🌱\n",
      "🌱\u0301", "👩‍🌱", "\uFE0F", "\u200D", "\uD83C", "<svg></svg>", "🌱</text><script>alert(1)</script>",
      "https://example.test/icon.svg", "javascript:alert(1)"]) {
      expect(isEmojiIcon(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("renders complete emoji sequences as SVG text", () => {
    for (const emoji of ["🌱", "❤️", "👩🏽‍💻", "🇦🇹", "1️⃣"]) {
      const svg = emojiIconSvg(emoji);
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain(emoji);
      expect(svg).toContain("</text>");
      expect(svg).toContain("</svg>");
      expect(svg).not.toContain("\uFFFD");
    }
  });

  it("escapes SVG text even when called with unvalidated input", () => {
    const svg = emojiIconSvg('</text><script>alert(1)</script>&"');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;');
    expect(svg).not.toContain("<script>");
    expect((svg.match(/<\/text>/g) || []).length).toBe(1);
  });

  it("injection escapes the config", () => {
    const html = injectRuntime("<HEAD data-x='1'>t</HEAD>", { id: "x", base: "/b/", version: 1, documentPath: null, application: { id: "12".repeat(32) }, features: { shared_by: "</script>", speech: { model: "whistle", url: "x", sha256: "x", engine: {script:"engine.js",script_sha256:"x",wasm:"engine.wasm",wasm_sha256:"x"} } } });
    expect(html).toContain(`<HEAD data-x='1'><base href="/b/">`);
    expect(html).toContain('<link rel="manifest" href="/b/_tendril/manifest.webmanifest" crossorigin="use-credentials">');
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

  it("leaves an authored manifest's icon, name and theme in charge while filling a missing viewport", () => {
    const authored = '<link rel="manifest" href="./my-app.webmanifest" crossorigin="use-credentials">';
    for (const icon of ["https://example.test/host.png", "🌱"]) {
      const html = injectRuntime(`<head>${authored}</head><body></body>`, { id: "x", base: "/b/", version: 0,
        documentPath: null, application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
        branding: { name: "Host name", shortName: "Host", themeColor: "#102030", icon } });
      expect(html).toContain(authored);
      expect(html).not.toContain('_tendril/manifest.webmanifest');
      expect(html).not.toContain('rel="icon"');
      expect(html).not.toContain('apple-touch-icon');
      expect(html).not.toContain('apple-mobile-web-app-title');
      expect(html).not.toContain('name="theme-color"');
      expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
    }
  });

  it("uses configured HTTPS artwork as the favicon with its actual media type", () => {
    for (const [icon, type] of [
      ["https://example.test/icon.svg?version=2&variant=small", "image/svg+xml"],
      ["https://example.test/icon.PNG", "image/png"],
      ["https://example.test/icon.ico", "image/x-icon"],
      ["https://example.test/dynamic-icon", undefined],
    ]) {
      const html = injectRuntime('<head></head>', { id: "x", base: "/b/", version: 0, documentPath: null,
        application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
        branding: { name: "Page", icon } });
      const favicons = html.match(/<link\b[^>]*\brel="icon"[^>]*>/g) || [];
      expect(favicons).toHaveLength(1);
      expect(favicons[0]).toContain(`href="${icon!.replaceAll("&", "&amp;")}"`);
      if (type) expect(favicons[0]).toContain(`type="${type}"`);
      else expect(favicons[0]).not.toContain("type=");
      expect(favicons[0]).not.toContain("sizes=");
    }
  });

  it("uses the local generated SVG favicon for an emoji", () => {
    const html = injectRuntime('<head></head>', { id: "x", base: "/b/", version: 0, documentPath: null,
      application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
      branding: { name: "Page", icon: "👩🏽‍💻" } });
    const favicons = html.match(/<link\b[^>]*\brel="icon"[^>]*>/g) || [];
    expect(favicons).toHaveLength(1);
    expect(favicons[0]).toMatch(/href="\/b\/_tendril\/icon\.svg(?:\?[^\"]*)?"/);
    expect(favicons[0]).toContain('type="image/svg+xml"');
    expect(favicons[0]).toContain('sizes="any"');
  });

  it("escapes configured favicon URLs in injected attributes", () => {
    const html = injectRuntime('<head></head>', { id: "x", base: "/b/", version: 0, documentPath: null,
      application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
      branding: { name: "Page", icon: 'https://example.test/icon.svg?a=1&label="<script>"' } });
    expect(html).toContain('href="https://example.test/icon.svg?a=1&amp;label=&quot;&lt;script');
    expect(html).not.toContain('label="<script>"');
  });

  it("preserves an authored favicon when a URL or emoji icon is configured", () => {
    const authored = '<link rel="shortcut icon" href="./own.ico">';
    for (const icon of ["https://example.test/host.svg", "🌱"]) {
      const html = injectRuntime(`<head>${authored}</head>`, { id: "x", base: "/b/", version: 0, documentPath: null,
        application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
        branding: { name: "Page", icon } });
      expect(html).toContain(authored);
      expect(html).not.toContain('rel="icon"');
      expect(html).not.toContain('_tendril/icon.svg');
      expect(html).not.toContain('https://example.test/host.svg');
      expect(html).toContain('_tendril/manifest.webmanifest');
    }
  });

  it("fills mobile metadata gaps with escaped page branding", () => {
    const html = injectRuntime('<html><head><title>Page</title></head><body></body></html>', {
      id: "x", base: "/b/", version: 0, documentPath: null, application: { id: "12".repeat(32) },
      features: { speech: null, shared_by: "owner" }, branding: {
        name: 'A <page> & "friends"', shortName: 'A & "B"', themeColor: "#102030",
      },
    });
    expect(html).toContain('<link rel="apple-touch-icon" href="/_tendril/brand/icon-180.png" sizes="180x180">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="A &amp; &quot;B&quot;">');
    expect(html).toContain('<meta name="theme-color" content="#102030">');
    expect(html).toContain('content="width=device-width,initial-scale=1,viewport-fit=cover"');
    expect(html).not.toContain('"branding":');
  });

  it("preserves each authored install preference including unquoted and mixed-case attributes", () => {
    const head = `<LINK REL='manifest' href="app.webmanifest" crossorigin="use-credentials">
      <link rel="shortcut icon" href="own.ico"><link rel=apple-touch-icon-precomposed href="own.png">
      <META content="#abcdef" NAME=theme-color><meta name='apple-mobile-web-app-title' content="Own title">
      <meta name=viewport content="width=device-width,initial-scale=1">`;
    const html = injectRuntime(`<head>${head}</head>`, { id: "x", base: "/b/", version: 0,
      documentPath: null, application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
      branding: { name: "Default", themeColor: "#102030" } });
    expect(html).toContain(head);
    expect(html).not.toContain('_tendril/manifest.webmanifest');
    expect(html).not.toContain('_tendril/icon');
    expect(html).not.toContain('_tendril/brand/');
    expect(html).not.toContain('#102030');
    expect((html.match(/name=viewport/g) || []).length).toBe(1);
  });

  it("does not let commented markup, scripts or data attributes hide install defaults", () => {
    const html = injectRuntime(`<head><!-- <link rel="manifest"> --><script>const example = '<meta name="theme-color">';</script>
      <link data-rel="manifest"><meta data-name="viewport"></head>`, { id: "x", base: "/b/", version: 0,
      documentPath: null, application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" } });
    expect(html).toContain('href="/b/_tendril/manifest.webmanifest" crossorigin="use-credentials"');
    expect(html).toContain('<meta name="theme-color" content="#2d6a4f">');
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
  });

  it("uses configured PNG artwork for Apple without inventing its dimensions", () => {
    const html = injectRuntime('<head></head>', { id: "x", base: "/b/", version: 0, documentPath: null,
      application: { id: "12".repeat(32) }, features: { speech: null, shared_by: "owner" },
      branding: { name: "Page", icon: "https://example.test/custom.PNG?version=2" } });
    expect(html).toContain('<link rel="apple-touch-icon" href="https://example.test/custom.PNG?version=2">');
    expect(html).not.toContain('sizes="180x180"');
  });

});
