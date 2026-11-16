// A public Worker artifact lets deliberate extensions use only public packages.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CONTRACT_VERSION, CORE_RELEASE } from '../contract/index.mjs';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..'), dist = join(root, 'dist'), engine = join(dist, 'engine');
const workersTypes = JSON.parse(readFileSync(join(root, 'node_modules/@cloudflare/workers-types/package.json'), 'utf8')).version;
const source = readFileSync(join(engine, 'worker.mjs'), 'utf8');
if (!source.includes('configureWorkflows')) throw Error('Build the generic engine with its public trusted-selection export first');
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
    './testing': { types: './testing.d.mts', import: './testing.mjs' } },
  files: ['worker.mjs', 'index.d.mts', 'migrations', 'testing.mjs', 'testing.d.mts'], peerDependencies: { '@tendriller/core': CORE_RELEASE },
  dependencies: { '@cloudflare/workers-types': workersTypes },
  tendriller: { contract: CONTRACT_VERSION },
}, null, 2) + '\n');
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dist], { cwd: engine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
const target = join(dist, `tendriller-engine-${CORE_RELEASE}.tgz`), original = join(dist, packed.filename);
if (original !== target) { copyFileSync(original, target); rmSync(original); }
console.log(`Packaged public engine ${CORE_RELEASE}`);
