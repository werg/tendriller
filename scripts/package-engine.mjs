// A public Worker artifact lets deliberate extensions use only public packages.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CONTRACT_VERSION, CORE_RELEASE } from '../contract/index.mjs';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..'), dist = join(root, 'dist'), engine = join(dist, 'engine');
const workersTypes = JSON.parse(readFileSync(join(root, 'node_modules/@cloudflare/workers-types/package.json'), 'utf8')).version;
const source = readFileSync(join(engine, 'worker.mjs'), 'utf8');
if (!source.includes('configureWorkflows')) throw Error('Build the generic engine with its public trusted-selection export first');
const membership = join(root, 'node_modules/@chronolog/membership');
const provenance = JSON.parse(readFileSync(join(membership, 'provenance.json'), 'utf8'));
if (provenance.dirty || !/^[0-9a-f]{40}$/.test(provenance.source) || !Array.isArray(provenance.inputs) ||
    provenance.inputs.some(input => /(?:materializer|transport-ssb|node-core\/src\/node\.ts|node:)/.test(input)))
  throw Error('Membership artifact must identify a clean portable source checkpoint');
for (const name of ['index.mjs', 'index.d.ts']) {
  const hash = createHash('sha256').update(readFileSync(join(membership, name))).digest('hex');
  if (provenance.sha256[name] !== hash) throw Error(`Membership artifact digest mismatch for ${name}`);
}
copyFileSync(join(membership, 'provenance.json'), join(engine, 'membership-provenance.json'));
const peerControl = join(root, 'node_modules/@chronolog/peer-generation');
const peerProof = JSON.parse(readFileSync(join(peerControl, 'provenance.json'), 'utf8'));
if (peerProof.dirty || peerProof.profile !== 'peer-generation-v1' || !/^[0-9a-f]{40}$/.test(peerProof.source) ||
    !Array.isArray(peerProof.inputs) || peerProof.inputs.some(input => /(?:materializer|peer-session|transport-ssb|node-core\/src\/node\.ts|node:)/.test(input)))
  throw Error('Peer generation controls must identify a clean portable source checkpoint');
for (const name of ['control.mjs', 'control.d.ts']) {
  if (createHash('sha256').update(readFileSync(join(peerControl, name))).digest('hex') !== peerProof.sha256[name])
    throw Error(`Peer generation control digest mismatch for ${name}`);
}
if (createHash('sha256').update(readFileSync(join(root, 'contract/peer-authority.d.mts'))).digest('hex') !== peerProof.sha256['control.d.ts'])
  throw Error('The public peer authority declarations must match the embedded control artifact');
copyFileSync(join(peerControl, 'provenance.json'), join(engine, 'peer-generation-provenance.json'));
writeFileSync(join(engine, 'index.d.mts'), readFileSync(join(root, 'contract/engine.d.mts'), 'utf8').replace("'./host.d.mts'", "'@tendriller/core/host'"));
mkdirSync(join(engine, 'migrations'), { recursive: true });
copyFileSync(join(root, 'server/migrations/0001_accounts.sql'), join(engine, 'migrations/0001_accounts.sql'));
await build({ entryPoints: [join(root, 'server/test/public-fixture.ts')], outfile: join(engine, 'testing.mjs'), bundle: true,
  platform: 'neutral', format: 'esm', target: 'es2022', external: ['cloudflare:workers', 'cloudflare:test'], logLevel: 'warning' });
copyFileSync(join(root, 'contract/testing.d.mts'), join(engine, 'testing.d.mts'));
writeFileSync(join(engine, 'package.json'), JSON.stringify({
  name: '@tendriller/engine', version: CORE_RELEASE, type: 'module',
  description: 'Tendriller Worker with an empty default trusted-extension registry',
  exports: { '.': { types: './index.d.mts', import: './worker.mjs' }, './accounts-schema': './migrations/0001_accounts.sql',
    './testing': { types: './testing.d.mts', import: './testing.mjs' }, './membership-provenance': './membership-provenance.json', './peer-generation-provenance': './peer-generation-provenance.json' },
  files: ['worker.mjs', 'index.d.mts', 'migrations', 'testing.mjs', 'testing.d.mts', 'membership-provenance.json', 'peer-generation-provenance.json'], peerDependencies: { '@tendriller/core': CORE_RELEASE },
  dependencies: { '@cloudflare/workers-types': workersTypes },
  tendriller: { contract: CONTRACT_VERSION },
}, null, 2) + '\n');
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dist], { cwd: engine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
const target = join(dist, `tendriller-engine-${CORE_RELEASE}.tgz`), original = join(dist, packed.filename);
if (original !== target) { copyFileSync(original, target); rmSync(original); }
console.log(`Packaged public engine ${CORE_RELEASE}`);
