// Optional runtime resources are immutable, explicitly declared dependencies.
// Installers and tests consume this registry; serving does not depend on which
// release happens to be deployed today.
const engine = '1a028f5a3972b67dd8d8752f882113d475e7ec4c';
const model = 'ad73f1468dd5203791e0cc81d31544c553563645';
// Size and single-PUT R2 ETags are computed from the SHA-256-verified source bytes.
const script = {
  name: 'cactus.js', type: 'text/javascript',
  size: 63150, etag: '548737685a0ba6a00c90a6d43142e811',
  sha256: 'bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc',
  source: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.js`,
};
const wasm = {
  name: 'cactus.wasm', type: 'application/wasm',
  size: 1241703, etag: 'aa662cc203cb8cea213655de1907da1a',
  sha256: '4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6',
  source: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.wasm`,
};
const weights = {
  name: 'whistle.cact', type: 'application/octet-stream',
  size: 16919407, etag: '6abaa7e6e7eafd6f0d0d0cae3a28db62',
  sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
  source: `https://huggingface.co/Cactus-Compute/whistle/resolve/${model}/whistle.cact`,
};
const address = file => `_tendril/assets/${file.sha256}/${file.name}`;
export const RUNTIME_RESOURCES = Object.freeze([script, wasm, weights].map(file => Object.freeze({ ...file, url: address(file) })));
export const RUNTIME_FEATURES = Object.freeze({ speech: {
  model: 'cactus-whistle-v4', url: address(weights), sha256: weights.sha256, size: weights.size,
  total_size: script.size + wasm.size + weights.size,
  languages: ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'],
  engine: { script: address(script), script_sha256: script.sha256, script_size: script.size,
    wasm: address(wasm), wasm_sha256: wasm.sha256, wasm_size: wasm.size },
} });
