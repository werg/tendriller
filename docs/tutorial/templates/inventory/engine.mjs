// Chronolog ships portable `sqlite-cas.wasm` directly inside `@chronolog/peer-session`.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function inspectSqliteEngine() {
  const pkg = new URL(import.meta.resolve('@chronolog/peer-session'));
  const manifest = JSON.parse(await readFile(new URL('./wasm/manifest.json', pkg), 'utf8'));
  return { available: true, builtinId: manifest.builtinId, wasmBytes: manifest.wasmBytes, wasmSha256: manifest.wasmSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await inspectSqliteEngine(), null, 2));
}
