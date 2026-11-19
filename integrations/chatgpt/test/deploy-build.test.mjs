import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { assembleRelease, buildRelease, CHRONOLOG_SOURCE, hashFile, inspectSource, sealRelease, unpackPublicArchive } from '../deploy/build-release.mjs';

const command = promisify(execFile);
const text = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const json = (path, value) => text(path, JSON.stringify(value, null, 2) + '\n');
const git = async (root, ...args) => (await command('git', args, { cwd: root })).stdout.trim();
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, name)); else result.push(name);
  }
  return result.sort();
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'tendriller-release-build-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function repository(path, entries) {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '--quiet');
  await git(path, 'config', 'user.name', 'Release fixture'); await git(path, 'config', 'user.email', 'release-fixture@example.invalid');
  for (const [name, value] of Object.entries(entries)) await text(join(path, name), value);
  await git(path, 'add', '.'); await git(path, 'commit', '--quiet', '-m', 'Synthetic release fixture');
  return { directory: path, source: await git(path, 'rev-parse', 'HEAD'), sourceTree: await git(path, 'rev-parse', 'HEAD^{tree}'), dirty: false };
}
async function pack(directory, archive, layout = 'package') {
  await mkdir(dirname(archive), { recursive: true });
  if (layout === 'package') {
    const staging = archive + '.inputs'; await mkdir(staging, { recursive: true });
    await cp(directory, join(staging, 'package'), { recursive: true });
    try { await command('tar', ['-czf', archive, '-C', staging, 'package']); }
    finally { await rm(staging, { recursive: true, force: true }); }
  } else await command('tar', ['-czf', archive, '-C', directory, '.']);
}

