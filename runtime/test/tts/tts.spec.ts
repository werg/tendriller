import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let entry: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))], bundle: true, format: "iife", write: false });
  entry = result.outputFiles[0].text;
});

const module = `
window.loads = (window.loads || 0) + 1;
export class PhononTTS {
  static async load(options) {
    window.initializations = (window.initializations || 0) + 1;
    window.loadOptions = options;
    options.onProgress({file:'weights',loaded:30e6,total:65e6,cached:false});
    if (window.holdLoad) await new Promise(resolve => window.releaseLoad = resolve);
    if (window.failLoad) throw Error('offline');
    return new PhononTTS();
  }
  sampleRate = 24000;
  stream(text, {signal}) {
    window.spoken.push(text);
    const stalled = text === 'stall';
    const done = stalled ? new Promise(resolve => window.releaseDone = resolve) : Promise.resolve({});
    signal.addEventListener('abort', () => window.cancelSeen = true, {once:true});
    const stream = (async function*() {
      try {
        if (stalled) await new Promise(resolve => window.releaseStall = resolve);
        for(let i=0;i<(text==='empty'?0:text==='long'?200:1);i++) {
          if(signal.aborted) break;
          yield new Float32Array(2400).fill(0.01);
          await new Promise(resolve=>setTimeout(resolve, 5));
        }
      } finally { window.completed.push(text); }
    })();
    stream.done = done;
    return stream;
  }
  dispose() { window.disposals++; window.releaseStall?.(); window.releaseDone?.({}); }
}`;

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.spoken = []; w.browserSpoken = []; w.completed = []; w.disposals = 0; w.starts = 0; w.stops = 0;
    Object.defineProperty(window, "speechSynthesis", { value: { speak: (u: any) => w.browserSpoken.push(u.text), cancel() {} } });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args: any[]) { w.starts++; return start.apply(this, args as any); };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function(...args: any[]) { w.stops++; return stop.apply(this, args as any); };
  });
  await page.route("http://localhost:7789/**", route => {
    if (route.request().url().endsWith("/runtime/tts/index.js")) return route.fulfill({body:module, contentType:"text/javascript"});
    return route.fulfill({body:`<!doctype html><meta charset="utf-8"><script>${entry}</script>`, contentType:"text/html"});
  });
  await page.goto("http://localhost:7789/page/");
}

test("browser speech is immediate by default and downloads no model", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => (window as any).tts.status.enabled)).toBe(false);
  await page.evaluate(() => (window as any).tts.speak('Ready now'));
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['Ready now']);
  expect(await page.evaluate(() => (window as any).tts.speaking)).toBe(true);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("an optional model download does not delay or repeat a live reply", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.holdLoad=true; void w.tts.enable(); });
  await page.waitForFunction(() => !!(window as any).releaseLoad);
  await page.evaluate(() => (window as any).tts.speak('First reply'));
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['First reply']);
  await page.evaluate(() => (window as any).releaseLoad());
  await expect.poll(() => page.evaluate(() => (window as any).tts.status.state)).toBe('ready');
  expect(await page.evaluate(() => (window as any).spoken)).toEqual([]);
  await page.evaluate(() => (window as any).tts.speak('Next reply'));
  await expect.poll(() => page.evaluate(() => (window as any).completed)).toEqual(['Next reply']);
});

test("prepared neural replies play sequentially and reuse the model", async ({ page }) => {
  await open(page); await page.evaluate(async () => { const w=window as any; await w.tts.enable(); await w.tts.enable(); w.tts.speak('first'); w.tts.speak('second'); });
  await expect.poll(() => page.evaluate(() => (window as any).completed)).toEqual(['first','second']);
  expect(await page.evaluate(() => (window as any).initializations)).toBe(1);
  expect(await page.evaluate(() => (window as any).browserSpoken)).toEqual([]);
});

