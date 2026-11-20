import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { importReviewPackages } from './packages.mjs';
import { chromium } from '@playwright/test';
import { readWithAdmissionRetry } from './read.mjs';
import { readReviewAccess } from './access.mjs';
import { recordReview } from './record.mjs';
import { preflightReviewDeployment, reviewComposition, reviewProvenance } from './preflight.mjs';
import { cleanupFixturePage } from './fixture.mjs';

const { values } = parseArgs({ options: { access: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, 'no-video': { type: 'boolean', default: false } } });
if (!values.access || !values.config || !values.output) throw Error('Pass --access PRIVATE_JSON --config WRANGLER_CONFIG --output REPORT_DIRECTORY [--no-video]');
const root = resolve(import.meta.dirname, '../..'), accessPath = resolve(values.access), config = resolve(values.config), output = resolve(values.output);
const access = readReviewAccess(accessPath), composition = reviewComposition(root);
const { rawConfig } = createRequire(import.meta.url)('wrangler').experimental_readRawConfig({ config });
assert.equal(rawConfig.vars.PUBLIC_BASE, access.origin, 'Private account must match the selected deployment before any remote mutation');
const readiness = await preflightReviewDeployment(access.origin, composition);
const project = mkdtempSync(join(tmpdir(), 'tendriller-review-fixture-'));
let child, handle, creationAttempted = false, phase = 'install public packages';
const run = args => {
  try { return execFileSync(process.execPath, ['review-app.mjs', ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw Error('Synthetic fixture step failed: ' + args[0] + '. Private child diagnostics were withheld.'); }
};
const delay = () => new Promise(done => setTimeout(done, 250));
mkdirSync(output, { recursive: true, mode: 0o700 });
try {
  writeFileSync(join(output, 'preflight.json'), JSON.stringify(reviewProvenance(composition, readiness), null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const name of ['review-app.mjs', 'review-domain.mjs']) copyFileSync(join(root, 'integrations/chatgpt/plugin', name), join(project, name));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    composition.packagePaths.sdk, composition.packagePaths.session], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  const { core: { createClient } } = await importReviewPackages(project);
  // Admission may change during package installation. Observe it again without
  // overriding a pause; the create request still enforces any subsequent race.
  await preflightReviewDeployment(access.origin, composition);
  phase = 'create fixture';
  creationAttempted = true;
  run(['create', accessPath, 'Qualification checklist']);
  handle = JSON.parse(readFileSync(join(project, '.private/handle.json')));
  phase = 'initialize application';
  run(['init']);
  const proposal = JSON.parse(run(['propose']));
  phase = 'publish before claim';
  const diagnostic = openSync(join(project, 'participant-private.log'), 'w', 0o600);
  try { child = spawn(process.execPath, ['review-app.mjs', 'run'], { cwd: project, stdio: ['ignore', 'ignore', diagnostic] }); }
  finally { closeSync(diagnostic); }
  const host = createClient(handle, { applicationId: handle.application.id });
  let participantError;
  child.once('error', () => { participantError = true; });
  // Wait for the consumer's atomic publication checkpoint locally. Polling its
  // host API during startup competes with its bounded control admission budget.
  const deadline = Date.now() + 30000;
  let published = false;
  while (!published) {
    assert(Date.now() < deadline, 'Preclaim publication deadline');
    assert(!participantError && child.exitCode === null, 'Synthetic participant must remain running');
    try { published = JSON.parse(readFileSync(join(project, '.private/pending-publication.json'))) === null; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!published) await delay();
  }
  const publication = await readWithAdmissionRetry(() => host.peers.publication());
  assert(publication, 'Verify the committed publication on the actual host');
  assert.equal((await host.info()).owner_account_id, null);
  phase = 'claim and review permissions';
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(access.loginUrl); await page.locator('input[name=token]').fill(access.code);
    await page.getByRole('button', { name: 'Open test account' }).click(); await page.waitForURL(access.origin + '/dashboard');
    await page.goto(handle.page_url); await page.getByRole('heading', { name: 'Review checklist' }).waitFor();
    assert.equal((await readWithAdmissionRetry(() => host.peers.publication())).publication.id, publication.publication.id);
    await page.goto(proposal.reviewUrl);
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
    await page.getByRole('button', { name: 'Approve selected permissions' }).click();
    const onlineDeadline = Date.now() + 25000;
    while (!(await (await context.request.get(proposal.reviewUrl)).text()).includes('Enrolled signer:')) { assert(Date.now() < onlineDeadline, 'Native participant deadline'); await delay(); }
  } finally { await browser.close(); }
  phase = 'native MCP qualification';
  const report = await recordReview({ project, accessPath, output, composition, video: !values['no-video'] });
  report.preclaimPublicationVerified = true;
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Native MCP qualification passed all packaged cases; recording and sanitized report saved.');
} catch (error) {
  let nativeErrorCode;
  try { nativeErrorCode = readFileSync(join(project, 'participant-private.log'), 'utf8').match(/code: ['"]([a-zA-Z0-9_]+)['"]/)?.[1]; } catch {}
  if (!nativeErrorCode) nativeErrorCode = child?.exitCode != null ? 'EXIT_' + child.exitCode : undefined;
  writeFileSync(join(output, 'fixture-failure.json'), JSON.stringify({ passed: false, phase, nativeErrorCode }, null, 2), { mode: 0o600 });
  throw Error('Live qualification failed. See the sanitized reports' + (nativeErrorCode ? ' (native ' + nativeErrorCode + ')' : '') + '. No private child diagnostics were printed.');
} finally {
  const failures = [];
  if (child?.pid && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  failures.push(...await cleanupFixturePage({ project, origin: access.origin, creationAttempted, handle }));
  for (const file of ['report.json', 'fixture-failure.json']) {
    const reportPath = join(output, file);
    try {
      const report = JSON.parse(readFileSync(reportPath));
      report.fixtureCleanup = failures.length === 0;
      if (failures.length) { report.passed = false; report.cleanupErrors = failures; }
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (failures.length) throw Error(failures.join('; ') + '. Private recovery files retained at ' + project);
  rmSync(project, { recursive: true, force: true });
}