async function fixture(t) {
  const root = await directory(t), prefix = 'integrations/chatgpt/';
  const entries = {
    '.gitignore': 'dist/\nnode_modules/\n.tendriller/\nartifacts/\n',
    'package.json': JSON.stringify({ name: 'fixture-core', version: '1.2.3' }),
    [prefix + 'package.json']: JSON.stringify({ private: true, type: 'module', dependencies: { 'ipaddr.js': '2.5.0' } }),
    [prefix + 'package-lock.json']: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    [prefix + 'integration.mjs']: 'export const createIntegration = () => {};\n',
    [prefix + 'account.mjs']: 'export const createTendrillerAccountAdapter = () => {};\n',
    [prefix + 'account-browser.mjs']: 'export const createHostAccountBrowser = () => {};\n',
    [prefix + 'run.mjs']: '// exact fixture runtime\n',
    [prefix + 'config.host-account.example.mjs']: 'export default {};\n',
    [prefix + 'deploy/prepare.mjs']: 'export const prepareDeployment = () => {};\n',
    [prefix + 'deploy/preflight.mjs']: 'export const preflightConfig = () => {};\n',
    [prefix + 'deploy/stage-bridge.mjs']: 'export const stageBridge = () => {};\n',
    [prefix + 'deploy/common.mjs']: '// fixture deployment helpers\n',
    [prefix + 'deploy/README.md']: '# Fixture deployment instructions\n',
    [prefix + 'deploy/settings.example.json']: '{}\n',
    [prefix + 'examples/kitchen/domain.mjs']: 'export const definition = {};\n',
    [prefix + 'examples/kitchen/projection.mjs']: 'export const project = () => null;\n',
    [prefix + 'examples/kitchen/session.mjs']: "import {createClient} from '@tendriller/core'; import {openNativeDevice} from '@chronolog/peer-session/native'; export const openSession = () => ({createClient,openNativeDevice});\n",
    [prefix + 'examples/kitchen/bridge-session.mjs']: "export {openSession} from './session.mjs';\n",
    [prefix + 'examples/kitchen/local.mjs']: 'export const project = () => {};\n',
    [prefix + 'examples/kitchen/private-records.mjs']: 'export const createPrivateRecords = () => {};\n',
    [prefix + 'examples/kitchen/setup.mjs']: '// provisioning is excluded from the bridge template\n',
  };
  const core = await repository(join(root, 'core-input'), entries);
  const chronoRepo = await repository(join(root, 'chronolog-input'), { '.gitignore': 'artifacts/\nnode_modules/\n',
    'package.json': JSON.stringify({ name: 'fixture-chronolog', private: true }) });
  const chronolog = { ...chronoRepo, source: CHRONOLOG_SOURCE };
  // Untracked ignored private state must never be copied by source-tree assembly.
  await text(join(core.directory, prefix + 'examples/kitchen/.tendriller/device.sqlite'), 'creator-private-signer');
  return { root, core, chronolog, chronoActualRef: chronoRepo.source };
}
async function coreArtifacts(core, sdkPackage = {}) {
  const artifacts = [];
  for (const [kind, name] of [['sdk', '@tendriller/core'], ['runtime', '@tendriller/runtime'], ['engine', '@tendriller/engine'], ['tools', '@tendriller/tools']]) {
    const packageDir = join(core.directory, 'dist', kind), file = `tendriller-${kind}-1.2.3.tgz`;
    await json(join(packageDir, 'package.json'), { name, version: '1.2.3', type: 'module', exports: './client.mjs', ...(kind === 'sdk' ? sdkPackage : {}) });
    await text(join(packageDir, 'client.mjs'), 'export const createClient = () => {};\n');
    await pack(packageDir, join(core.directory, 'dist', file), kind === 'tools' ? '.' : 'package');
    const artifact = { name, version: '1.2.3', file, sha256: await hashFile(join(core.directory, 'dist', file)) };
    if (kind === 'tools') await json(join(core.directory, 'dist/tools-manifest.json'), { source_commit: core.source, version: '1.2.3', artifacts: [artifact] });
    else artifacts.push(artifact);
  }
  await json(join(core.directory, 'dist/provenance.json'), { source: core.source, sourceTree: core.sourceTree, dirty: false, artifacts });
}
async function chronoArtifact(chronolog, { corrupt = false } = {}) {
  const directory = join(chronolog.directory, 'artifacts/peer-session/package');
  await json(join(directory, 'package.json'), { name: '@chronolog/peer-session', version: '0.0.0-gf0b71005', type: 'module',
    exports: { '.': './index.mjs', './native': './native.mjs' }, dependencies: {} });
  await text(join(directory, 'index.mjs'), 'export const defineApplication = value => value;\n');
  await text(join(directory, 'native.mjs'), 'export const openNativeDevice = () => {};\n');
  const hashes = {};
  for (const name of await files(directory)) if (name !== 'provenance.json') hashes[name] = await hashFile(join(directory, name));
  await json(join(directory, 'provenance.json'), { format: 'chronolog-peer-session-package/v1', source: chronolog.source,
    sourceTree: chronolog.sourceTree, dirty: false, optionalNativeRtc: false, sqlEngines: [], sha256: hashes });
  if (corrupt) await text(join(directory, 'native.mjs'), 'export const openNativeDevice = () => "tampered";\n');
  await pack(directory, join(chronolog.directory, 'artifacts/peer-session/chronolog-peer-session-f0b71005.tgz'));
}
async function realRun(executable, args, options = {}) {
  const result = await command(executable, args, { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 });
  if (options.logFile) await text(options.logFile, result.stdout + result.stderr);
  return result;
}
const runtimeInstaller = calls => async (executable, args, options = {}) => {
  if (executable !== 'npm') return realRun(executable, args, options);
  calls.push({ args, cwd: options.cwd });
  assert.deepEqual(args, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  await json(join(options.cwd, 'node_modules/ipaddr.js/package.json'), { name: 'ipaddr.js', version: '2.5.0' });
  await text(join(options.cwd, 'node_modules/ipaddr.js/index.js'), 'module.exports = {};\n');
  return { stdout: '' };
};

test('release source inspection requires a clean checkout at the exact commit', async t => {
  const f = await fixture(t);
  assert.deepEqual(await inspectSource(f.core.directory, f.core.source), f.core);
  await assert.rejects(inspectSource(f.core.directory, 'a'.repeat(40)), { code: 'RELEASE_SOURCE_REF_MISMATCH' });
  await text(join(f.core.directory, 'untracked.mjs'), '// not checkpointed\n');
  await assert.rejects(inspectSource(f.core.directory, f.core.source), { code: 'RELEASE_SOURCE_DIRTY' });
  await rm(join(f.core.directory, 'untracked.mjs'));
  await text(join(f.core.directory, 'package.json'), '{}\n');
  await assert.rejects(inspectSource(f.core.directory, f.core.source), { code: 'RELEASE_SOURCE_DIRTY' });
});

test('public archive extraction supports both package layouts and rejects links or traversal', async t => {
  const root = await directory(t), input = join(root, 'input');
  await json(join(input, 'package.json'), { name: 'fixture' });
  for (const layout of ['package', '.']) {
    const archive = join(root, layout === '.' ? 'gnu.tgz' : 'npm.tgz'), destination = archive + '.out';
    await pack(input, archive, layout); await unpackPublicArchive(archive, destination);
    assert.equal(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).name, 'fixture');
  }
  await symlink('/outside-private-state', join(input, 'linked'));
  const linked = join(root, 'linked.tgz'); await pack(input, linked, '.');
  await assert.rejects(unpackPublicArchive(linked, join(root, 'bad-links')), { code: 'RELEASE_ARCHIVE_LINK_UNSUPPORTED' });
  await rm(join(input, 'linked'));
  const traversal = join(root, 'traversal.tgz');
  await command('tar', ['-czf', traversal, '--transform=s@package.json@../outside.json@', '-C', input, 'package.json']);
  await assert.rejects(unpackPublicArchive(traversal, join(root, 'bad-paths')), { code: 'RELEASE_PATH_INVALID' });
  await assert.rejects(lstat(join(root, 'outside.json')), { code: 'ENOENT' });
});

