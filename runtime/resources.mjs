// Optional runtime resources are immutable, explicitly declared dependencies.
// Installers and tests consume this registry; serving does not depend on which
// release happens to be deployed today.
const engine = '1a028f5a3972b67dd8d8752f882113d475e7ec4c';
const model = 'ad73f1468dd5203791e0cc81d31544c553563645';
const script = {
  name: 'cactus.js', type: 'text/javascript',
  sha256: 'bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc',
  source: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.js`,
};
const wasm = {
  name: 'cactus.wasm', type: 'application/wasm',
  sha256: '4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6',
  source: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.wasm`,
};
const weights = {
  name: 'whistle.cact', type: 'application/octet-stream',
  sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
  source: `https://huggingface.co/Cactus-Compute/whistle/resolve/${model}/whistle.cact`,
};
const address = file => `_tendril/assets/${file.sha256}/${file.name}`;
export const RUNTIME_RESOURCES = Object.freeze([script, wasm, weights].map(file => Object.freeze({ ...file, url: address(file) })));
export const RUNTIME_FEATURES = Object.freeze({ speech: {
  model: 'cactus-whistle-v4', url: address(weights), sha256: weights.sha256,
  engine: { script: address(script), wasm: address(wasm), wasm_sha256: wasm.sha256 },
} });
