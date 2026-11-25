/**
 * Ephemeral in-memory DoltLite WASM materialization engine for Cloudflare Workers / DO.
 *
 * Uses static `.wasm` module import (`instantiateWasm`) and Emscripten's built-in MEMFS,
 * so SQL apps materialize strictly in RAM during an authenticated /mcp request, unlink
 * temporary MEMFS files on close, and optionally hydrate/export encrypted checkpoints.
 */
import doltliteWasm from './vendor/doltlite/wasm/sqlite3.wasm';
import trampolinesWasm from './vendor/doltlite/wasm/trampolines.wasm';
import doltliteManifest from './vendor/doltlite/wasm/manifest.json';
import sqlite3InitModule from './vendor/doltlite/wasm/sqlite3.mjs';
import { createBrowserSqlEngine, createDoltLiteExecutionManifest, digestEngineManifest } from './vendor/doltlite/sql-browser.mjs';
import { createSqlMaterializationRuntime } from './vendor/doltlite/sql.mjs';
import { hexToBytes } from './mcp-crypto';

interface EmscriptenFs {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
}

let cachedModule: Promise<{ module: any; fs: EmscriptenFs | null }> | null = null;
let cachedDigest: Promise<string> | null = null;

async function getDoltLiteModule(): Promise<{ module: any; fs: EmscriptenFs | null }> {
  if (!cachedModule) {
    cachedModule = Promise.resolve().then(async () => {
      const init = typeof sqlite3InitModule === 'function'
        ? sqlite3InitModule
        : (sqlite3InitModule as { default?: unknown }).default;
      if (typeof init !== 'function') throw new Error('DoltLite WASM initializer unavailable');
      let capturedFs: EmscriptenFs | null = null;
      const module = await (init as (opts: Record<string, unknown>) => Promise<any>)({
        print: () => {},
        printErr: () => {},
        __trampolinesWasm: trampolinesWasm,
        __onFs(fs: EmscriptenFs) { capturedFs = fs; },
        instantiateWasm(imports: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance, mod: WebAssembly.Module) => void) {
          WebAssembly.instantiate(doltliteWasm, imports)
            .then(result => {
              const instance = 'instance' in result ? result.instance : result;
              receiveInstance(instance as WebAssembly.Instance, doltliteWasm);
            })
            .catch(err => {
              console.error('DoltLite WASM instantiation failed:', err);
              throw err;
            });
          return {};
        },
      });
      return { module, fs: capturedFs };
    }).catch(err => {
      cachedModule = null;
      throw err;
    });
  }
  return cachedModule;
}

function cleanupMemfs(fs: EmscriptenFs | null, path: string): void {
  if (!fs) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlink(path + suffix); } catch { /* absent */ }
  }
}

/** Compute the verified DoltLite execution manifest digest for this bundled WASM build. */
export async function doltliteExecutionManifestDigest(): Promise<string> {
  if (!cachedDigest) {
    cachedDigest = Promise.resolve().then(async () => {
      const manifest = doltliteManifest as { nativeManifest: unknown };
      const execution = createDoltLiteExecutionManifest({ engineDigest: digestEngineManifest(manifest.nativeManifest) });
      const { executionManifestArtifacts, bytesToHex } = await import('@chronolog/peer-session');
      const artifacts = await executionManifestArtifacts(execution);
      return bytesToHex(artifacts.executionManifestDigest);
    });
  }
  return cachedDigest;
}

/**
 * Create a fresh, isolated, ephemeral in-memory DoltLite materialization runtime.
 * Every call uses a unique MEMFS path, optionally seeded from a decrypted checkpoint,
 * exports the resulting SQLite snapshot bytes on close (before unlinking MEMFS), and
 * leaves zero plaintext SQLite behind.
 */
export async function createEphemeralSqlMaterializer(
  rootPrincipal: string | Uint8Array,
  options: {
    initialBytes?: Uint8Array | null;
    onCloseBytes?: (bytes: Uint8Array) => Promise<void> | void;
  } = {},
) {
  const { module, fs } = await getDoltLiteModule();
  const engine = createBrowserSqlEngine({
    module,
    manifest: doltliteManifest as any,
    vfs: '',
  });
  const path = `/mcp-${crypto.randomUUID()}.sqlite`;
  if (options.initialBytes && options.initialBytes.byteLength > 0 && fs) {
    try { fs.writeFile(path, options.initialBytes); } catch { /* fall back to fresh replay */ }
  }
  const principalBytes = typeof rootPrincipal === 'string' ? hexToBytes(rootPrincipal) : rootPrincipal;
  let runtime: any;
  try {
    runtime = await createSqlMaterializationRuntime({
      engine,
      path,
      rootPrincipal: principalBytes,
    });
  } catch (err) {
    // If a stale/corrupt checkpoint caused open failure, retry cleanly from empty MEMFS.
    cleanupMemfs(fs, path);
    if (options.initialBytes) {
      runtime = await createSqlMaterializationRuntime({
        engine,
        path,
        rootPrincipal: principalBytes,
      });
    } else {
      throw err;
    }
  }

  const origClose = runtime.close.bind(runtime);
  let closed = false;
  return {
    ...runtime,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await origClose();
        if (options.onCloseBytes && fs) {
          try {
            const bytes = fs.readFile(path);
            if (bytes && bytes.byteLength > 0) await options.onCloseBytes(bytes.slice());
          } catch { /* snapshot export best-effort */ }
        }
      } finally {
        cleanupMemfs(fs, path);
      }
    },
  };
}
