import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { CHRONOLOG_SOURCE } from './common.mjs';

export { CHRONOLOG_SOURCE };
const SHA = /^[a-f0-9]{40}$/u, HASH = /^[a-f0-9]{64}$/u;
const TEMPLATE_FILES = ['domain.mjs', 'projection.mjs', 'session.mjs', 'bridge-session.mjs', 'local.mjs', 'private-records.mjs'];
const REQUIRED = ['integrations/chatgpt/run.mjs', 'integrations/chatgpt/integration.mjs',
  'integrations/chatgpt/account.mjs', 'integrations/chatgpt/account-browser.mjs', 'integrations/chatgpt/config.host-account.example.mjs',
  'integrations/chatgpt/deploy/prepare.mjs', 'integrations/chatgpt/deploy/preflight.mjs',
  'integrations/chatgpt/deploy/stage-bridge.mjs', 'integrations/chatgpt/deploy/common.mjs',
  'integrations/chatgpt/deploy/README.md', 'integrations/chatgpt/deploy/settings.example.json',
  'bridge-template/session.mjs', 'bridge-template/bridge-session.mjs'];
const fail = (code, message = code) => { throw Object.assign(Error(message), { code }); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const within = (parent, child) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };

/** No shell interpolation and no child output, credentials or environment in errors. */
async function execute(command, args, { cwd, env, logFile } = {}) {
  try {
    if (!logFile) return await promisify(execFile)(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const log = await open(logFile, 'wx', 0o600);
    try {
      await new Promise((accept, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
        child.once('error', reject);
        child.once('close', code => code === 0 ? accept() : reject(Error('Command failed')));
      });
      return { stdout: '' };
    } finally { await log.close(); }
  } catch { fail('RELEASE_COMMAND_FAILED', 'A release build command failed; inspect the private build logs.'); }
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function safeName(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /[\\\x00-\x1f\x7f]/u.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..')) fail('RELEASE_PATH_INVALID');
  return name;
}
async function regularFiles(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = safeName(prefix ? prefix + '/' + entry.name : entry.name), path = join(root, name);
    if (entry.isSymbolicLink()) fail('RELEASE_SYMLINK_UNSUPPORTED');
    if (entry.isDirectory()) files.push(...await regularFiles(root, name));
    else if (entry.isFile() && (await lstat(path)).isFile()) files.push(name);
    else fail('RELEASE_NONREGULAR_FILE');
  }
  return files;
}
async function copyRegular(source, destination) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) fail('RELEASE_NONREGULAR_FILE');
  await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination);
}

export async function inspectSource(directory, expected, { run = execute, env = process.env } = {}) {
  if (!SHA.test(expected ?? '')) fail('RELEASE_EXACT_REF_REQUIRED');
  const path = await realpath(directory);
  const git = async args => (await run('git', args, { cwd: path, env })).stdout.trim();
  if (await git(['rev-parse', '--show-toplevel']) !== path || await git(['rev-parse', 'HEAD']) !== expected)
    fail('RELEASE_SOURCE_REF_MISMATCH', 'The supplied source must be checked out at the exact requested commit.');
  if (await git(['status', '--porcelain=v1', '--untracked-files=all']))
    fail('RELEASE_SOURCE_DIRTY', 'Commit source changes and build from a clean exact revision.');
  const sourceTree = await git(['rev-parse', 'HEAD^{tree}']);
  if (!SHA.test(sourceTree)) fail('RELEASE_SOURCE_TREE_INVALID');
  return { directory: path, source: expected, sourceTree, dirty: false };
}

