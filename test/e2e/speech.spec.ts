import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { agent, createPage, deletePage, openClaimed, signInFixture } from "./local-helpers";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("speech Worker passes model length as bigint to an i64 WASM export", async ({ page }) => {
  const source = await readFile("server/public/_tendril/speech-worker.js", "utf8");
  const wasm = new Uint8Array([1, 2, 3]);
  const model = new Uint8Array([4, 5, 6, 7]);
  const fixture = source.replace("4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6", hash(wasm));
  expect(fixture).not.toBe(source);
  await page.goto("https://service.localhost:8790/health");
  const result = await page.evaluate(async ({ script, wasmBytes, modelBytes, modelHash }) => {
    const preamble = `
      var createCactus = async () => ({
        _malloc: () => 1, _free: () => {}, HEAPU8: new Uint8Array(1024),
        _cactus_load: (_ptr, length) => { if (typeof length !== 'bigint') throw new TypeError('i64 requires bigint'); return 0; },
        ccall: () => 0, UTF8ToString: () => '{"text":""}'
      });
      self.importScripts = () => {};
      self.fetch = async url => new Response(new Uint8Array(String(url).endsWith('cactus.wasm') ? ${JSON.stringify(wasmBytes)} : ${JSON.stringify(modelBytes)}));
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([preamble, script], { type: "text/javascript" })));
    const messages: any[] = [];
    const settled = new Promise<any>((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = event => { messages.push(event.data); if (event.data.ready || event.data.error) resolve(event.data); };
    });
    worker.postMessage({ id: 1, action: "init", base: "/s/test/", modelUrl: "/whistle.cact", modelSha256: modelHash });
    const response = await settled;
    worker.terminate();
    return { response, messages };
  }, { script: fixture, wasmBytes: [...wasm], modelBytes: [...model], modelHash: hash(model) });
  expect(result.response).toMatchObject({ id: 1, ready: true });
  expect(result.messages.some((m: any) => m.progress?.includes("Verifying"))).toBe(true);
});

test("microphone starts after consent and transcribes via OfflineAudioContext without autoplay failure", async ({ page, context }) => {
  const h = await createPage();
  try {
    await page.addInitScript(() => {
      (window as any).__speechE2E = { decoderCalls: 0, transcribes: 0 };
      const NativeWorker = window.Worker;
      (window as any).Worker = class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        constructor(url: string | URL) { if (!String(url).includes("speech-worker.js")) return new NativeWorker(url) as any; }
        postMessage(msg: any) {
          if (msg.action === "transcribe") (window as any).__speechE2E.transcribes++;
          queueMicrotask(() => this.onmessage?.({ data: msg.action === "init" ? { id: msg.id, ready: true } : { id: msg.id, text: "recognized voice" } } as MessageEvent));
        }
        terminate() {}
      };
      (window as any).OfflineAudioContext = class {
        constructor() {}
        async decodeAudioData(_data: ArrayBuffer) {
          (window as any).__speechE2E.decoderCalls++;
          return { numberOfChannels: 1, length: 16000, sampleRate: 16000, getChannelData: () => new Float32Array(16000) };
        }
      };
    });
    await signInFixture(context);
    await openClaimed(page, h);
    const warnings: string[] = [];
    page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
    const mic = page.locator('[data-tendril="control"] .mic').first();
    await expect(mic).toBeVisible();
    await mic.click();
    await page.getByRole("button", { name: "Download and continue" }).click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await mic.click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).__speechE2E)).transcribes).toBe(1);
    await expect.poll(async () => (await agent(h, "/events?wait=0")).data.events.some((e: any) => JSON.stringify(e.data).includes("recognized voice"))).toBe(true);
    expect(await page.evaluate(() => (window as any).__speechE2E.decoderCalls)).toBe(1);
    expect(warnings.join(" ")).not.toMatch(/AudioContext was prevented|autoplay/i);
  } finally { await deletePage(h); }
});
