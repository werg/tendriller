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
    const html = injectRuntime("<HEAD data-x='1'>t</HEAD>", { id: "x", base: "/b/", version: 1, features: { transcribe: false, voice: false, push: false, vapid: "</script>" } });
    expect(html).toContain("<HEAD data-x='1'><script>");
    expect(html).not.toContain('"</script>"');
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("presence precedence", () => {
    const base: PresenceFacts = { now: 1_000_000_000, tokens: 1, lastCheckin: 1_000_000_000 - 1000, longPollHeld: false, webhook: false, scheduleMinutes: null, wakePendingSince: null, graceSeconds: 120, status: null, withheld: 0 };
    expect(computePresence(base).state).toBe("working");
    expect(computePresence({ ...base, longPollHeld: true }).state).toBe("listening");
    expect(computePresence({ ...base, wakePendingSince: base.now - 200_000, longPollHeld: true }).state).toBe("not_responding");
    expect(computePresence({ ...base, tokens: 0 }).state).toBe("no_agent");
    expect(computePresence({ ...base, lastCheckin: base.now - 2 * 3600_000 })).toMatchObject({ state: "away", text: "Last heard from 2 hours ago" });
    expect(computePresence({ ...base, lastCheckin: base.now - 2 * 3600_000, webhook: true }).state).toBe("listening");
    expect(computePresence({ ...base, lastCheckin: base.now - 25 * 3600_000, webhook: true }).state).toBe("away");
  });
});

describe("transcription via Workers AI", () => {
  it("passes base64 audio to whisper and returns text", async () => {
    const h = await create();
    const seen: any[] = [];
    await inDO(h.id, (t) => {
      (t.env as any).AI = {
        run: async (model: string, input: any) => {
          seen.push({ model, input });
          return { text: " hello world ", word_count: 2 };
        },
      };
    });
    try {
      const html = await (await req(h.page_url)).text();
      expect(html).toContain('"transcribe":true');
      const page = await PageClient.connect(h.page_url);
      const proof = { "X-Tendril-Device": page.deviceId, "X-Tendril-Device-Secret": page.secret };
      expect((await req(h.page_url + "_tendril/transcribe", { method: "POST", body: new Uint8Array([1]), headers: { "Content-Type": "audio/webm" } })).status).toBe(403);
      const res = await req(h.page_url + "_tendril/transcribe", { method: "POST", body: new Uint8Array([1, 2, 3]), headers: { "Content-Type": "audio/webm", ...proof } });
      page.close();
      expect(await res.json()).toEqual({ text: "hello world" });
      expect(seen[0]).toEqual({ model: "@cf/openai/whisper-large-v3-turbo", input: { audio: "AQID" } });
      expect((await apiJson(h, "GET", "")).id).toBe(h.id);
    } finally {
      await inDO(h.id, (t) => {
        delete (t.env as any).AI;
      });
    }
  });
});
