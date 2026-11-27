// Runs the pinned Cactus Whistle engine entirely in this page's worker.
// Supports both native streaming (_cactus_stream_transcribe_process / _cactus_stream_transcribe_stop)
// and bounded batch/wake detection, backed by an origin-scoped Cache Storage model cache.
import { RUNTIME_FEATURES } from "../../resources.mjs";
import { matchWakePhrase } from "./wakeword";

declare const createCactus: (options: Record<string, unknown>) => Promise<any>;

const MODEL_CACHE_NAME = "tendril-models-v1";
const LANGUAGES = new Set<string>(RUNTIME_FEATURES.speech.languages);

let engine: any = null;
let busy = false;
const scope = self as any;

interface ActiveStream {
  sessionId: string;
  language: string;
  confirmed: string;
  pending: string;
  native: boolean;
  fallbackChunks: Float32Array[];
  totalSamples: number;
}
let activeStream: ActiveStream | null = null;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function modelCacheKey(expectedSha256: string): string {
  try {
    return new URL(`/_tendril/model-cache/${expectedSha256}`, scope.location?.href || "https://tendril.local/").href;
  } catch {
    return `https://tendril.local/_tendril/model-cache/${expectedSha256}`;
  }
}

async function openModelCache(): Promise<Cache | null> {
  try {
    if (typeof scope.caches?.open !== "function") return null;
    return await scope.caches.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

async function readCachedAsset(expected: string, declared: number | null, id: number, label: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const cache = await openModelCache();
  if (!cache) return null;
  const key = modelCacheKey(expected);
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    scope.postMessage({ id, progress: `Loading cached ${label}…` });
    const buf = await hit.arrayBuffer();
    if (declared !== null && buf.byteLength !== declared) {
      await cache.delete(key).catch(() => {});
      return null;
    }
    const bytes = new Uint8Array(buf);
    if (await sha256Hex(bytes) !== expected) {
      await cache.delete(key).catch(() => {});
      return null;
    }
    return bytes;
  } catch {
    await cache.delete(key).catch(() => {});
    return null;
  }
}

async function writeCachedAsset(expected: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const cache = await openModelCache();
  if (!cache) return;
  try {
    const response = new Response(bytes.slice().buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Tendril-Sha256": expected,
      },
    });
    await cache.put(modelCacheKey(expected), response);
  } catch {
    // Non-fatal in private browsing or tight storage quota.
  }
}

async function verified(url: string, expected: string, size: unknown, maximum: number, id: number, label: string): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Speech asset requires a pinned SHA-256 digest");
  if (typeof url !== "string" || !/^https?:/.test(new URL(url, scope.location?.href).href)) throw new Error("Invalid speech asset URL");
  const declared = size === undefined ? null : size;
  if (declared !== null && (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared <= 0 || declared > maximum)) throw new Error("Invalid speech asset size");

  const cached = await readCachedAsset(expected, declared, id, label);
  if (cached) return cached;

  const response = await fetch(url, { credentials: "same-origin", redirect: "error" });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.clone().json() as { error?: { message?: string } };
      if (typeof body?.error?.message === "string" && body.error.message.trim()) detail = `: ${body.error.message.trim()}`;
    } catch { /* non-JSON error body */ }
    throw new Error(`Speech ${label} download failed (${response.status}${detail})`);
  }
  const total = Number(response.headers.get("Content-Length")) || declared || 0;
  if (total > maximum) throw new Error("Speech asset exceeds its download limit");
  if (!response.body) throw new Error("Speech download unavailable");
  const reader = response.body.getReader();
  const limit = declared ?? maximum;
  // Single pre-allocated buffer when size is pinned avoids double-buffering 17 MB weights in RAM.
  let bytes: Uint8Array<ArrayBuffer> | null = declared !== null ? new Uint8Array(declared) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.length > limit) throw new Error("Speech asset exceeds its declared size");
      if (bytes) {
        bytes.set(value, received);
      } else {
        chunks.push(value);
      }
      received += value.length;
      scope.postMessage({ id, progress: `Downloading ${label}… ${total ? `${Math.min(100, Math.round(received / total * 100))}%` : `${(received / 1048576).toFixed(1)} MB`}` });
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (declared !== null && received !== declared) throw new Error("Speech asset size mismatch");
  if (!bytes) {
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  scope.postMessage({ id, progress: `Verifying ${label}…` });
  if (await sha256Hex(bytes) !== expected) throw new Error("Speech asset hash mismatch");
  await writeCachedAsset(expected, bytes);
  return bytes;
}

