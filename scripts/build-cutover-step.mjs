// Cloudflare requires the old binding to be removed in a deployed version
// before its namespace can be deleted. This short-lived Worker exposes inert
// old classes without bindings; the normal build replaces it in the next step.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { build } from 'esbuild';

const configPath = resolve(process.argv[2] || '');
if (!/\/server\/wrangler\.(staging|production)\.jsonc$/.test(configPath))
  throw Error('Usage: node scripts/build-cutover-step.mjs server/wrangler.staging.jsonc');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
for (const name of ['Tendril', 'TendrilV2']) {
  if (config.exports?.[name]?.state !== 'deleted') throw Error(`Expected ${name} tombstone`);
  config.exports[name] = { type: 'durable-object', storage: 'sqlite' };
}
config.main = '../dist/service/cutover-worker.mjs';
const output = join(dirname(configPath), `.${basename(configPath, '.jsonc')}.cutover.jsonc`);
writeFileSync(output, JSON.stringify(config, null, 2) + '\n');

await build({
  stdin: {
    contents: `import { DurableObject } from 'cloudflare:workers';
export { default, TendrilV3, Admission } from './composition/entry.ts';
class Retired extends DurableObject { async fetch() { return new Response('Retired', { status: 410 }); } }
export class Tendril extends Retired {}
export class TendrilV2 extends Retired {}
`,
    resolveDir: resolve(import.meta.dirname, '..'),
    sourcefile: 'cutover-entry.ts',
    loader: 'ts',
  },
  outfile: resolve(import.meta.dirname, '../dist/service/cutover-worker.mjs'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  external: ['cloudflare:workers'],
});
console.log(output);