test("mute and non-English preferences avoid the model download", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.preferences.update({audio:false}); w.tts.speak('muted'); });
  await page.evaluate(() => { const w=window as any; w.preferences.update({audio:true,language:'de-DE'}); w.tts.speak('Guten Tag'); });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['Guten Tag']);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("failed optional voice falls back without repeated downloads and can retry", async ({page}) => {
  await open(page);
  await page.evaluate(async () => { const w=window as any; w.failLoad=true; await w.tts.enable().catch(() => {}); w.tts.speak('fallback'); w.tts.speak('next'); });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['fallback','next']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('error');
  await page.evaluate(async () => { const w=window as any; w.failLoad=false; await w.tts.enable(); w.tts.speak('retry'); });
  await expect.poll(() => page.evaluate(() => (window as any).spoken)).toEqual(['retry']);
});

test("stop interrupts prepared audio and a browser preference survives reload", async ({page}) => {
  await open(page); await page.evaluate(async () => { const w=window as any; await w.tts.enable(); w.tts.speak('long'); });
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).tts.speaking)).toBe(true);
  await page.evaluate(() => (window as any).tts.disable());
  expect(await page.evaluate(() => (window as any).stops)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).tts.speaking)).toBe(false);
  await page.reload();
  expect(await page.evaluate(() => (window as any).tts.status.enabled)).toBe(false);
  await page.evaluate(() => (window as any).tts.speak('browser only'));
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['browser only']);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("disabling during a download disposes the late model", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.holdLoad=true; void w.tts.enable().catch(() => {}); });
  await page.waitForFunction(() => !!(window as any).releaseLoad);
  await page.evaluate(() => { const w=window as any; w.tts.disable(); w.releaseLoad(); });
  await expect.poll(() => page.evaluate(() => (window as any).disposals)).toBe(1);
  expect(await page.evaluate(() => (window as any).spoken)).toEqual([]);
  expect(await page.evaluate(() => (window as any).tts.status.enabled)).toBe(false);
});

test("empty neural output falls back rather than dropping the reply", async ({page}) => {
  await open(page); await page.evaluate(async () => { const w=window as any; await w.tts.enable(); w.tts.speak('empty'); });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['empty']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('error');
});

test("unsupported neural browsers still have immediate browser speech", async ({page}) => {
  await open(page);
  await page.evaluate(async () => { Object.defineProperty(window, 'Worker', {value:undefined}); const w=window as any; await w.tts.enable().catch(() => {}); w.tts.speak('fallback'); });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['fallback']);
  expect(await page.evaluate(() => (window as any).loads || 0)).toBe(0);
});

test("autoplay rejection preserves a prepared model and recovers after interaction", async ({page}) => {
  await open(page); await page.evaluate(async () => (window as any).tts.enable());
  await page.evaluate(() => {
    const w=window as any;
    const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!;
    Object.defineProperty(AudioContext.prototype, 'state', {get() { return w.blockAudio ? 'suspended' : state.get!.call(this); }});
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function() { return w.blockAudio ? Promise.reject(Error('autoplay blocked')) : resume.call(this); };
    w.blockAudio = true; w.tts.speak('blocked');
  });
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['blocked']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('ready');
  await page.evaluate(() => { const w=window as any; w.blockAudio=false; w.tts.speak('unblocked'); });
  await expect.poll(() => page.evaluate(() => (window as any).completed)).toEqual(['unblocked']);
  expect(await page.evaluate(() => (window as any).initializations)).toBe(1);
});

test("a stalled synthesis falls back instead of blocking later replies", async ({page}) => {
  await open(page); await page.evaluate(async () => (window as any).tts.enable());
  await page.clock.install();
  await page.evaluate(() => { const w=window as any; w.tts.speak('stall'); w.tts.speak('next'); });
  await page.waitForFunction(() => !!(window as any).releaseStall);
  await page.clock.fastForward(30_001); await page.waitForFunction(() => !!(window as any).cancelSeen); await page.clock.fastForward(1100);
  await expect.poll(() => page.evaluate(() => (window as any).browserSpoken)).toEqual(['stall','next']);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('error');
});

