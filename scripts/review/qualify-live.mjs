import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { importReviewPackages, reviewInstallArguments, verifyInstalledReviewPackages } from './packages.mjs';
import { chromium } from '@playwright/test';
import { readWithAdmissionRetry } from './read.mjs';
import { readReviewAccess, authorizeReview } from './access.mjs';
import { recordReview } from './record.mjs';
import { preflightReviewDeployment, reviewComposition, reviewProvenance } from './preflight.mjs';
import { cleanupFixturePage, installReviewFixtureSources, readFixtureHandle } from './fixture.mjs';
import { connectHostedReview, readHostedGrants, reviewGrantId } from './hosted.mjs';
import { sourceIdentity } from '../release-composition.mjs';
import { createReviewDiagnostics, reviewError, reviewNativeError } from './diagnostics.mjs';

const { values } = parseArgs({ options: { access: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, 'artifact-root': { type: 'string' }, 'no-video': { type: 'boolean', default: false } } });
if (!values.access || !values.config || !values.output) throw Error('Pass --access PRIVATE_JSON --config WRANGLER_CONFIG --output REPORT_DIRECTORY [--no-video] [--artifact-root EXACT_CLEAN_DEPLOYED_CHECKOUT]');
const consumerRoot = resolve(import.meta.dirname, '../..'), artifactRoot = resolve(values['artifact-root'] ?? consumerRoot), accessPath = resolve(values.access), config = resolve(values.config), output = resolve(values.output);
const access = readReviewAccess(accessPath), composition = reviewComposition(artifactRoot), consumerSource = sourceIdentity(consumerRoot);
assert.equal(consumerSource.dirty, false, 'Diagnostic consumer source must be a clean checkpoint');
const { rawConfig } = createRequire(import.meta.url)('wrangler').experimental_readRawConfig({ config });
assert.equal(rawConfig.vars.PUBLIC_BASE, access.origin, 'Private account must match the selected deployment before any remote mutation');
const readiness = await preflightReviewDeployment(access.origin, composition);
const project = mkdtempSync(join(tmpdir(), 'tendriller-review-fixture-'));
let installedPackages, child, handle, creationAttempted = false, phase = 'install public packages', diagnostics, fixtureSources, browser, context, page;
const run = (args, env = {}) => {
  try { return execFileSync(process.execPath, ['review-app.mjs', ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); }
  catch { throw Error('Synthetic fixture step failed: ' + args[0] + '. Private child diagnostics were withheld.'); }
};
const delay = () => new Promise(done => setTimeout(done, 250));
mkdirSync(output, { recursive: true, mode: 0o700 });
try {
  writeFileSync(join(output, 'preflight.json'), JSON.stringify({ ...reviewProvenance(composition, readiness), consumerSource }, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  fixtureSources = Object.fromEntries(installReviewFixtureSources(consumerRoot, project).map(file => [file, createHash('sha256').update(readFileSync(join(project, file))).digest('hex')]));
  execFileSync('npm', reviewInstallArguments(composition), { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  installedPackages = verifyInstalledReviewPackages(project, composition);
  const { core: { createAgentClient } } = await importReviewPackages(project);
  // Admission may change during package installation. Observe it again without
  // overriding a pause; the setup request still enforces any subsequent race.
  await preflightReviewDeployment(access.origin, composition);
  phase = 'authorize linked account';
  // Account-linked setup names the owner from the real OAuth grant (tendrils:create). No owner identity is invented here.
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(!values['no-video'] ? { recordVideo: { dir: join(output, 'video'), size: { width: 1440, height: 1000 } } } : {}) });
  const authorized = await authorizeReview(context, access); page = authorized.page;
  phase = 'create fixture';
  creationAttempted = true;
  run(['setup', access.origin, 'Qualification checklist'], { REVIEW_ACCESS_TOKEN: authorized.token });
  handle = readFixtureHandle(project);
  assert(handle.id && handle.page_url && handle.application?.id, 'Setup must retain one granted page in the workspace');
  phase = 'prepare and publish before browser key';
  run(['init']); run(['build'], { REVIEW_ESBUILD_MODULE: pathToFileURL(createRequire(import.meta.url).resolve('esbuild')).href }); run(['publish']);
  const host = createAgentClient({ service: access.origin, token: handle.token }).page(handle.id, { applicationId: handle.application.id });
  const publication = await readWithAdmissionRetry(() => host.peers.publication());
  assert(publication, 'Verify the committed publication on the actual host');
  const prepared = await readWithAdmissionRetry(() => host.peers.application());
  assert.equal(prepared.authority, null, 'No browser root or data authority may exist before the signed page is published');
  assert(prepared.publicationAuthority, 'The publication policy must exist');
  assert(prepared.publicationAuthority.publisherKeys.includes(handle.signerPublicKey), 'Publication is signed by the workspace\'s one shared agent key; no separate page publisher exists');
  assert.notEqual((await host.info()).owner_account_id, null, 'An account-linked agent creates a page already owned by that account');
  assert(publication.publication.payload.files.some(file => file.path === 'domain.js'), 'Hosted MCP runs declared operations from the signed domain bundle');
  diagnostics = createReviewDiagnostics({ origin: access.origin, pageUrl: handle.page_url, apiUrl: host.base });
  diagnostics.attach(context, page);
  phase = 'initialize browser';
  try {
    diagnostics.step('initialize-browser');
    const opened = await page.goto(handle.page_url);
    if (opened?.status() >= 400) throw Object.assign(Error('REVIEW_PAGE_NAVIGATION_FAILED'), { status: opened.status() });
    diagnostics.step('wait-signed-page'); await page.getByRole('heading', { name: 'Review checklist' }).waitFor();
    // The browser creates its own identity, root and data key locally; no native process exists yet.
    await page.getByText('Local signing and storage ready', { exact: false }).waitFor({ timeout: 60000 });
    diagnostics.step('verify-publication');
    assert.equal((await readWithAdmissionRetry(() => host.peers.publication())).publication.id, publication.publication.id);
    assert.notEqual((await readWithAdmissionRetry(() => host.peers.application())).authority, null, 'The signed-in browser initialized application authority');
    phase = 'start optional participant';
    diagnostics.step('start-participant');
    const state = openSync(join(project, 'participant-state-private.log'), 'w', 0o600), diagnostic = openSync(join(project, 'participant-private.log'), 'w', 0o600);
    // The one long-running local program is the installed tools archive's agent: it opens this initialized page's optional native owner.
    try { child = spawn(process.execPath, [join(project, 'node_modules/@tendriller/tools/bin/tendril.mjs'), 'agent', 'run'],
      { cwd: project, env: { ...process.env, TENDRIL_WORKSPACE: project }, stdio: ['ignore', state, diagnostic] }); }
    finally { closeSync(state); closeSync(diagnostic); }
    let participantError;
    child.once('error', () => { participantError = true; });
    // No copied request or package: the online browser admits the agent from the host's signed attestation for its
    // creator grant and wraps the page keys to it; the agent reports authoring once it holds them.
    diagnostics.step('admit-agent');
    const deadline = Date.now() + 90000;
    for (;;) {
      assert(Date.now() < deadline, 'Agent admission deadline');
      assert(!participantError && child.exitCode === null, 'Optional participant must remain running');
      if (readFileSync(join(project, 'participant-state-private.log'), 'utf8').split('\n').some(line => { try { const value = JSON.parse(line); return value.page === handle.id && value.canAuthor === true; } catch { return false; } })) break;
      await delay();
    }
    await page.locator('#devices').getByText('@review-fixture', { exact: false }).first().waitFor({ timeout: 30000 });
    phase = 'connect hosted MCP';
    // The owner opts this page into hosted MCP for exactly this run's OAuth grant. The hosted participant uses its own
    // enrolled key and wrapped epoch keys; the optional native participant above is not its provider.
    const grantId = reviewGrantId(authorized.token);
    await connectHostedReview({ page, grantId, handle: 'reviewer', step: value => diagnostics.step(value) });
    diagnostics.step('verify-connection-after-reload');
    await page.reload(); await page.getByText('Local signing and storage ready', { exact: false }).waitFor({ timeout: 60000 });
    const retained = await readHostedGrants(page);
    assert(retained.connections.some(row => row.grant === grantId && row.handle === 'reviewer'), 'The owner\'s hosted MCP opt-in survives reload');
    await diagnostics.capture(page);
  } catch (error) { await diagnostics.capture(page); throw error; }
  phase = 'native MCP qualification';
  const report = await recordReview({ project, accessPath, output, composition, video: !values['no-video'], browser, context, page, token: authorized.token });
  report.publishedBeforeBrowserKey = true;
  report.browserWithoutNativeProcess = true;
  report.hostedConnectionSurvivesReload = true;
  report.workspace = { credential: 'account-level register_agent through the linked account', signer: 'one shared workspace key', pageAccess: 'creator grant', admission: 'agent admitted from its signed host grant by the online browser', publisher: 'the shared key', participant: 'tendril agent run, optional', hostedMcp: 'owner opt-in for this run\'s OAuth grant' };
  report.fixtureSources = fixtureSources;
  report.installedPackages = installedPackages;
  report.consumerSource = consumerSource;
  report.browserReview = diagnostics?.snapshot();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Native MCP qualification passed all packaged cases; recording and sanitized report saved.');
} catch (error) {
  // A failed run never publishes its raw browser recording; only a completed qualification saves one.
  try { await context?.close(); } catch {}
  rmSync(join(output, 'video'), { recursive: true, force: true });
  let nativeErrorCode;
  try { nativeErrorCode = reviewNativeError(readFileSync(join(project, 'participant-private.log'), 'utf8'), child?.exitCode); } catch {}
  if (!nativeErrorCode) nativeErrorCode = child?.exitCode != null ? 'EXIT_' + child.exitCode : undefined;
  writeFileSync(join(output, 'fixture-failure.json'), JSON.stringify({ passed: false, phase, consumerSource, fixtureSources, nativeErrorCode, error: reviewError(error), nativeProcess: { started: Number.isInteger(child?.pid), running: Number.isInteger(child?.pid) && child.exitCode === null, exitCode: Number.isInteger(child?.exitCode) ? child.exitCode : null }, browser: diagnostics?.snapshot() }, null, 2), { mode: 0o600 });
  throw Error('Live qualification failed. See the sanitized reports' + (nativeErrorCode ? ' (native ' + nativeErrorCode + ')' : '') + '. No private child diagnostics were printed.');
} finally {
  const failures = [];
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
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
      report.consumerSource = consumerSource;
      report.fixtureSources = fixtureSources;
      if (failures.length) { report.passed = false; report.cleanupErrors = failures; }
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (failures.length) throw Error(failures.join('; ') + '. Private recovery files retained at ' + project);
  rmSync(project, { recursive: true, force: true });
}
