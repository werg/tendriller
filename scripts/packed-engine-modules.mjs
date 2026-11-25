// The packed engine is one bundled ES module plus the WebAssembly modules it
// imports (listed by the build in wasm-assets.json). Load exactly those files;
// source-tree loader rules never apply to the immutable package.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function packedEngineModules(directory) {
  const wasm = JSON.parse(await readFile(join(directory, 'wasm-assets.json'), 'utf8'));
  if (!Array.isArray(wasm) || !wasm.every(name => typeof name === 'string' && /^[A-Za-z0-9._-]+\.wasm$/u.test(name)))
    throw Error('The packed engine must list its WebAssembly modules by plain file name.');
  return { modulesRoot: directory, modules: [{ type: 'ESModule', path: join(directory, 'worker.mjs') },
    ...wasm.map(name => ({ type: 'CompiledWasm', path: join(directory, name) }))] };
}
