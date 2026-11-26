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
const authorityRoot = join(root, 'node_modules/@chronolog/authority');
const authorityProofBytes = readFileSync(join(authorityRoot, 'provenance.json'));
const authorityProof = JSON.parse(authorityProofBytes.toString('utf8'));
const allowDirty = process.argv.slice(2).includes('--allow-dirty');
if ((authorityProof.dirty !== false && !(allowDirty && authorityProof.dirty === true)) || authorityProof.format !== 'chronolog-authority-package/v1' || authorityProof.profile !== 'chronolog-crdt-v1' ||
    !/^[0-9a-f]{40}$/.test(authorityProof.source) || !Array.isArray(authorityProof.inputs) ||
    Object.values(authorityProof.runtimeModules ?? {}).some(module => module.inputs.some(input => /(?:materializer|peer-session|node:)/.test(input))))
  throw Error('Application authority must identify a clean portable CRDT source checkpoint');
// A diagnostic dependency must taint the complete artifact graph, even if this
// checkout itself is clean. Normal builds and release qualification stay strict.
if (authorityProof.dirty) identity.dirty = true;
for (const [name, expected] of Object.entries(authorityProof.sha256)) {
  if (sha256(join(authorityRoot, name)) !== expected) throw Error(`Application authority digest mismatch for ${name}`);
}
const compiledAuthority = JSON.parse(readFileSync(join(engine, 'authority-inputs.json'), 'utf8'));
if (compiledAuthority.provenanceSha256 !== createHash('sha256').update(authorityProofBytes).digest('hex') ||
    JSON.stringify(compiledAuthority.files) !== JSON.stringify(authorityProof.sha256))
  throw Error('The Worker must be built from the exact installed authority archive');
copyFileSync(join(authorityRoot, 'provenance.json'), join(engine, 'authority-provenance.json'));
writeFileSync(join(engine, 'index.d.mts'), readFileSync(join(root, 'contract/engine.d.mts'), 'utf8'));
mkdirSync(join(engine, 'migrations'), { recursive: true });
for (const migration of ['0001_accounts.sql', '0002_agents.sql', '0003_broadcasts.sql', '0004_account_limits.sql'])
  copyFileSync(join(root, 'server/migrations', migration), join(engine, 'migrations', migration));
// Independent workerd consumers must create the same host traffic bindings.
const testRateLimits = JSON.parse(readFileSync(join(root, 'server/wrangler.public-test.jsonc'), 'utf8')).ratelimits;
if (!Array.isArray(testRateLimits) || !['PAGE_RATE', 'ACCOUNT_RATE'].every(name => testRateLimits.some(limit => limit.name === name)))
  throw Error('The public host test configuration is missing required traffic bindings');
writeFileSync(join(engine, 'testing-ratelimits.json'), JSON.stringify({ ratelimits: testRateLimits }, null, 2) + '\n');
await build({ entryPoints: [join(root, 'server/test/public-fixture.ts')], outfile: join(engine, 'testing.mjs'), bundle: true,
  platform: 'neutral', format: 'esm', target: 'es2022', external: ['cloudflare:workers', 'cloudflare:test', 'node:crypto', 'node:net'], logLevel: 'warning' });
copyFileSync(join(root, 'contract/testing.d.mts'), join(engine, 'testing.d.mts'));
const wasmAssets = JSON.parse(readFileSync(join(engine, 'wasm-assets.json'), 'utf8'));
writeFileSync(join(engine, 'package.json'), JSON.stringify({
  name: '@tendriller/engine', version: CORE_RELEASE, type: 'module',
  description: 'Tendriller page host and filtered Chronolog participant',
  exports: { '.': { types: './index.d.mts', import: './worker.mjs' }, './accounts-schema': './migrations/0001_accounts.sql', './agents-schema': './migrations/0002_agents.sql', './broadcasts-schema': './migrations/0003_broadcasts.sql', './limits-schema': './migrations/0004_account_limits.sql',
    './testing': { types: './testing.d.mts', import: './testing.mjs' }, './testing-ratelimits': './testing-ratelimits.json', './provenance': './provenance.json',
    './authority-provenance': './authority-provenance.json' },
  files: ['worker.mjs', ...wasmAssets, 'wasm-assets.json', 'index.d.mts', 'migrations', 'testing.mjs', 'testing.d.mts', 'testing-ratelimits.json', 'provenance.json', 'authority-provenance.json', 'authority-inputs.json'], peerDependencies: { '@tendriller/core': CORE_RELEASE },
  dependencies: { '@cloudflare/workers-types': workersTypes },
  tendriller: { contract: CONTRACT_VERSION },
}, null, 2) + '\n');
const files = ['worker.mjs', ...wasmAssets, 'wasm-assets.json', 'index.d.mts', 'testing.mjs', 'testing.d.mts', 'testing-ratelimits.json', 'migrations/0001_accounts.sql', 'migrations/0002_agents.sql', 'migrations/0003_broadcasts.sql', 'migrations/0004_account_limits.sql',
  'package.json', 'authority-provenance.json', 'authority-inputs.json'];
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
