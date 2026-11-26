import { voicePage } from "./authored-pages";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { claim, createPage, deletePage, openClaimed, publish, signInFixture, SERVICE } from "./local-helpers";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("speech Worker passes model length as bigint to an i64 WASM export", async ({ page }) => {
  const source = await readFile("dist/runtime/assets/voice-worker.js", "utf8");
  const wasm = new Uint8Array([1, 2, 3]);
  const model = new Uint8Array([4, 5, 6, 7]);
  const engineScript = new TextEncoder().encode("/* verified fixture script */");
  await page.goto(`${SERVICE}/health`);
  const result = await page.evaluate(async ({ script, scriptBytes, scriptHash, wasmBytes, wasmHash, modelBytes, modelHash }) => {
    const preamble = `
      var createCactus = async () => ({
        _malloc: () => 1, _free: () => {}, HEAPU8: new Uint8Array(1024),
        _cactus_load: (_ptr, length) => { if (typeof length !== 'bigint') throw new TypeError('i64 requires bigint'); return 0; },
        ccall: () => 0, UTF8ToString: () => '{"text":""}'
      });
      self.importScripts = () => {};
      self.fetch = async url => new Response(new Uint8Array(String(url).endsWith('cactus.js') ? ${JSON.stringify(scriptBytes)} : String(url).endsWith('cactus.wasm') ? ${JSON.stringify(wasmBytes)} : ${JSON.stringify(modelBytes)}));
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([preamble, script], { type: "text/javascript" })));
    const messages: any[] = [];
    const settled = new Promise<any>((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = event => { messages.push(event.data); if (event.data.ready || event.data.error) resolve(event.data); };
    });
    worker.postMessage({ id: 1, action: "init", engine: { script: "https://fixture.test/cactus.js", script_sha256: scriptHash, wasm: "https://fixture.test/cactus.wasm", wasm_sha256: wasmHash }, modelUrl: "https://fixture.test/whistle.cact", modelSha256: modelHash });
    const response = await settled;
    worker.terminate();
    return { response, messages };
  }, { script: source, scriptBytes: [...engineScript], scriptHash: hash(engineScript), wasmBytes: [...wasm], wasmHash: hash(wasm), modelBytes: [...model], modelHash: hash(model) });
  expect(result.response).toMatchObject({ id: 1, ready: true });
  expect(result.messages.some((m: any) => m.progress?.includes("Verifying"))).toBe(true);
});

test("microphone starts after consent and transcribes via OfflineAudioContext without autoplay failure", async ({ page, context }) => {
  const h = await createPage();
  try {
    await page.addInitScript(() => {
      (window as any).__speechE2E = { decoderCalls: 0, pcmChunks: 0, transcribes: 0, recordedBytes: 0 };
      const NativeWorklet = window.AudioWorkletNode;
      if (typeof NativeWorklet === "function") {
        (window as any).AudioWorkletNode = class extends NativeWorklet {
          constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
            super(context, name, options);
            if (name === "tendriller-voice-pcm") {
              this.port.addEventListener("message", event => {
                const msg = event.data;
                if (msg?.type === "pcm" && msg.samples && typeof msg.samples.byteLength === "number") {
                  (window as any).__speechE2E.pcmChunks++;
                  (window as any).__speechE2E.recordedBytes += msg.samples.byteLength;
                }
              });
            }
          }
        };
      }
      const NativeRecorder = window.MediaRecorder;
      (window as any).MediaRecorder = class extends NativeRecorder {
        constructor(stream: MediaStream, options?: MediaRecorderOptions) {
          super(stream, options);
          this.addEventListener("dataavailable", event => { (window as any).__speechE2E.recordedBytes += event.data.size; });
        }
      };
      const NativeWorker = window.Worker;
      (window as any).Worker = class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        constructor(url: string | URL) { if (!String(url).includes("voice-worker.js")) return new NativeWorker(url) as any; }
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
    await claim(context, h);
    await publish(h, voicePage);
    await openClaimed(page, h);
    await page.waitForFunction(() => !!(window as any).voice);
    const warnings: string[] = [];
    page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
    const mic = page.locator("#record");
    await expect(mic).toBeVisible();
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    // Observe encoded input instead of racing an immediate finish against the
    // real MediaRecorder's first chunk. No fixed sleep or fabricated audio.
    await expect.poll(() => page.evaluate(() => (window as any).__speechE2E.recordedBytes)).toBeGreaterThan(0);
    await mic.click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).__speechE2E)).transcribes).toBe(1);
    await expect(page.locator("#draft")).toHaveValue("recognized voice");
    const stats = await page.evaluate(() => (window as any).__speechE2E);
    expect(stats.pcmChunks > 0 || stats.decoderCalls === 1).toBe(true);
    expect(warnings.join(" ")).not.toMatch(/AudioContext was prevented|autoplay/i);
  } finally { await deletePage(h); }
});
