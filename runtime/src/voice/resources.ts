import type { RuntimeApi, RuntimeArtifactFeatures } from "../../../contract/index.mjs";
import { RUNTIME_FEATURES, RUNTIME_RESOURCES } from "../../resources.mjs";

/** Disclosures and verification use the same immutable registry as publication. */
export const SPEECH_DOWNLOAD_BYTES = RUNTIME_RESOURCES.reduce((sum, resource) => sum + resource.size, 0);
export const SPEECH_MODEL_BYTES = RUNTIME_FEATURES.speech.size!;
export const SPEECH_LANGUAGES = Object.freeze([...RUNTIME_FEATURES.speech.languages!]);

export async function loadSpeechResources(runtime: RuntimeApi, signal?: AbortSignal): Promise<NonNullable<RuntimeArtifactFeatures["speech"]>> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  try {
    const response = await fetch(runtime.assetUrl("resources.json"), { credentials: "same-origin", redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error("Speech resource metadata is unavailable. Try again or type instead.");
    const metadata = await response.json() as { features?: RuntimeArtifactFeatures };
    if (controller.signal.aborted) throw new DOMException("Speech preparation cancelled or timed out", "AbortError");
    const speech = metadata.features?.speech;
    const pinned = RUNTIME_FEATURES.speech;
    // Never let a remotely supplied resource list change the consented engine,
    // model size, or executable bytes. The worker verifies all three actual files.
    if (!speech || speech.model !== pinned.model || speech.url !== pinned.url || speech.sha256 !== pinned.sha256
      || speech.engine?.script !== pinned.engine.script || speech.engine.script_sha256 !== pinned.engine.script_sha256
      || speech.engine.wasm !== pinned.engine.wasm || speech.engine.wasm_sha256 !== pinned.engine.wasm_sha256
      || speech.size !== pinned.size || speech.engine.script_size !== pinned.engine.script_size
      || speech.engine.wasm_size !== pinned.engine.wasm_size || speech.total_size !== SPEECH_DOWNLOAD_BYTES) {
      throw new Error("Speech resources do not match this runtime's verified model. Reload the page or type instead.");
    }
    const base = new URL(runtime.identity.base, location.href);
    const absolute = (path: string) => new URL(path, base).href;
    return { ...pinned, url: absolute(pinned.url), engine: { ...pinned.engine,
      script: absolute(pinned.engine.script), wasm: absolute(pinned.engine.wasm) } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
