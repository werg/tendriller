// Runs the pinned Cactus Whistle engine entirely in this page's worker.
import { matchWakePhrase } from "./wakeword";
declare const createCactus: (options: Record<string, unknown>) => Promise<any>;

let engine: any = null;
let busy = false;
const scope = self as any;
const LANGUAGES = new Set(["en", "de", "fr", "es", "it", "nl", "pl"]);

async function verified(url: string, expected: string, size: unknown, maximum: number, id: number, label: string): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Speech asset requires a pinned SHA-256 digest");
  if (typeof url !== "string" || !/^https?:/.test(new URL(url, scope.location?.href).href)) throw new Error("Invalid speech asset URL");
  const declared = size === undefined ? null : size;
  if (declared !== null && (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared <= 0 || declared > maximum)) throw new Error("Invalid speech asset size");
  const response = await fetch(url, { credentials: "same-origin", redirect: "error" });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.clone().json() as { error?: { message?: string } };
      if (typeof body?.error?.message === "string" && body.error.message.trim()) detail = `: ${body.error.message.trim()}`;
    } catch { /* non-JSON error body */ }
    throw new Error(`Speech ${label} download failed (${response.status}${detail})`);
  }
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (total > maximum) throw new Error("Speech asset exceeds its download limit");
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (!response.body) throw new Error("Speech download unavailable");
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > (declared ?? maximum)) throw new Error("Speech asset exceeds its declared size");
      chunks.push(value);
      scope.postMessage({ id, progress: `Downloading ${label}… ${total ? `${Math.min(100, Math.round(received / total * 100))}%` : `${(received / 1048576).toFixed(1)} MB`}` });
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (declared !== null && received !== declared) throw new Error("Speech asset size mismatch");
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  scope.postMessage({ id, progress: `Verifying ${label}…` });
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  if (hash !== expected) throw new Error("Speech asset hash mismatch");
  return bytes;
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
      scope.postMessage({ id, ready: true });
      return;
    }
    if (action !== "transcribe" && action !== "detect" && action !== "transcribe-segment") throw new Error("Unknown speech action");
    if (!engine) throw new Error("Speech model is not loaded");
    const buffer = event.data.samples;
    const maximum = 16_000 * (action === "detect" ? 8 : action === "transcribe-segment" ? 12 : 30);
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 4 || buffer.byteLength > maximum * 4) throw new Error("Speech audio exceeds its bounded window");
    const samples = new Float32Array(buffer);
    const language = event.data.language;
    if (!LANGUAGES.has(language)) throw new Error("Unsupported speech language");
    if (action === "detect" && (typeof event.data.phrase !== "string" || event.data.phrase.length > 120 || !/[\p{L}\p{N}]/u.test(event.data.phrase))) throw new Error("Invalid wake phrase");
    for (const sample of samples) if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error("Invalid microphone samples");
    let pcmPtr = 0, outPtr = 0;
    try {
      pcmPtr = engine._malloc(samples.byteLength); outPtr = engine._malloc(65536);
      if (!pcmPtr || !outPtr) throw new Error("Could not allocate transcription memory");
      engine.HEAPU8.set(new Uint8Array(buffer), pcmPtr);
      const code = engine.ccall("cactus_transcribe", "number",
        ["number", "number", "string", "string", "number", "number", "number"],
        [pcmPtr, samples.length, language, null, 0, outPtr, 65536]);
      if (code < 0) throw new Error("On-device speech recognition failed");
      const text = String(JSON.parse(engine.UTF8ToString(outPtr)).text ?? "").trim().slice(0, 8192);
      if (action === "detect") {
        const match = matchWakePhrase(text, event.data.phrase);
        // Ambient transcripts are discarded here and never sent to page callbacks.
        scope.postMessage({ id, matched: !!match, command: match?.command ?? "" });
      } else scope.postMessage({ id, text });
    } finally {
      if (pcmPtr) { engine.HEAPU8.fill(0, pcmPtr, pcmPtr + samples.byteLength); engine._free(pcmPtr); }
      if (outPtr) { engine.HEAPU8.fill(0, outPtr, outPtr + 65536); engine._free(outPtr); }
      samples.fill(0);
    }
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  } finally { busy = false; }
};
