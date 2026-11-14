// Runs the pinned Cactus Whistle engine entirely in this page's worker.
declare const createCactus: (options: Record<string, unknown>) => Promise<any>;

let engine: any = null;
const scope = self as any;

async function verified(url: string, expected: string, id: number, label: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (${response.status})`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (!response.body) throw new Error("Speech download unavailable");
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    scope.postMessage({ id, progress: `Downloading ${label}… ${total ? `${Math.min(100, Math.round(received / total * 100))}%` : `${(received / 1048576).toFixed(1)} MB`}` });
  }
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
  try {
    if (action === "init") {
      const { base, modelUrl, modelSha256 } = event.data;
      const js = `${base}_tendril/speech/cactus.js`;
      const wasmUrl = `${base}_tendril/speech/cactus.wasm`;
      const [wasm, model] = await Promise.all([
        verified(wasmUrl, "4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6", id, "speech engine"),
        verified(modelUrl, modelSha256, id, "speech model"),
      ]);
      scope.importScripts(js);
      scope.postMessage({ id, progress: "Preparing on-device speech…" });
      engine = await createCactus({ wasmBinary: wasm.buffer });
      const ptr = engine._malloc(model.byteLength);
      if (!ptr) throw new Error("Could not allocate speech model memory");
      try {
        engine.HEAPU8.set(model, ptr);
        // The pinned WASM export takes (i32 pointer, i64 length). WebAssembly i64
        // arguments require a JS bigint; passing a number throws before loading.
        const code = engine._cactus_load(ptr, BigInt(model.byteLength));
        if (code < 0) throw new Error(engine.UTF8ToString(engine._cactus_last_error()));
      } finally { engine._free(ptr); }
      scope.postMessage({ id, ready: true });
      return;
    }
    if (action === "transcribe") {
      if (!engine) throw new Error("Speech model is not loaded");
      const samples = new Float32Array(event.data.samples);
      const pcmPtr = engine._malloc(samples.byteLength);
      const outPtr = engine._malloc(65536);
      if (!pcmPtr || !outPtr) throw new Error("Could not allocate transcription memory");
      try {
        engine.HEAPU8.set(new Uint8Array(samples.buffer), pcmPtr);
        const language = /^[a-z]{2}$/.test(event.data.language ?? "") ? event.data.language : null;
        const code = engine.ccall("cactus_transcribe", "number",
          ["number", "number", "string", "string", "number", "number", "number"],
          [pcmPtr, samples.length, language, null, 0, outPtr, 65536]);
        if (code < 0) throw new Error(engine.UTF8ToString(engine._cactus_last_error()));
        const result = JSON.parse(engine.UTF8ToString(outPtr));
        scope.postMessage({ id, text: String(result.text ?? "") });
      } finally { engine._free(pcmPtr); engine._free(outPtr); }
      return;
    }
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