test("returning to a page invalidates an unfinished model load", async ({page}) => {
  await open(page);
  await page.evaluate(() => { const w=window as any; w.holdLoad=true; void w.tts.enable().catch(() => {}); });
  await page.waitForFunction(() => !!(window as any).releaseLoad);
  await page.evaluate(() => { const w=window as any; window.dispatchEvent(new Event('pagehide')); w.releaseLoad(); });
  await expect.poll(() => page.evaluate(() => (window as any).disposals)).toBe(1);
  expect(await page.evaluate(() => (window as any).tts.status.state)).toBe('idle');
  await page.evaluate(async () => { const w=window as any; w.holdLoad=false; await w.tts.enable(); w.tts.speak('fresh'); });
  await expect.poll(() => page.evaluate(() => (window as any).spoken)).toEqual(['fresh']);
});

test("real bundled phonon-tts module, worker, and WASM load cleanly with zero security/file:/// errors and safe fallback", async ({ page }) => {
  const assetsDir = resolve(fileURLToPath(new URL("../../../dist/runtime/assets", import.meta.url)));
  const mimeTypes: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
  };
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (req, res) => {
    const reqPath = (req.url || "/").split("?")[0];
    if (reqPath === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>Real TTS Check</title><main>TTS</main>");
      return;
    }
    if (reqPath.startsWith("/runtime/")) {
      const rel = reqPath.slice("/runtime/".length);
      if (rel.includes("..") || rel.startsWith("/")) { res.writeHead(400); res.end(); return; }
      try {
        const bytes = await readFile(join(assetsDir, rel));
        res.writeHead(200, { "Content-Type": mimeTypes[extname(rel)] || "application/octet-stream" });
        res.end(bytes);
        return;
      } catch {
        res.writeHead(404); res.end("not found"); return;
      }
    }
    res.writeHead(404); res.end("not found");
  });
  server.on("connection", s => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const securityErrors: string[] = [];
  page.on("console", msg => {
    if (msg.type() === "error" || /security error|file:\/\/\//i.test(msg.text())) securityErrors.push(msg.text());
  });
  page.on("pageerror", err => securityErrors.push(err.message));

  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No server address");
    const base = `http://127.0.0.1:${addr.port}`;
    await page.goto(`${base}/`);
    const result = await page.evaluate(async (origin) => {
      const mod = await import(`${origin}/runtime/tts/index.js`);
      const wasmRes = await fetch(`${origin}/runtime/tts/wasm/phonon_tts_simd_bg.wasm`);
      const wasmBytes = await wasmRes.arrayBuffer();
      const wasmCompiled = await WebAssembly.validate(wasmBytes);
      const workerRes = await fetch(`${origin}/runtime/tts/worker.js`);
      const workerText = await workerRes.text();
      // Instantiate the real module worker and verify it boots without any file:/// or SyntaxError
      const workerErrors: string[] = [];
      const w = new Worker(`${origin}/runtime/tts/worker.js`, { type: "module" });
      w.onerror = e => workerErrors.push(e.message || "worker error");
      await new Promise(r => setTimeout(r, 150));
      w.terminate();
      return {
        hasPhononTTS: typeof mod.PhononTTS === "function",
        hasLoad: typeof mod.PhononTTS?.load === "function",
        wasmStatus: wasmRes.status,
        wasmSize: wasmBytes.byteLength,
        wasmCompiled,
        workerStatus: workerRes.status,
        workerHasFileUrl: /file:\/\/\//.test(workerText),
        workerErrors,
      };
    }, base);

    expect(result.hasPhononTTS).toBe(true);
    expect(result.hasLoad).toBe(true);
    expect(result.wasmStatus).toBe(200);
    expect(result.wasmSize).toBeGreaterThan(10_000);
    expect(result.wasmCompiled).toBe(true);
    expect(result.workerStatus).toBe(200);
    expect(result.workerHasFileUrl).toBe(false);
    expect(result.workerErrors).toEqual([]);
    expect(securityErrors).toEqual([]);
  } finally {
    const closed = new Promise<void>(r => server.close(() => r()));
    for (const s of sockets) s.destroy();
    await closed;
  }
});