/** Both npm's package/ layout and the public GNU-tar ./ layout are supported. */
export async function unpackPublicArchive(archive, destination, { run = execute, env = process.env } = {}) {
  const listing = (await run('tar', ['-tzf', archive], { env })).stdout.trim().split('\n');
  if (!listing.length || listing.length > 25000) fail('RELEASE_ARCHIVE_INVALID');
  const names = listing.map(name => name.replace(/^\.\//u, '').replace(/\/$/u, '')).filter(name => name && name !== '.');
  for (const name of names) safeName(name);
  const prefixed = names.includes('package/package.json');
  if (prefixed ? names.some(name => name !== 'package' && !name.startsWith('package/')) : !names.includes('package.json'))
    fail('RELEASE_ARCHIVE_LAYOUT_INVALID');
  const types = (await run('tar', ['-tvzf', archive], { env })).stdout.trim().split('\n');
  if (types.some(line => !['-', 'd'].includes(line[0]))) fail('RELEASE_ARCHIVE_LINK_UNSUPPORTED');
  await mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', destination,
    ...(prefixed ? ['--strip-components=1'] : [])], { env });
  await regularFiles(destination);
}

function proofIdentity(proof, expected, format) {
  if (format && proof.format !== format || proof.source !== expected.source || proof.sourceTree !== expected.sourceTree || proof.dirty !== false)
    fail('RELEASE_ARTIFACT_PROVENANCE_INVALID');
}
async function packageIdentity(directory, name) {
  const value = await json(join(directory, 'package.json'));
  const peers = Object.entries(value.peerDependencies ?? {}), metadata = value.peerDependenciesMeta ?? {};
  // The optional SDK collaboration entry consumes the exact session archive
  // installed and verified below. This is the only permitted runtime peer;
  // nothing here asks npm to resolve another version or dependency graph.
  const optionalSessionPeer = name === '@tendriller/core' && peers.length === 1 && peers[0][0] === '@chronolog/peer-session' && peers[0][1] === '*' &&
    Object.keys(metadata).length === 1 && metadata['@chronolog/peer-session']?.optional === true &&
    Object.keys(metadata['@chronolog/peer-session']).length === 1;
  if (value.name !== name || Object.keys(value.dependencies ?? {}).length || Object.keys(value.optionalDependencies ?? {}).length ||
      (peers.length || Object.keys(metadata).length) && !optionalSessionPeer)
    fail('RELEASE_PUBLIC_PACKAGE_INVALID', 'The release requires the self-contained public SDK and events-only native session packages.');
  return value;
}

