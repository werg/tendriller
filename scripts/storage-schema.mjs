// Deployment gates use the same storage revision that the Durable Object checks.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function requiredStorageSchema() {
  const compiled = await build({ entryPoints: [new URL('../server/src/db.ts', import.meta.url).pathname],
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const { STORAGE_SCHEMA_REVISION } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  if (!Number.isSafeInteger(STORAGE_SCHEMA_REVISION) || STORAGE_SCHEMA_REVISION < 1) throw Error('The server must export a positive storage schema revision.');
  return STORAGE_SCHEMA_REVISION;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await requiredStorageSchema());
