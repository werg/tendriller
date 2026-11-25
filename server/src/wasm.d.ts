declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module '@jitl/quickjs-ng-wasmfile-release-sync/wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module '*vendor/doltlite/wasm/sqlite3.mjs' {
  export default function sqlite3InitModule(options?: Record<string, unknown>): Promise<any>;
}

declare module '*vendor/doltlite/sql-browser.mjs' {
  export function createBrowserSqlEngine(options: Record<string, unknown>): any;
  export function createDoltLiteExecutionManifest(options: Record<string, unknown>): any;
  export function digestEngineManifest(manifest: unknown): string;
}

declare module '*vendor/doltlite/sql.mjs' {
  export function createSqlMaterializationRuntime(options: Record<string, unknown>): Promise<any>;
}
