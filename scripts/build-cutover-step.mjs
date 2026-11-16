// Cloudflare rejects deletion of a namespace while the currently deployed
// Worker still binds it. Deploy this inert, unbound version once before the
// canonical tombstone version. It is never part of the public engine archive.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { build } from 'esbuild';

const configPath = resolve(process.argv[2] || '');
if (!/\/server\/wrangler\.(staging|production)\.jsonc$/.test(configPath))
  throw Error('Usage: node scripts/build-cutover-step.mjs server/wrangler.staging.jsonc');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
for (const name of ['TendrilV3', 'Admission']) {
  if (config.exports?.[name]?.state !== 'deleted') throw Error(`Expected ${name} tombstone`);
  config.exports[name] = { type: 'durable-object', storage: 'sqlite' };
}
config.main = '../dist/service/cutover-worker.mjs';
const output = join(dirname(configPath), `.${basename(configPath, '.jsonc')}.cutover.jsonc`);
writeFileSync(output, JSON.stringify(config, null, 2) + '\n');

await build({
  stdin: {
    contents: `import { DurableObject } from 'cloudflare:workers';
export { default, TendrilV4, AdmissionV4 } from './server/src/deploy-entry.ts';
class Retired extends DurableObject { async fetch() { return new Response('Retired', { status: 410 }); } }
export class TendrilV3 extends Retired {}
export class Admission extends Retired {}
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
