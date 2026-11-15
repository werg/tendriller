// Core owns the isolated Worker; the pinned public contrib checkout owns its
// browser suite. Neither implementation imports the other's private source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function integrationPin(lock, pairing) {
  assert.equal(lock.format, 'tendriller-composition');
  assert.equal(pairing.format, 'tendriller-release-pair');
  for (const key of ['contract', 'core', 'workflow'])
    assert.deepEqual(pairing[key], lock[key], `Rebuild the service: its ${key} pairing differs from composition.lock.json`);
  assert.match(lock.workflow.source_commit || '', /^[a-f0-9]{40}$/, 'The workflow must pin an exact public source commit');
  const artifact = new URL(lock.workflow.url);
  const source = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/releases\/download\/[^/]+\/[^/]+$/.exec(artifact.pathname);
  assert.ok(artifact.origin === 'https://github.com' && !artifact.username && !artifact.password && source,
    'The workflow artifact must identify its public GitHub release repository');
  return { repository: `${artifact.origin}/${source[1]}/${source[2]}.git`, commit: lock.workflow.source_commit };
}

export function runIntegration(root = resolve(import.meta.dirname, '..')) {
  const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const pin = integrationPin(readJson('composition.lock.json'), readJson('dist/service/pairing.json'));
  const checkout = mkdtempSync(join(tmpdir(), 'tendriller-contrib-integration-'));
  const env = { ...process.env, SOURCE_COMMIT: pin.commit,
    TENDRILLER_E2E_SERVICE: 'https://service.localhost:8790',
    TENDRILLER_E2E_OWNER: 'owner@example.test',
    TENDRILLER_E2E_OWNER_TOKEN: 'tendriller-local-e2e-session',
    TENDRILLER_E2E_OTHER_TOKEN: 'tendriller-local-e2e-other-session' };
  const run = (program, args) => execFileSync(program, args, { cwd: checkout, env, stdio: 'inherit' });
  try {
    console.log(`Testing composed service with public contrib source ${pin.repository}@${pin.commit}`);
    run('git', ['init', '--quiet']);
    run('git', ['fetch', '--quiet', '--depth=1', pin.repository, pin.commit]);
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), pin.commit);
    run('npm', ['ci']);
    run('npm', ['run', 'build']);
    const playwright = join(checkout, 'node_modules/@playwright/test/cli.js');
    run(process.execPath, [playwright, 'install', 'chromium']);
    // Extend the contrib-owned config inside its disposable checkout so tests
    // and configuration resolve the same installed Playwright package.
    const config = join(checkout, 'test/e2e/core-service.config.ts');
    writeFileSync(config, `import config from './playwright.config.ts';
export default { ...config,
  outputDir: ${JSON.stringify(join(root, 'test-results/contrib-integration'))},
  webServer: {
    command: 'node scripts/e2e-server.mjs --entry dist/service/worker.mjs',
    cwd: ${JSON.stringify(root)},
    url: 'https://service.localhost:8790/health',
    ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 120000,
    stdout: 'pipe', stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }
  }
};
`);
    run(process.execPath, [playwright, 'test', '--config', config]);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runIntegration();
