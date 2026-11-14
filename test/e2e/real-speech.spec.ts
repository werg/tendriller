import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

test("pinned Cactus WASM and Whistle model initialize and transcribe silence in Chromium", async ({ page }) => {
  test.skip(process.env.E2E_REAL_SPEECH !== "1", "Run with E2E_REAL_SPEECH=1; the default suite has a deterministic WASM signature test");
  test.setTimeout(120_000);
  const cache = execFileSync(process.execPath, ["scripts/e2e-speech-assets.mjs"], { encoding: "utf8", timeout: 90_000 });
  const worker = await readFile("server/public/_tendril/speech-worker.js");
  const assets = new Map([
    ["/_tendril/speech/cactus.js", { bytes: await readFile(join(cache, "cactus.js")), type: "text/javascript" }],
    ["/_tendril/speech/cactus.wasm", { bytes: await readFile(join(cache, "cactus.wasm")), type: "application/wasm" }],
    ["/_tendril/speech/whistle.cact", { bytes: await readFile(join(cache, "whistle.cact")), type: "application/octet-stream" }],
    ["/_tendril/speech-worker.js", { bytes: worker, type: "text/javascript" }],
  ]);
  const server = createServer((req, res) => {
    const asset = assets.get(req.url ?? "");
    if (asset) { res.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.bytes.length }); res.end(asset.bytes); }
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Speech E2E</title>"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const messages = await page.evaluate(async () => {
      const worker = new Worker("/_tendril/speech-worker.js");
      const terminal = (id: number) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("speech worker timed out")), 75_000);
        worker.onmessage = event => { if (event.data.id === id && (event.data.ready || event.data.text !== undefined || event.data.error)) { clearTimeout(timer); resolve(event.data); } };
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      });
      const init = terminal(1);
      worker.postMessage({ id: 1, action: "init", base: "/", modelUrl: `${location.origin}/_tendril/speech/whistle.cact`, modelSha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb" });
      const ready = await init;
      if (ready.error) return { ready };
      const transcribe = terminal(2);
      const samples = new Float32Array(16000);
      worker.postMessage({ id: 2, action: "transcribe", samples: samples.buffer, language: "en" }, [samples.buffer]);
      const result = await transcribe;
      worker.terminate();
      return { ready, result };
    });
    expect(messages.ready).toMatchObject({ ready: true });
    expect(messages.result).toMatchObject({ text: "" });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