function validateSamples(buffer: unknown, maxSeconds: number): Float32Array {
  const maximum = 16_000 * maxSeconds;
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 4 || buffer.byteLength > maximum * 4) {
    throw new Error("Speech audio exceeds its bounded window");
  }
  const samples = new Float32Array(buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error("Invalid microphone samples");
  }
  return samples;
}

function runBatchTranscribe(samples: Float32Array, language: string): string {
  let pcmPtr = 0, outPtr = 0;
  try {
    pcmPtr = engine._malloc(samples.byteLength);
    outPtr = engine._malloc(65536);
    if (!pcmPtr || !outPtr) throw new Error("Could not allocate transcription memory");
    engine.HEAPU8.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), pcmPtr);
    const code = engine.ccall(
      "cactus_transcribe",
      "number",
      ["number", "number", "string", "string", "number", "number", "number"],
      [pcmPtr, samples.length, language, null, 0, outPtr, 65536],
    );
    if (code < 0) throw new Error("On-device speech recognition failed");
    return String(JSON.parse(engine.UTF8ToString(outPtr)).text ?? "").trim().slice(0, 8192);
  } finally {
    if (pcmPtr) { engine.HEAPU8.fill(0, pcmPtr, pcmPtr + samples.byteLength); engine._free(pcmPtr); }
    if (outPtr) { engine.HEAPU8.fill(0, outPtr, outPtr + 65536); engine._free(outPtr); }
    samples.fill(0);
  }
}

function hasNativeStreaming(): boolean {
  return !!engine
    && typeof engine._cactus_stream_transcribe_process === "function"
    && typeof engine._cactus_stream_transcribe_stop === "function";
}

function stopNativeStreamSafe(): string {
  if (!hasNativeStreaming()) return "";
  let outPtr = 0;
  try {
    outPtr = engine._malloc(65536);
    if (!outPtr) return "";
    const code = engine.ccall("cactus_stream_transcribe_stop", "number", ["number", "number"], [outPtr, 65536]);
    if (code < 0) return "";
    const parsed = JSON.parse(engine.UTF8ToString(outPtr));
    return String(parsed?.text ?? "").trim();
  } catch {
    return "";
  } finally {
    if (outPtr) { engine.HEAPU8.fill(0, outPtr, outPtr + 65536); engine._free(outPtr); }
  }
}