test('assembly uses exact public archives, locked runtime dependencies and a minimal signer-free template', async t => {
  const f = await fixture(t), calls = [], destination = join(f.root, 'assembled');
  await coreArtifacts(f.core); await chronoArtifact(f.chronolog);
  const result = await assembleRelease({ ...f, destination, env: process.env }, { run: runtimeInstaller(calls) });
  assert.equal(calls.length, 1);
  assert.deepEqual((await readdir(join(destination, 'bridge-template'))).sort(), ['bridge-session.mjs', 'domain.mjs', 'local.mjs',
    'node_modules', 'package.json', 'private-records.mjs', 'projection.mjs', 'session.mjs']);
  assert.equal((await files(destination)).some(name => name.includes('.tendriller') || name.endsWith('.sqlite')), false);
  assert.equal((await files(join(destination, 'bridge-template/node_modules'))).some(name => name.includes('ipaddr.js')), false);
  assert.equal(JSON.parse(await readFile(join(destination, 'bridge-template/package.json'), 'utf8')).scripts, undefined);
  assert.equal(JSON.parse(await readFile(join(result.nativePackage, 'provenance.json'), 'utf8')).source, CHRONOLOG_SOURCE);
  for (const artifact of Object.values(result.archives)) assert.equal(await hashFile(join(destination, artifact.file)), artifact.sha256);
  const checks = { nativeIntegration: { passed: true, tests: 3, skipped: 0 }, hostAccountIntegration: { passed: true }, runtimeImports: true };
  for (const name of ['account.mjs', 'account-browser.mjs', 'deploy/prepare.mjs', 'deploy/preflight.mjs',
    'deploy/stage-bridge.mjs', 'deploy/common.mjs', 'deploy/README.md', 'deploy/settings.example.json']) {
    const path = join(destination, 'integrations/chatgpt', name), original = await readFile(path);
    await rm(path);
    await assert.rejects(sealRelease(destination, { ...f, archives: result.archives, checks }), { code: 'RELEASE_INCOMPLETE' },
      `A release missing ${name} must never be sealed`);
    await assert.rejects(lstat(join(destination, 'RELEASE.json')), { code: 'ENOENT' });
    await writeFile(path, original);
  }
  const manifest = await sealRelease(destination, { ...f, archives: result.archives, checks, toolchain: { node: process.version } });
  assert.deepEqual(Object.keys(manifest.files).sort(), (await files(destination)).filter(name => name !== 'RELEASE.json'));
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(bytesHash(await readFile(join(destination, name))), hash);
  assert.equal(JSON.stringify(manifest).includes(f.root), false, 'Published provenance must not contain build-local paths');
});

test('altered archives and unqualified native gates cannot produce a release manifest', async t => {
  const f = await fixture(t), destination = join(f.root, 'altered');
  await coreArtifacts(f.core); await chronoArtifact(f.chronolog);
  await text(join(f.core.directory, 'dist/tendriller-sdk-1.2.3.tgz'), 'altered archive');
  await assert.rejects(assembleRelease({ ...f, destination, env: process.env }, { run: runtimeInstaller([]) }), { code: 'RELEASE_ARCHIVE_DIGEST_MISMATCH' });
  await coreArtifacts(f.core); await chronoArtifact(f.chronolog, { corrupt: true });
  await assert.rejects(assembleRelease({ ...f, destination: join(f.root, 'altered-native'), env: process.env }, { run: runtimeInstaller([]) }), { code: 'RELEASE_NATIVE_PACKAGE_CHANGED' });
  await assert.rejects(sealRelease(destination, { ...f, archives: {}, checks: { nativeIntegration: { passed: true, skipped: 1 }, runtimeImports: true } }), { code: 'RELEASE_QUALIFICATION_REQUIRED' });
  await assert.rejects(sealRelease(destination, { ...f, archives: {}, checks: { nativeIntegration: { passed: true, skipped: 0 }, runtimeImports: true } }), { code: 'RELEASE_QUALIFICATION_REQUIRED' });
  await assert.rejects(lstat(join(destination, 'RELEASE.json')), { code: 'ENOENT' });
});