/** Assemble public bytes only; sealRelease is deliberately separate from the test gate. */
export async function assembleRelease({ core, chronolog, destination, env }, { run = execute } = {}) {
  const coreProof = await json(join(core.directory, 'dist/provenance.json'));
  proofIdentity(coreProof, core);
  const version = (await json(join(core.directory, 'package.json'))).version;
  if (typeof version !== 'string' || !/^[A-Za-z0-9.+-]+$/u.test(version)) fail('RELEASE_VERSION_INVALID');
  const files = (await run('git', ['ls-files', '-z', '--', 'integrations/chatgpt'], { cwd: core.directory, env })).stdout.split('\0').filter(Boolean);
  if (!files.length) fail('RELEASE_INTEGRATION_MISSING');
  for (const path of files) {
    safeName(path);
    if (!path.startsWith('integrations/chatgpt/') || path.split('/').some(part => ['node_modules', '.tendriller', '.git'].includes(part)) ||
        /\.(?:sqlite|sqlite-wal|sqlite-shm|db)$/u.test(path)) fail('RELEASE_PRIVATE_INPUT');
    await copyRegular(join(core.directory, path), join(destination, path));
  }
  const archives = {};
  for (const kind of ['sdk', 'runtime', 'engine']) {
    const file = `tendriller-${kind}-${version}.tgz`, expected = coreProof.artifacts?.find(value => value.file === file)?.sha256;
    const source = join(core.directory, 'dist', file);
    if (!HASH.test(expected ?? '') || await hashFile(source) !== expected) fail('RELEASE_ARCHIVE_DIGEST_MISMATCH');
    await copyRegular(source, join(destination, 'archives', file));
    archives[kind] = { file: 'archives/' + file, sha256: expected };
  }
  const toolsProof = await json(join(core.directory, 'dist/tools-manifest.json'));
  const toolsFile = `tendriller-tools-${version}.tgz`, toolsHash = toolsProof.artifacts?.find(value => value.file === toolsFile)?.sha256;
  if (toolsProof.source_commit !== core.source || toolsProof.version !== version || !HASH.test(toolsHash ?? '') ||
      await hashFile(join(core.directory, 'dist', toolsFile)) !== toolsHash) fail('RELEASE_ARTIFACT_PROVENANCE_INVALID');
  await copyRegular(join(core.directory, 'dist', toolsFile), join(destination, 'archives', toolsFile));
  archives.tools = { file: 'archives/' + toolsFile, sha256: toolsHash };
  await copyRegular(join(core.directory, 'dist/provenance.json'), join(destination, 'archives/core-provenance.json'));
  await copyRegular(join(core.directory, 'dist/tools-manifest.json'), join(destination, 'archives/tools-provenance.json'));

  const chronoFile = `chronolog-peer-session-${CHRONOLOG_SOURCE.slice(0, 8)}.tgz`;
  const chronoArchive = join(chronolog.directory, 'artifacts/peer-session', chronoFile);
  await copyRegular(chronoArchive, join(destination, 'archives', chronoFile));
  archives.chronolog = { file: 'archives/' + chronoFile, sha256: await hashFile(chronoArchive) };
  const integration = join(destination, 'integrations/chatgpt');
  const sdk = join(integration, 'node_modules/@tendriller/core'), session = join(integration, 'node_modules/@chronolog/peer-session');
  // The locked runtime dependency is installed before these public packages;
  // npm must never substitute a registry SDK or prune these exact archive bytes.
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: integration, env, logFile: join(dirname(core.directory), 'logs/runtime-dependencies.log') });
  await unpackPublicArchive(join(destination, archives.sdk.file), sdk, { run, env });
  await unpackPublicArchive(join(destination, archives.chronolog.file), session, { run, env });
  await packageIdentity(sdk, '@tendriller/core'); await packageIdentity(session, '@chronolog/peer-session');
  const chronoProof = await json(join(session, 'provenance.json'));
  proofIdentity(chronoProof, chronolog, 'chronolog-peer-session-package/v1');
  if (chronoProof.optionalNativeRtc !== false || !Array.isArray(chronoProof.sqlEngines) || chronoProof.sqlEngines.length ||
      !chronoProof.sha256 || typeof chronoProof.sha256 !== 'object') fail('RELEASE_NATIVE_PROFILE_INVALID');
  const expectedFiles = Object.keys(chronoProof.sha256).sort();
  if (JSON.stringify((await regularFiles(session)).filter(name => name !== 'provenance.json').sort()) !== JSON.stringify(expectedFiles))
    fail('RELEASE_NATIVE_PACKAGE_CHANGED');
  for (const name of expectedFiles) if (!HASH.test(chronoProof.sha256[name]) || await hashFile(join(session, safeName(name))) !== chronoProof.sha256[name])
    fail('RELEASE_NATIVE_PACKAGE_CHANGED');
  await copyRegular(join(session, 'provenance.json'), join(destination, 'archives/chronolog-provenance.json'));

  const template = join(destination, 'bridge-template');
  await mkdir(template, { recursive: true });
  for (const name of TEMPLATE_FILES) await copyRegular(join(integration, 'examples/kitchen', name), join(template, name));
  await writeFile(join(template, 'package.json'), JSON.stringify({ name: 'tendriller-assistant-bridge-runtime', private: true,
    type: 'module', engines: { node: '>=24' } }, null, 2) + '\n');
  for (const [from, name] of [[sdk, '@tendriller/core'], [session, '@chronolog/peer-session']])
    for (const path of await regularFiles(from)) await copyRegular(join(from, path), join(template, 'node_modules', name, path));
  for (const name of REQUIRED) if (!(await lstat(join(destination, name))).isFile()) fail('RELEASE_INCOMPLETE');
  return { archives, nativePackage: session };
}

