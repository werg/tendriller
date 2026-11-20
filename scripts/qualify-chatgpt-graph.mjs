// Qualify the retained public graph without rebuilding core or Chronolog.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyRestoredDeployment } from './deployment-bundle.mjs';
import { packedArchive, sourceIdentity } from './release-composition.mjs';
import { assembleRelease, sealRelease, IMPORT_SMOKE, CHRONOLOG_SOURCE } from '../integrations/chatgpt/deploy/build-release.mjs';

const root = resolve(import.meta.dirname, '..');
verifyRestoredDeployment(root, process.env.TENDRILLER_EXPECTED_MANIFEST_SHA256);
const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json')));
const core = { ...sourceIdentity(root), directory: root };
const session = manifest.artifacts.find(item => item.role === 'session');
const proof = packedArchive(join(root, 'dist', session.file)).json('provenance.json');
assert.equal(proof.source, CHRONOLOG_SOURCE, 'Keep native qualification and composition pinned to the same session');
const scratch = mkdtempSync(join(tmpdir(), 'tendriller-chatgpt-graph-'));
const logRoot = join(root, '.results/chatgpt-graph');
mkdirSync(logRoot, { recursive: true });
const logs = mkdtempSync(join(logRoot, 'run-'));
const run = (name, args, env = {}) => {
  const output = execFileSync(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(logs, name + '.log'), output);
  return output;
};
try {
  const chronolog = { directory: join(scratch, 'chronolog'), source: proof.source, sourceTree: proof.sourceTree, dirty: false };
  const archiveDirectory = join(chronolog.directory, 'artifacts/peer-session');
  mkdirSync(archiveDirectory, { recursive: true });
  copyFileSync(join(root, 'dist', session.file), join(archiveDirectory, `chronolog-peer-session-${CHRONOLOG_SOURCE.slice(0, 8)}.tgz`));
  const destination = join(scratch, 'release');
  const assembled = await assembleRelease({ core, chronolog, destination, logDirectory: logs, env: process.env });
  const native = run('native-integration', ['--test', '--test-reporter=tap', 'integrations/chatgpt/test/*.test.mjs'], {
    CHRONOLOG_SESSION_PACKAGE: assembled.nativePackage,
  });
  const count = name => Number([...native.matchAll(new RegExp('^# ' + name + ' ([0-9]+)$', 'gm'))].at(-1)?.[1] ?? NaN);
  assert(Number.isSafeInteger(count('tests')) && count('tests') > 0);
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(count(name), 0, `Incomplete native gate: ${name}`);
  const hostPath = join(logs, 'host-account.json');
  run('host-account', ['scripts/test-chatgpt-host.mjs', '--engine-archive', join(root, 'dist', manifest.artifacts.find(item => item.role === 'engine').file), '--report', hostPath]);
  const host = JSON.parse(readFileSync(hostPath));
  assert.equal(host.status, 'passed');
  assert.equal(host.qualification, 'packed-worker-node-account-contract');
  assert.equal(host.engine.source, core.source); assert.equal(host.node.source, core.source);
  assert.equal(host.engine.dirty, false); assert.equal(host.node.dirty, false);
  assert.equal(host.engine.sha256, manifest.artifacts.find(item => item.role === 'engine').sha256);
  run('release-imports', ['--input-type=module', '--eval', IMPORT_SMOKE, destination]);
  const checks = { nativeIntegration: { passed: true, tests: count('tests'), skipped: 0 },
    hostAccountIntegration: { passed: true, qualification: host.qualification, engineSha256: host.engine.sha256 }, runtimeImports: true };
  await sealRelease(destination, { core, chronolog, archives: assembled.archives, checks,
    toolchain: { node: process.version, platform: process.platform, architecture: process.arch } });
  writeFileSync(join(logs, 'report.json'), JSON.stringify({ status: 'passed', source: core.source,
    compositionId: manifest.composition.id, manifestSha256: process.env.TENDRILLER_EXPECTED_MANIFEST_SHA256,
    sessionSha256: session.sha256, checks, limits: 'Synthetic local transports; live MCP remains a separate staging gate.' }, null, 2) + '\n');
  console.log(`Qualified ChatGPT native/host/import gates against composition ${manifest.composition.id}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