// The build commands are controlled here; real git clones, tar extraction,
// archive digests and final runtime imports still execute. The full pinned
// Chronolog/core build is a separate release qualification, never claimed here.
function buildRunner(f, { skipped = 0, hostReportPatch = {} } = {}) {
  const commands = [];
  const run = async (executable, args, options = {}) => {
    commands.push({ executable, args, cwd: options.cwd });
    const chrono = options.cwd === f.chronolog.directory || options.cwd?.endsWith('/build/chronolog');
    if (executable === 'git' && chrono && args.join(' ') === 'rev-parse HEAD') return { stdout: CHRONOLOG_SOURCE + '\n' };
    if (executable === 'git' && chrono && args.includes('checkout'))
      return realRun(executable, args.map(value => value === CHRONOLOG_SOURCE ? f.chronoActualRef : value), options);
    let handled = false, output = '';
    if (executable === 'npm' && args[0] === 'ci') {
      if (args.includes('--omit=dev')) await runtimeInstaller([])(executable, args, options);
      handled = true;
    } else if (executable === 'npm' && args.join(' ') === 'run build:artifacts') {
      await coreArtifacts({ ...f.core, directory: options.cwd }); handled = true;
    } else if (executable === 'corepack' && args[1] === 'install') handled = true;
    else if (executable === process.execPath && args[0] === 'tools/package-peer-session.mjs') {
      await chronoArtifact({ ...f.chronolog, directory: options.cwd }); handled = true;
    } else if (executable === 'npm' && args.join(' ') === 'run test:chatgpt') {
      assert.equal(options.env.NODE_OPTIONS, '--test-reporter=tap');
      assert.equal(JSON.parse(await readFile(join(options.env.CHRONOLOG_SESSION_PACKAGE, 'provenance.json'), 'utf8')).source, CHRONOLOG_SOURCE);
      output = `TAP version 13\n# tests 3\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`; handled = true;
    } else if (executable === 'npm' && args[0] === 'run' && args[1] === 'test:chatgpt:host') {
      const archive = args[args.indexOf('--engine-archive') + 1], report = args[args.indexOf('--report') + 1];
      assert.equal(archive.includes('/release.pending/archives/tendriller-engine-'), true);
      await json(report, { status: 'passed', qualification: 'packed-worker-node-account-contract',
        engine: { source: f.core.source, dirty: false, sha256: await hashFile(archive) },
        node: { source: f.core.source, dirty: false }, steps: ['synthetic test-runner result'],
        limits: ['Fixture orchestration only.'], ...hostReportPatch });
      handled = true;
    } else if (executable === 'npm' && args[0] === '--version' || executable === 'corepack' && args[1] === '--version') {
      output = 'fixture-toolchain\n'; handled = true;
    }
    if (!handled) return realRun(executable, args, options);
    if (options.logFile) await text(options.logFile, output);
    return { stdout: output };
  };
  return { run, commands };
}

test('release orchestration isolates builds and exposes output only after the required gate and import smoke', async t => {
  const f = await fixture(t), runner = buildRunner(f), output = join(f.root, 'ready'), progress = [];
  const result = await buildRelease({ coreSource: f.core.directory, coreRef: f.core.source,
    chronologSource: f.chronolog.directory, output }, { run: runner.run, onProgress: phase => progress.push(phase) });
  assert.equal(result.release, join(output, 'release')); assert.equal(result.tests, 3); assert.equal(result.liveChatGptVerified, false);
  assert.equal(progress.at(-1), 'release-ready');
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(manifest.checks.hostAccountIntegration.passed, true);
  assert.equal(manifest.checks.hostAccountIntegration.engineSha256, manifest.archives.engine.sha256);
  assert.equal(JSON.parse(await readFile(join(result.release, manifest.checks.hostAccountIntegration.report), 'utf8')).status, 'passed');
  assert.deepEqual(await inspectSource(f.core.directory, f.core.source), f.core);
  await assert.rejects(lstat(join(output, 'release.pending')), { code: 'ENOENT' });
  assert.equal((await files(result.release)).some(path => path.includes('/.git/')), false);
  assert.equal(runner.commands.some(call => call.executable === 'npm' && call.args.includes('build:artifacts') && call.cwd === join(output, 'build/core')), true);
  assert.equal(runner.commands.some(call => call.executable === 'corepack' && call.args.includes('--frozen-lockfile') && call.args.includes('--ignore-scripts')), true);
  await assert.rejects(buildRelease({ coreSource: f.core.directory, coreRef: f.core.source,
    chronologSource: f.chronolog.directory, output }, { run: runner.run }), { code: 'RELEASE_OUTPUT_EXISTS' });
});

