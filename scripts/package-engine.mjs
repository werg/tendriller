// A public Worker artifact lets deliberate extensions use only public packages.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CONTRACT_VERSION, CORE_RELEASE } from '../contract/index.mjs';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { requiredStorageSchema } from './storage-schema.mjs';

const root = resolve(import.meta.dirname, '..'), dist = join(root, 'dist'), engine = join(dist, 'engine');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const identity = { repository: 'werg/tendriller', source: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
  dirty: git('status', '--porcelain', '--untracked-files=normal').length !== 0 };
const storageSchemaRevision = await requiredStorageSchema();
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const workersTypes = JSON.parse(readFileSync(join(root, 'node_modules/@cloudflare/workers-types/package.json'), 'utf8')).version;
const source = readFileSync(join(engine, 'worker.mjs'), 'utf8');
if (!source.includes('Tendril')) throw Error('Build the participant host Worker first');
const peerControl = join(root, 'node_modules/@chronolog/peer-generation');
const peerProof = JSON.parse(readFileSync(join(peerControl, 'provenance.json'), 'utf8'));
if (peerProof.dirty || peerProof.profile !== 'peer-generation-v1' || !/^[0-9a-f]{40}$/.test(peerProof.source) ||
    !Array.isArray(peerProof.inputs) || peerProof.inputs.some(input => /(?:materializer|peer-session|transport-ssb|node-core\/src\/node\.ts|node:)/.test(input)))
  throw Error('Peer generation controls must identify a clean portable source checkpoint');
for (const name of ['control.mjs', 'control.d.ts', 'participant.mjs', 'participant.d.ts']) {
  if (createHash('sha256').update(readFileSync(join(peerControl, name))).digest('hex') !== peerProof.sha256[name])
    throw Error(`Peer generation control digest mismatch for ${name}`);
}
if (createHash('sha256').update(readFileSync(join(root, 'contract/peer-authority.d.mts'))).digest('hex') !== peerProof.sha256['control.d.ts'])
  throw Error('The public peer authority declarations must match the embedded control artifact');
for (const [embedded, source] of [['participant.mjs', 'participant.mjs'], ['participant.d.mts', 'participant.d.ts']]) {
  if (sha256(join(root, 'contract', embedded)) !== peerProof.sha256[source])
    throw Error(`The SDK participant transport must match its portable artifact: ${embedded}`);
}
copyFileSync(join(peerControl, 'provenance.json'), join(engine, 'peer-generation-provenance.json'));
writeFileSync(join(engine, 'index.d.mts'), readFileSync(join(root, 'contract/engine.d.mts'), 'utf8'));
mkdirSync(join(engine, 'migrations'), { recursive: true });
copyFileSync(join(root, 'server/migrations/0001_accounts.sql'), join(engine, 'migrations/0001_accounts.sql'));
copyFileSync(join(root, 'server/migrations/0002_integration_oauth.sql'), join(engine, 'migrations/0002_integration_oauth.sql'));
// Independent workerd consumers must create the same host traffic bindings.
const testRateLimits = JSON.parse(readFileSync(join(root, 'server/wrangler.public-test.jsonc'), 'utf8')).ratelimits;
if (!Array.isArray(testRateLimits) || !['PAGE_RATE', 'ACCOUNT_RATE'].every(name => testRateLimits.some(limit => limit.name === name)))
  throw Error('The public host test configuration is missing required traffic bindings');
writeFileSync(join(engine, 'testing-ratelimits.json'), JSON.stringify({ ratelimits: testRateLimits }, null, 2) + '\n');
await build({ entryPoints: [join(root, 'server/test/public-fixture.ts')], outfile: join(engine, 'testing.mjs'), bundle: true,
  platform: 'neutral', format: 'esm', target: 'es2022', external: ['cloudflare:workers', 'cloudflare:test', 'node:crypto', 'node:net'], logLevel: 'warning' });
copyFileSync(join(root, 'contract/testing.d.mts'), join(engine, 'testing.d.mts'));
writeFileSync(join(engine, 'package.json'), JSON.stringify({
  name: '@tendriller/engine', version: CORE_RELEASE, type: 'module',
  description: 'Tendriller page host and filtered Chronolog participant',
  exports: { '.': { types: './index.d.mts', import: './worker.mjs' }, './accounts-schema': './migrations/0001_accounts.sql',
    './integration-oauth-schema': './migrations/0002_integration_oauth.sql',
    './testing': { types: './testing.d.mts', import: './testing.mjs' }, './testing-ratelimits': './testing-ratelimits.json', './provenance': './provenance.json',
    './peer-generation-provenance': './peer-generation-provenance.json' },
  files: ['worker.mjs', 'index.d.mts', 'migrations', 'testing.mjs', 'testing.d.mts', 'testing-ratelimits.json', 'provenance.json', 'peer-generation-provenance.json'], peerDependencies: { '@tendriller/core': CORE_RELEASE },
  dependencies: { '@cloudflare/workers-types': workersTypes },
  tendriller: { contract: CONTRACT_VERSION },
}, null, 2) + '\n');
const files = ['worker.mjs', 'index.d.mts', 'testing.mjs', 'testing.d.mts', 'testing-ratelimits.json', 'migrations/0001_accounts.sql',
  'migrations/0002_integration_oauth.sql',
  'package.json', 'peer-generation-provenance.json'];
writeFileSync(join(engine, 'provenance.json'), JSON.stringify({ ...identity, storageSchemaRevision,
  files: Object.fromEntries(files.map(name => [name, sha256(join(engine, name))])) }, null, 2) + '\n');
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dist], { cwd: engine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
const target = join(dist, `tendriller-engine-${CORE_RELEASE}.tgz`), original = join(dist, packed.filename);
if (original !== target) { copyFileSync(original, target); rmSync(original); }
const artifacts = [['@tendriller/core', 'sdk'], ['@tendriller/runtime', 'runtime'], ['@tendriller/engine', 'engine']].map(([name, kind]) => {
  const file = `tendriller-${kind}-${CORE_RELEASE}.tgz`;
  return { name, version: CORE_RELEASE, file, sha256: sha256(join(dist, file)) };
});
writeFileSync(join(dist, 'provenance.json'), JSON.stringify({ ...identity, artifacts }, null, 2) + '\n');
console.log(`Packaged public engine ${CORE_RELEASE}`);