export async function sealRelease(directory, { core, chronolog, archives, checks, toolchain }) {
  if (core.dirty !== false || chronolog.dirty !== false || chronolog.source !== CHRONOLOG_SOURCE ||
      checks?.nativeIntegration?.passed !== true || checks.nativeIntegration.skipped !== 0 ||
      checks.hostAccountIntegration?.passed !== true || checks.runtimeImports !== true)
    fail('RELEASE_QUALIFICATION_REQUIRED');
  const files = {};
  for (const name of await regularFiles(directory)) {
    if (name === 'RELEASE.json') fail('RELEASE_ALREADY_SEALED');
    files[name] = await hashFile(join(directory, name));
  }
  if (Object.keys(files).length > 25000 || REQUIRED.some(name => !Object.hasOwn(files, name))) fail('RELEASE_INCOMPLETE');
  const identity = ({ source, sourceTree, dirty }) => ({ source, sourceTree, dirty });
  const manifest = { format: 'tendriller-assistant-release/v1', core: identity(core), chronolog: identity(chronolog),
    toolchain, archives, checks, files };
  await writeFile(join(directory, 'RELEASE.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

const IMPORT_SMOKE = `import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
const root = process.argv[1];
for (const [file, name] of [['integrations/chatgpt/integration.mjs','createIntegration'],
 ['integrations/chatgpt/account.mjs','createTendrillerAccountAdapter'], ['bridge-template/bridge-session.mjs','openSession']])
 assert.equal(typeof (await import(pathToFileURL(root + '/' + file).href))[name], 'function');
const native = await import(pathToFileURL(root + '/integrations/chatgpt/node_modules/@chronolog/peer-session/native.mjs').href);
assert.equal(typeof native.openNativeDevice, 'function');`;

export async function buildRelease({ coreSource, coreRef, chronologSource, output } = {}, { run = execute, onProgress = () => {} } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('RELEASE_NODE24_REQUIRED');
  if (![coreSource, chronologSource, output].every(value => typeof value === 'string' && isAbsolute(value)) || !SHA.test(coreRef ?? ''))
    fail('RELEASE_ARGUMENTS_INVALID', 'Use absolute source/output directories and a full core commit SHA.');
  const core = await inspectSource(coreSource, coreRef, { run }), chronolog = await inspectSource(chronologSource, CHRONOLOG_SOURCE, { run });
  const directory = join(await realpath(dirname(resolve(output))), basename(output));
  if ([core.directory, chronolog.directory].some(source => within(source, directory))) fail('RELEASE_OUTPUT_INSIDE_SOURCE');
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('RELEASE_OUTPUT_EXISTS'); throw error; }
  const build = join(directory, 'build'), staging = join(directory, 'release.pending');
  for (const name of ['logs', 'tmp', 'cache']) await mkdir(join(build, name), { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(['HOME', 'USER', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(env, { PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''), TMPDIR: join(build, 'tmp'),
    npm_config_cache: join(build, 'cache/npm'), COREPACK_HOME: join(build, 'cache/corepack'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', HUSKY: '0', CI: '1' });
  const step = async (name, command, args, cwd, extraEnv = {}) => {
    onProgress(name);
    await run(command, args, { cwd, env: { ...env, ...extraEnv }, logFile: join(build, 'logs', name + '.log') });
  };
  const clone = async (source, name) => {
    const target = join(build, name);
    await step('clone-' + name, 'git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--no-hardlinks', '--no-checkout', '--quiet', '--', source.directory, target], build);
    await step('checkout-' + name, 'git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', source.source], target);
    return inspectSource(target, source.source, { run, env });
  };
  const coreBuild = await clone(core, 'core'), chronoBuild = await clone(chronolog, 'chronolog');
  await step('core-dependencies', 'npm', ['ci', '--no-audit', '--no-fund'], coreBuild.directory);
  await step('core-public-artifacts', 'npm', ['run', 'build:artifacts'], coreBuild.directory);
  await inspectSource(coreBuild.directory, core.source, { run, env });
  await step('chronolog-dependencies', 'corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(build, 'cache/pnpm')], chronoBuild.directory);
  await step('chronolog-public-artifact', process.execPath, ['tools/package-peer-session.mjs'], chronoBuild.directory);
  await inspectSource(chronoBuild.directory, chronolog.source, { run, env });
  onProgress('assemble-public-release');
  const assembled = await assembleRelease({ core: coreBuild, chronolog: chronoBuild, destination: staging, env }, { run });
  await step('native-integration-gate', 'npm', ['run', 'test:chatgpt'], coreBuild.directory,
    { CHRONOLOG_SESSION_PACKAGE: assembled.nativePackage, NODE_OPTIONS: '--test-reporter=tap' });
  const report = await readFile(join(build, 'logs/native-integration-gate.log'), 'utf8');
  const count = name => Number([...report.matchAll(new RegExp('^# ' + name + ' ([0-9]+)$', 'gm'))].at(-1)?.[1] ?? NaN);
  if (!Number.isSafeInteger(count('tests')) || count('tests') < 1 || count('fail') !== 0 || count('cancelled') !== 0 || count('skipped') !== 0 || count('todo') !== 0)
    fail('RELEASE_NATIVE_GATE_INCOMPLETE', 'The native-enabled integration gate must pass without skips or pending tests.');
  const hostReportPath = join(build, 'logs/host-account-report.json');
  await step('host-account-integration-gate', 'npm', ['run', 'test:chatgpt:host', '--',
    '--engine-archive', join(staging, assembled.archives.engine.file), '--report', hostReportPath], coreBuild.directory);
  const hostReport = await json(hostReportPath);
  if (hostReport.status !== 'passed' || hostReport.qualification !== 'packed-worker-node-account-contract' ||
      hostReport.engine?.source !== core.source || hostReport.engine.dirty !== false ||
      hostReport.engine.sha256 !== assembled.archives.engine.sha256 || hostReport.node?.source !== core.source || hostReport.node.dirty !== false)
    fail('RELEASE_HOST_GATE_INCOMPLETE', 'The packaged host and Node account contract must pass against the exact clean release.');
  await copyRegular(hostReportPath, join(staging, 'qualification/host-account.json'));
  await step('release-imports', process.execPath, ['--input-type=module', '--eval', IMPORT_SMOKE, staging], staging);
  await inspectSource(coreBuild.directory, core.source, { run, env }); await inspectSource(chronoBuild.directory, chronolog.source, { run, env });
  const toolchain = { node: process.version, platform: process.platform, architecture: process.arch,
    npm: (await run('npm', ['--version'], { env })).stdout.trim(), pnpm: (await run('corepack', ['pnpm', '--version'], { env, cwd: chronoBuild.directory })).stdout.trim() };
  const checks = { nativeIntegration: { command: 'npm run test:chatgpt', passed: true, tests: count('tests'), skipped: 0 },
    hostAccountIntegration: { command: 'npm run test:chatgpt:host', passed: true,
      qualification: hostReport.qualification, report: 'qualification/host-account.json', engineSha256: hostReport.engine.sha256 }, runtimeImports: true };
  const manifest = await sealRelease(staging, { core, chronolog, archives: assembled.archives, checks, toolchain });
  await rename(staging, join(directory, 'release')); onProgress('release-ready');
  return { release: join(directory, 'release'), manifest: join(directory, 'release/RELEASE.json'), coreSource: core.source,
    chronologSource: chronolog.source, files: Object.keys(manifest.files).length, tests: count('tests'), liveChatGptVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { 'core-source': { type: 'string' }, 'core-ref': { type: 'string' },
      'chronolog-source': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log('Usage: node build-release.mjs --core-source DIR --core-ref 40SHA --chronolog-source DIR --output NEWDIR\nUse clean exact source checkouts and an existing output parent. No deployment or account action is performed.');
    else console.log(JSON.stringify(await buildRelease({ coreSource: values['core-source'], coreRef: values['core-ref'],
      chronologSource: values['chronolog-source'], output: values.output }, { onProgress: phase => console.log(JSON.stringify({ phase })) })));
  } catch (error) { console.error(JSON.stringify({ ready: false, code: error.code ?? 'RELEASE_BUILD_FAILED', message: 'Release build stopped; inspect private build logs. No deployment was performed.' })); process.exitCode = 1; }
}
