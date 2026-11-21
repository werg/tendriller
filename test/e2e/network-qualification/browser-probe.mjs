import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createBrowserNetworkControls } from './browser-controls.mjs';
import { launchNetworkBrowser } from './browser-launch.mjs';

let requests = 0;
const server = createServer((_request, response) => {
  requests++;
  response.setHeader('Cache-Control', 'no-store');
  response.end('<!doctype html><title>Network control probe</title><button id="action">Save</button><script>window.ticks=0;window.actions=0;action.onclick=()=>actions++;setInterval(()=>ticks++,50);document.addEventListener("freeze",()=>window.frozenTicks=ticks);document.addEventListener("resume",()=>window.resumedTicks=ticks)</script>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { scope: 'browser-controls-only', applicationRecoveryQualified: false,
  startedAt: new Date().toISOString(), checks: [], backgroundSupported: false };
let browser;
let launched;
let controls;
let phase = 'launch';
async function mark(value) {
  phase = value;
  await writeFile('/evidence/browser-progress.json', JSON.stringify({ phase, at: new Date().toISOString() }) + '\n');
}
try {
  await mark('launch');
  launched = await launchNetworkBrowser(); browser = launched.browser;
  report.browser = browser.version();
  const context = launched.context;
  const page = await context.newPage(); await mark('navigation'); await page.goto(origin);
  await page.setViewportSize({ width: 390, height: 844 });
  controls = await createBrowserNetworkControls(page);
  const options = { signal: AbortSignal.timeout(10_000) };
  await mark('network-change');
  assert.equal((await controls.networkChange(options)).observed, true);
  report.checks.push('browser-network-information-change');
  await mark('offline-set');
  await controls.setOffline(true, options);
  await mark('offline-fetch');
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, origin), true);
  await controls.setOffline(false, options);
  await mark('online-fetch');
  assert.equal(await page.evaluate(async url => (await fetch(url)).ok, origin), true);
  report.checks.push('browser-offline-fetch-blocked-online-restored');
  await mark('freeze-start');
  await controls.setFrozen(true, options);
  await mark('freeze-hold');
  // Runtime evaluation can itself stall while a headed page is frozen. Capture
  // the timer count in actual lifecycle event handlers, without waking the page.
  await new Promise(resolve => setTimeout(resolve, 250));
  await mark('freeze-resume');
  await controls.setFrozen(false, options);
  await mark('freeze-read');
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  const frozen = await page.evaluate(() => ({ before: window.frozenTicks, after: window.resumedTicks }));
  assert.ok(Number.isInteger(frozen.before));
  assert.equal(frozen.after, frozen.before);
  await page.waitForFunction(previous => window.ticks > previous, frozen.after, { timeout: 5000 });
  report.checks.push('page-timers-freeze-resume');
  await mark('background');
  report.backgroundSupported = (await controls.background({ ...options, pauseMs: 100 })).hiddenObserved;
  await mark('foreground-actionability');
  const cover = await context.newPage(); await cover.bringToFront();
  assert.equal(await page.evaluate(() => document.hidden), true);
  await assert.rejects(page.locator('#action').click({ timeout: 500 }), /Timeout/);
  assert.equal(await page.evaluate(() => window.actions), 0);
  await page.bringToFront();
  await page.locator('#action').click({ timeout: 5000 });
  assert.equal(await page.evaluate(() => window.actions), 1);
  await cover.close();
  report.checks.push('hidden-tab-actionability-requires-foreground');
  // No timer activity or JS query during the closed HTTP idle segment.
  const initial = requests;
  await mark('idle');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(requests, initial);
  report.checks.push('closed-one-second-http-idle');
  report.modelTurns = null;
  report.success = true;
} catch {
  report.success = false; report.failure = 'NETWORK_LAB_BROWSER_PROBE_FAILED'; report.phase = phase; process.exitCode = 1;
} finally {
  try { await controls?.cleanup(); report.cleanup = true; }
  catch { report.cleanup = false; process.exitCode = 1; }
  await launched?.close(); server.close();
  report.finishedAt = new Date().toISOString();
  await writeFile('/evidence/browser-probe.json', JSON.stringify(report, null, 2) + '\n');
}
