import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { createClient } from '../../dist/sdk/client.mjs';
import { readReviewAccess } from './access.mjs';
import { recordReview } from './record.mjs';

const { values } = parseArgs({ options: { access: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, 'no-video': { type: 'boolean', default: false } } });
if (!values.access || !values.config || !values.output) throw Error('Pass --access PRIVATE_JSON --config WRANGLER_CONFIG --output REPORT_DIRECTORY [--no-video]');
const root = resolve(import.meta.dirname, '../..'), accessPath = resolve(values.access), config = resolve(values.config), output = resolve(values.output);
const access = readReviewAccess(accessPath), version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const { rawConfig } = createRequire(import.meta.url)('wrangler').experimental_readRawConfig({ config });
assert.equal(rawConfig.vars.PUBLIC_BASE, access.origin, 'Private account must match the selected deployment before any remote mutation');
const project = mkdtempSync(join(tmpdir(), 'tendriller-review-fixture-'));
let child, handle, opened = false, originalMode;
const db = sql => JSON.parse(execFileSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'ACCOUNTS', '--remote', '--config', config, '--json', '--command', sql], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
const run = args => {
  try { return execFileSync(process.execPath, ['review-app.mjs', ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw Error('Synthetic fixture step failed: ' + args[0] + '. Private child diagnostics were withheld.'); }
};
const delay = () => new Promise(done => setTimeout(done, 250));
mkdirSync(output, { recursive: true, mode: 0o700 });
try {
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const name of ['review-app.mjs', 'review-domain.mjs']) copyFileSync(join(root, 'integrations/chatgpt/plugin', name), join(project, name));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    join(root, `dist/tendriller-sdk-${version}.tgz`), join(root, 'test/artifacts/chronolog-peer-session-d3efeb6d.tgz')], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  originalMode = db('SELECT mode FROM service_state WHERE id=1').results[0]?.mode;
  assert(['open', 'creation_paused'].includes(originalMode));
  if (originalMode === 'creation_paused') {
    assert.equal(access.origin, 'https://staging.tendriller.dev', 'Only staging creation may be opened by the automated fixture');
    opened = db("UPDATE service_state SET mode='open' WHERE id=1 AND mode='creation_paused'").meta.changes === 1;
    assert(opened);
  }
  try { run(['create', accessPath, 'Qualification checklist']); }
  finally { if (opened) { db("UPDATE service_state SET mode='creation_paused' WHERE id=1 AND mode='open'"); opened = false; } }
  handle = JSON.parse(readFileSync(join(project, '.private/handle.json')));
  run(['init']);
  const proposal = JSON.parse(run(['propose']));
  child = spawn(process.execPath, ['review-app.mjs', 'run'], { cwd: project, stdio: ['ignore', 'ignore', 'ignore'] });
  const host = createClient(handle, { applicationId: handle.application.id });
  let participantError;
  child.once('error', () => { participantError = true; });
  let publication;
  const deadline = Date.now() + 30000;
  while (!(publication = await host.peers.publication())) { assert(Date.now() < deadline, 'Preclaim publication deadline'); assert(!participantError && child.exitCode === null, 'Synthetic participant must remain running'); await delay(); }
  assert.equal((await host.info()).owner_account_id, null);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(access.loginUrl); await page.locator('input[name=token]').fill(access.code);
    await page.getByRole('button', { name: 'Open test account' }).click(); await page.waitForURL(access.origin + '/dashboard');
    await page.goto(handle.page_url); await page.getByRole('heading', { name: 'Review checklist' }).waitFor();
    assert.equal((await host.peers.publication()).publication.id, publication.publication.id);
    await page.goto(proposal.reviewUrl);
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
    await page.getByRole('button', { name: 'Approve selected permissions' }).click();
    const onlineDeadline = Date.now() + 25000;
    while (!(await (await context.request.get(proposal.reviewUrl)).text()).includes('Enrolled signer:')) { assert(Date.now() < onlineDeadline, 'Native participant deadline'); await delay(); }
  } finally { await browser.close(); }
  const report = await recordReview({ project, accessPath, output, video: !values['no-video'] });
  report.preclaimPublicationVerified = true;
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Native MCP qualification passed all packaged cases; recording and sanitized report saved.');
} finally {
  const failures = [];
  if (child?.pid && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  if (handle) {
    try {
      const response = await fetch(handle.api, { method: 'DELETE', headers: { Authorization: 'Bearer ' + handle.token }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Synthetic page cleanup returned HTTP ' + response.status);
    } catch { failures.push('Could not delete the qualification-owned synthetic page'); }
  }
  if (opened) { try { db("UPDATE service_state SET mode='creation_paused' WHERE id=1 AND mode='open'"); } catch { failures.push('Could not restore staging creation mode'); } }
  if (failures.length) throw Error(failures.join('; ') + '. Private recovery files retained at ' + project);
  rmSync(project, { recursive: true, force: true });
}
