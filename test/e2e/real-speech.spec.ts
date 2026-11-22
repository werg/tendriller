import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test, expect } from "@playwright/test";
import { wordErrorRate } from "./speech-fixture.mjs";

test("pinned Cactus WASM and Whistle model recognize silence and a known spoken sentence", async ({ page }, info) => {
  test.skip(process.env.E2E_REAL_SPEECH !== "1", "Use npm run test:e2e:speech-real; CI also runs the cached model workflow");
  test.setTimeout(180_000);
  const cache = execFileSync(process.execPath, ["scripts/e2e-speech-assets.mjs"], { encoding: "utf8", timeout: 150_000 }).trim();
  const fixture = JSON.parse(await readFile("test/fixtures/speech/manifest.json", "utf8"));
  const spoken = await readFile(join("test/fixtures/speech", fixture.file));
  const wakeFixtures = JSON.parse(await readFile("test/fixtures/speech/wake-manifest.json", "utf8"));
  expect(createHash("sha256").update(spoken).digest("hex")).toBe(fixture.sha256);
  const worker = await readFile("dist/runtime/assets/voice-worker.js");
  const runtime = JSON.parse(await readFile("dist/runtime/assets/manifest.json", "utf8"));
  const js = await readFile(join(cache, "cactus.js")), wasm = await readFile(join(cache, "cactus.wasm")), model = await readFile(join(cache, "whistle.cact"));
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const resource = (bytes: Uint8Array, name: string) => `/_tendril/assets/${hash(bytes)}/${name}`;
  const config = { worker: `/_tendril/runtime/${runtime.id}/voice-worker.js`,
    engine: { script: resource(js, "cactus.js"), script_sha256: hash(js), script_size: js.length, wasm: resource(wasm, "cactus.wasm"), wasm_sha256: hash(wasm), wasm_size: wasm.length },
    modelUrl: resource(model, "whistle.cact"), modelSha256: hash(model), modelSize: model.length,
    wakePhrase: wakeFixtures.phrase, wakeCases: wakeFixtures.cases as Array<{ file: string; sha256: string; matched: boolean; command: string }> };
  const assets = new Map([
    [config.engine.script, { bytes: js, type: "text/javascript" }],
    [config.engine.wasm, { bytes: wasm, type: "application/wasm" }],
    [config.modelUrl, { bytes: model, type: "application/octet-stream" }],
    [config.worker, { bytes: worker, type: "text/javascript" }],
    ["/known-speech.wav", { bytes: spoken, type: "audio/wav" }],
  ]);
  for (const entry of config.wakeCases) {
    const bytes = await readFile(join("test/fixtures/speech", entry.file));
    expect(hash(bytes)).toBe(entry.sha256);
    assets.set(`/${entry.file}`, { bytes, type: "audio/wav" });
  }
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    const asset = assets.get(req.url ?? "");
    if (asset) { res.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.bytes.length }); res.end(asset.bytes); }
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><html lang=en><title>Speech E2E</title><main>Pinned model fixture</main></html>"); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const messages = await page.evaluate(async config => {
      const worker = new Worker(config.worker);
      const terminal = (id: number) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("speech worker timed out")), 75_000);
        worker.onmessage = event => { if (event.data.id === id && (event.data.ready || event.data.text !== undefined || event.data.matched !== undefined || event.data.error)) { clearTimeout(timer); resolve(event.data); } };
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      });
      const started = performance.now();
      try {
        const init = terminal(1);
        worker.postMessage({ id: 1, action: "init", engine: config.engine, modelUrl: config.modelUrl, modelSha256: config.modelSha256, modelSize: config.modelSize });
        const ready = await init, initialized_ms = performance.now() - started;
        if (ready.error) return { ready, initialized_ms };
        const silence = terminal(2), zeroes = new Float32Array(16000);
        worker.postMessage({ id: 2, action: "transcribe", samples: zeroes.buffer, language: "en" }, [zeroes.buffer]);
        const silenceResult = await silence;
        const audio = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await (await fetch("/known-speech.wav")).arrayBuffer());
        const samples = new Float32Array(audio.getChannelData(0));
        const transcribe = terminal(3), speakingStarted = performance.now();
        worker.postMessage({ id: 3, action: "transcribe", samples: samples.buffer, language: "en" }, [samples.buffer]);
        const spokenResult = await transcribe, transcribed_ms = performance.now() - speakingStarted;
        const detect = async (id: number, phrase: string, pcm: Float32Array) => {
          const pending = terminal(id), started = performance.now();
          worker.postMessage({ id, action: "detect", samples: pcm.buffer, language: "en", phrase }, [pcm.buffer]);
          return { response: await pending, milliseconds: performance.now() - started };
        };
        const positive = await detect(4, "Please check", new Float32Array(audio.getChannelData(0)));
        const negative = await detect(5, "Hey Tendril", new Float32Array(audio.getChannelData(0)));
        const silentWake = await detect(6, "Please check", new Float32Array(16000));
        const defaultWake = [];
        for (const [index, entry] of config.wakeCases.entries()) {
          const audio = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await (await fetch('/' + entry.file)).arrayBuffer());
          defaultWake.push({ ...entry, ...await detect(7 + index, config.wakePhrase, new Float32Array(audio.getChannelData(0))) });
        }
        return { ready, silence: silenceResult, spoken: spokenResult, initialized_ms, transcribed_ms, audio_seconds: audio.duration, positive, negative, silentWake, defaultWake };
      } finally { worker.terminate(); }
    }, config);
    const errorRate = wordErrorRate(fixture.transcript, messages.spoken?.text || "");
    const evidencePath = info.outputPath("speech-results.json");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ ...messages, expected: fixture.transcript, word_error_rate: errorRate, fixture_sha256: fixture.sha256, runtime_id: runtime.id, worker_sha256: hash(worker), script_sha256: hash(js), wasm_sha256: hash(wasm), model_sha256: hash(model), evidence: "Synthetic recorded WAV replay in real Chromium; no physical microphone/device accuracy qualification." }, null, 2) + "\n");
    await info.attach("speech-results", { path: evidencePath, contentType: "application/json" });
    expect(messages.ready).toMatchObject({ ready: true });
    expect(messages.silence).toMatchObject({ text: "" });
    expect(messages.spoken?.error).toBeUndefined();
    expect(messages.spoken?.text?.trim()).toBeTruthy();
    expect(errorRate, `Expected '${fixture.transcript}', received '${messages.spoken?.text}'`).toBeLessThanOrEqual(fixture.max_word_error_rate);
    expect(messages.positive?.response).toMatchObject({ matched: true });
    expect(messages.positive?.response.command).toMatch(/sensor.*temperature/i);
    expect(messages.positive?.response).not.toHaveProperty("text");
    expect(messages.negative?.response).toEqual({ id: 5, matched: false, command: "" });
    expect(messages.silentWake?.response).toEqual({ id: 6, matched: false, command: "" });
    const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
    expect(messages.defaultWake).toHaveLength(3);
    for (const entry of messages.defaultWake ?? []) {
      expect(entry.response.matched, entry.file).toBe(entry.matched);
      expect(words(entry.response.command), entry.file).toBe(words(entry.command));
      expect(entry.response).not.toHaveProperty("text");
    }
  } finally {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  }
});
