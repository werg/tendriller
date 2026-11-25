/**
 * Ephemeral in-memory DoltLite WASM materialization engine for Cloudflare Workers / DO.
 *
 * Uses static `.wasm` module import (`instantiateWasm`) and Emscripten's built-in MEMFS,
 * so SQL apps materialize strictly in RAM during an authenticated /mcp request and leave
 * zero plaintext SQLite data on disk.
 */
import doltliteWasm from './vendor/doltlite/wasm/sqlite3.wasm';
import trampolinesWasm from './vendor/doltlite/wasm/trampolines.wasm';
import doltliteManifest from './vendor/doltlite/wasm/manifest.json';
import sqlite3InitModule from './vendor/doltlite/wasm/sqlite3.mjs';
import { createBrowserSqlEngine, createDoltLiteExecutionManifest, digestEngineManifest } from './vendor/doltlite/sql-browser.mjs';
import { createSqlMaterializationRuntime } from './vendor/doltlite/sql.mjs';
import { hexToBytes } from './mcp-crypto';

let cachedModule: Promise<any> | null = null;
let cachedDigest: Promise<string> | null = null;

async function getDoltLiteModule(): Promise<any> {
  if (!cachedModule) {
    cachedModule = Promise.resolve().then(async () => {
      const init = typeof sqlite3InitModule === 'function'
        ? sqlite3InitModule
        : (sqlite3InitModule as { default?: unknown }).default;
      if (typeof init !== 'function') throw new Error('DoltLite WASM initializer unavailable');
      return await (init as (opts: Record<string, unknown>) => Promise<any>)({
        print: () => {},
        printErr: () => {},
        __trampolinesWasm: trampolinesWasm,
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
    }).catch(err => {
      cachedModule = null;
      throw err;
    });
  }
  return cachedModule;
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
 * Every call uses a unique MEMFS path so concurrent/sequential requests never share state
 * and closing the session leaves zero plaintext SQLite behind.
 */
export async function createEphemeralSqlMaterializer(rootPrincipal: string | Uint8Array) {
  const module = await getDoltLiteModule();
  const engine = createBrowserSqlEngine({
    module,
    manifest: doltliteManifest as any,
    vfs: '',
  });
  const path = `/mcp-${crypto.randomUUID()}.sqlite`;
  const principalBytes = typeof rootPrincipal === 'string' ? hexToBytes(rootPrincipal) : rootPrincipal;
  return createSqlMaterializationRuntime({
    engine,
    path,
    rootPrincipal: principalBytes,
  });
}