test('a skipped native gate retains diagnostics but never publishes a ready release', async t => {
  const f = await fixture(t), runner = buildRunner(f, { skipped: 1 }), output = join(f.root, 'not-ready');
  await assert.rejects(buildRelease({ coreSource: f.core.directory, coreRef: f.core.source,
    chronologSource: f.chronolog.directory, output }, { run: runner.run }), { code: 'RELEASE_NATIVE_GATE_INCOMPLETE' });
  await assert.rejects(lstat(join(output, 'release')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(output, 'release.pending/RELEASE.json')), { code: 'ENOENT' });
  assert.match(await readFile(join(output, 'build/logs/native-integration-gate.log'), 'utf8'), /# skipped 1/);
  assert.deepEqual(await inspectSource(f.core.directory, f.core.source), f.core);
});

test('an unsuccessful host account report cannot seal otherwise qualified release bytes', async t => {
  const f = await fixture(t), runner = buildRunner(f, { hostReportPatch: { status: 'failed' } }), output = join(f.root, 'host-not-ready');
  await assert.rejects(buildRelease({ coreSource: f.core.directory, coreRef: f.core.source,
    chronologSource: f.chronolog.directory, output }, { run: runner.run }), { code: 'RELEASE_HOST_GATE_INCOMPLETE' });
  await assert.rejects(lstat(join(output, 'release')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(output, 'release.pending/RELEASE.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(output, 'build/logs/host-account-report.json'), 'utf8')).status, 'failed');
  assert.deepEqual(await inspectSource(f.core.directory, f.core.source), f.core);
});

test('assembly permits only the known optional SDK peer satisfied by the exact verified session archive', async t => {
  const allowed = { peerDependencies: { '@chronolog/peer-session': '*' }, peerDependenciesMeta: { '@chronolog/peer-session': { optional: true } } };
  const variants = [
    { name: 'known optional peer', value: allowed, accepted: true },
    { name: 'unknown optional peer', value: { peerDependencies: { surprise: '*' }, peerDependenciesMeta: { surprise: { optional: true } } } },
    { name: 'required session peer', value: { peerDependencies: { '@chronolog/peer-session': '*' } } },
    { name: 'non-optional metadata', value: { ...allowed, peerDependenciesMeta: { '@chronolog/peer-session': { optional: false } } } },
    { name: 'additional runtime dependency', value: { ...allowed, dependencies: { surprise: '1.0.0' } } },
    { name: 'additional optional dependency', value: { ...allowed, optionalDependencies: { surprise: '1.0.0' } } },
  ];
  for (const variant of variants) await t.test(variant.name, async subtest => {
    const f = await fixture(subtest), destination = join(f.root, 'assembled');
    await coreArtifacts(f.core, variant.value); await chronoArtifact(f.chronolog);
    const assemble = () => assembleRelease({ ...f, destination, env: process.env }, { run: runtimeInstaller([]) });
    if (!variant.accepted) { await assert.rejects(assemble(), { code: 'RELEASE_PUBLIC_PACKAGE_INVALID' }); return; }
    const result = await assemble();
    const installed = JSON.parse(await readFile(join(destination, 'integrations/chatgpt/node_modules/@tendriller/core/package.json'), 'utf8'));
    assert.deepEqual(installed.peerDependencies, allowed.peerDependencies);
    assert.deepEqual(installed.peerDependenciesMeta, allowed.peerDependenciesMeta);
    assert.equal(JSON.parse(await readFile(join(result.nativePackage, 'provenance.json'), 'utf8')).source, CHRONOLOG_SOURCE);
    assert.equal(await hashFile(join(destination, result.archives.chronolog.file)), result.archives.chronolog.sha256);
  });
});