function joinTokens(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`.slice(0, 8192);
}

scope.onmessage = async (event: MessageEvent) => {
  const { id, action } = event.data ?? {};
  if (!Number.isSafeInteger(id)) return;
  if (busy) { scope.postMessage({ id, error: "Speech worker is busy" }); return; }
  busy = true;
  try {
    if (action === "init") {
      if (engine) throw new Error("Speech model is already loaded");
      const { engine: assets, modelUrl, modelSha256, modelSize } = event.data;
      if (!assets) throw new Error("Speech engine metadata is missing");
      const [script, wasm, model] = await Promise.all([
        verified(assets.script, assets.script_sha256, assets.script_size, 262_144, id, "speech code"),
        verified(assets.wasm, assets.wasm_sha256, assets.wasm_size, 4_194_304, id, "speech engine"),
        verified(modelUrl, modelSha256, modelSize, 33_554_432, id, "speech model"),
      ]);
      // Execute exactly the verified script bytes, with no second network request.
      const scriptUrl = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
      try { scope.importScripts(scriptUrl); }
      finally { URL.revokeObjectURL(scriptUrl); script.fill(0); }
      scope.postMessage({ id, progress: "Preparing on-device speech…" });
      const loaded = await createCactus({ wasmBinary: wasm.buffer });
      const ptr = loaded._malloc(model.byteLength);
      if (!ptr) throw new Error("Could not allocate speech model memory");
      try {
        loaded.HEAPU8.set(model, ptr);
        const code = loaded._cactus_load(ptr, BigInt(model.byteLength));
        if (code < 0) throw new Error("Could not load the verified speech model");
        engine = loaded;
      } finally { loaded._free(ptr); model.fill(0); }
      scope.postMessage(hasNativeStreaming() ? { id, ready: true, streaming: true } : { id, ready: true });
      return;
    }

    if (action === "stream-start") {
      if (!engine) throw new Error("Speech model is not loaded");
      const language = event.data.language;
      if (!LANGUAGES.has(language)) throw new Error("Unsupported speech language");
      if (activeStream?.native) stopNativeStreamSafe();
      const sessionId = typeof event.data.sessionId === "string" && event.data.sessionId ? event.data.sessionId : String(id);
      activeStream = {
        sessionId,
        language,
        confirmed: "",
        pending: "",
        native: hasNativeStreaming(),
        fallbackChunks: [],
        totalSamples: 0,
      };
      scope.postMessage({ id, sessionId, streaming: true, native: activeStream.native });
      return;
    }

    if (action === "stream-chunk") {
      if (!engine) throw new Error("Speech model is not loaded");
      if (!activeStream || (event.data.sessionId && event.data.sessionId !== activeStream.sessionId)) {
        throw new Error("No active speech stream");
      }
      const samples = validateSamples(event.data.samples, 30);
      if (activeStream.native) {
        let pcmPtr = 0, outPtr = 0;
        try {
          pcmPtr = engine._malloc(samples.byteLength);
          outPtr = engine._malloc(65536);
          if (!pcmPtr || !outPtr) throw new Error("Could not allocate transcription memory");
          engine.HEAPU8.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), pcmPtr);
          const code = engine.ccall(
            "cactus_stream_transcribe_process",
            "number",
            ["number", "number", "string", "string", "number", "number"],
            [pcmPtr, samples.length, activeStream.language, null, outPtr, 65536],
          );
          if (code < 0) throw new Error("On-device streaming speech recognition failed");
          const parsed = JSON.parse(engine.UTF8ToString(outPtr));
          const delta = String(parsed?.text ?? "").trim();
          const pending = String(parsed?.pending ?? "").trim();
          if (delta) activeStream.confirmed = joinTokens(activeStream.confirmed, delta);
          activeStream.pending = pending;
          const text = joinTokens(activeStream.confirmed, activeStream.pending);
          scope.postMessage({
            id,
            sessionId: activeStream.sessionId,
            confirmed: activeStream.confirmed,
            pending: activeStream.pending,
            text,
          });
        } finally {
          if (pcmPtr) { engine.HEAPU8.fill(0, pcmPtr, pcmPtr + samples.byteLength); engine._free(pcmPtr); }
          if (outPtr) { engine.HEAPU8.fill(0, outPtr, outPtr + 65536); engine._free(outPtr); }
          samples.fill(0);
        }
      } else {
        const cap = 16_000 * 30;
        const remaining = cap - activeStream.totalSamples;
        if (remaining > 0) {
          const take = samples.length <= remaining ? samples.slice() : samples.slice(0, remaining);
          activeStream.fallbackChunks.push(take);
          activeStream.totalSamples += take.length;
        }
        samples.fill(0);
        scope.postMessage({
          id,
          sessionId: activeStream.sessionId,
          confirmed: activeStream.confirmed,
          pending: activeStream.pending,
          text: joinTokens(activeStream.confirmed, activeStream.pending),
        });
      }
      return;
    }

    if (action === "stream-stop") {
      if (!engine) throw new Error("Speech model is not loaded");
      const current = activeStream;
      if (!current || (event.data.sessionId && event.data.sessionId !== current.sessionId)) {
        scope.postMessage({ id, text: "" });
        return;
      }
      activeStream = null;
      let finalText = "";
      if (current.native) {
        const flushed = stopNativeStreamSafe();
        finalText = joinTokens(current.confirmed, flushed || current.pending);
      } else if (current.totalSamples > 0) {
        const merged = new Float32Array(current.totalSamples);
        let offset = 0;
        for (const chunk of current.fallbackChunks) { merged.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
        finalText = runBatchTranscribe(merged, current.language);
      }
      scope.postMessage({ id, sessionId: current.sessionId, text: finalText });
      return;
    }

    if (action === "stream-cancel") {
      const current = activeStream;
      if (current && (!event.data.sessionId || event.data.sessionId === current.sessionId)) {
        activeStream = null;
        if (current.native) stopNativeStreamSafe();
        for (const chunk of current.fallbackChunks) chunk.fill(0);
      }
      scope.postMessage({ id, cancelled: true });
      return;
    }

    if (action !== "transcribe" && action !== "detect" && action !== "transcribe-segment") throw new Error("Unknown speech action");
    if (!engine) throw new Error("Speech model is not loaded");
    const maxSeconds = action === "detect" ? 8 : action === "transcribe-segment" ? 12 : 30;
    const samples = validateSamples(event.data.samples, maxSeconds);
    const language = event.data.language;
    if (!LANGUAGES.has(language)) throw new Error("Unsupported speech language");
    if (action === "detect" && (typeof event.data.phrase !== "string" || event.data.phrase.length > 120 || !/[\p{L}\p{N}]/u.test(event.data.phrase))) {
      samples.fill(0);
      throw new Error("Invalid wake phrase");
    }
    const text = runBatchTranscribe(samples, language);
    if (action === "detect") {
      const match = matchWakePhrase(text, event.data.phrase);
      // Ambient transcripts are discarded here and never sent to page callbacks.
      scope.postMessage({ id, matched: !!match, command: match?.command ?? "" });
    } else {
      scope.postMessage({ id, text });
    }
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  } finally { busy = false; }
};
