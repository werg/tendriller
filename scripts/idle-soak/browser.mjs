import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { boundedActive } from './state.mjs';
import { classifyTransport } from './classification.mjs';

export async function startBrowser(c, emit, { chromium, launchContext = launchResidentContext } = {}) {
  if (!chromium) ({ chromium } = await import('@playwright/test'));
  const { context, close } = await launchContext(c, chromium);
  let page, cover;
  const bytes = v => typeof v === 'string' ? Buffer.byteLength(v) : v?.length ?? 0;
  const pending = new Set();
  const activity = () => emit({ source: 'browser', kind: 'activity', pending: pending.size });
  context.on('request', request => { pending.add(request); activity(); emit({ source: 'browser', kind: 'requests', category: classifyTransport(request.url()) }); });
  const finished = request => { pending.delete(request); activity(); };
  context.on('requestfinished', finished); context.on('requestfailed', finished);
  context.on('page', p => p.on('websocket', ws => {
    const category = classifyTransport(ws.url());
    emit({ source: 'browser', kind: 'socketsOpened', category });
    ws.on('close', () => emit({ source: 'browser', kind: 'socketsClosed', category }));
    ws.on('framesent', e => { emit({ source: 'browser', kind: 'framesSent', category }); emit({ source: 'browser', kind: 'bytesSent', count: bytes(e.payload), category }); });
    ws.on('framereceived', e => { emit({ source: 'browser', kind: 'framesReceived', category }); emit({ source: 'browser', kind: 'bytesReceived', count: bytes(e.payload), category }); });
  }));
  cover = context.pages()[0] ?? await context.newPage();
  await cover.goto('about:blank');
  for (const p of context.pages().slice(1)) await p.close();
  const adapter = await import(pathToFileURL(c.adapter).href);
  if (typeof adapter.ready !== 'function' || typeof adapter.reconnect !== 'function') { await close(); throw Error('ADAPTER_READY_AND_RECONNECT_REQUIRED'); }
  const open = async () => {
    page = await context.newPage();
    await page.goto(c.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    await adapter.ready({ page, context, config: c });
  };
  return {
    context, adapter,
    async phase(phase) {
      if (phase === 'closed') { cover ??= await context.newPage(); if (page) await page.close(); page = undefined; return { observed: 'closed' }; }
      if (!page) await open();
      // Complete the coherent read while visible: real hidden tabs suspend
      // animation-frame driven interaction. Quiet hidden time performs no UI work.
      if (phase === 'background') { await adapter.settle?.({ page, context, config: c }); cover ??= await context.newPage(); await cover.goto('about:blank'); await cover.bringToFront(); }
      if (phase === 'foreground') { await cover?.close(); cover = undefined; await page.bringToFront(); }
      const expected = phase === 'background' ? 'hidden' : 'visible';
      await page.waitForFunction(value => document.visibilityState === value, expected, { timeout: 10000 });
      return { observed: await page.evaluate(() => document.visibilityState) };
    },
    async reconnect() {
      const started = Date.now();
      // Quiet time is over. Bring the actual app forward for user-style
      // reconnect/read verification; never emulate visibility in a hidden tab.
      await page.bringToFront();
      await page.waitForFunction(value => document.visibilityState === value, 'visible', { timeout: 10000 });
      // One explicit boundary outage; no network polling during the quiet phase.
      await context.setOffline(true);
      await context.setOffline(false);
      const outcome = await boundedActive((_attempt, signal) => adapter.reconnect({ page, context, config: c, signal }), { attempts: 3 });
      if (outcome !== true) throw Error('RECONNECT_NOT_VERIFIED');
      return { elapsedMs: Date.now() - started, verified: true };
    },
    async settle() { if (adapter.settle && page && await page.evaluate(() => document.visibilityState) === 'visible')
      await adapter.settle({ page, context, config: c }); },
    async close() { await close(); },
  };
}

// Playwright's normal launch enables focus emulation and disables background throttling.
// Attach to a dedicated real Chromium with public noDefaults instead, preserving actual residency.
export async function launchResidentContext(c, chromium) {
  const child = spawn(chromium.executablePath(), ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + c.browserProfile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--no-sandbox', ...(c.headless ? ['--headless=new'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  const stop = async () => {
    await browser?.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  };
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => done(Error('CHROMIUM_START_TIMEOUT')), 30000);
      const data = chunk => { buffer = (buffer + chunk.toString()).slice(-8192); const match = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/); if (match) done(null, match[1]); };
      const error = () => done(Error('CHROMIUM_START_FAILED'));
      const done = (failure, value) => { clearTimeout(timer); child.stderr.removeListener('data', data); child.removeListener('error', error); child.removeListener('exit', error); failure ? reject(failure) : resolve(value); };
      child.stderr.on('data', data); child.once('error', error); child.once('exit', error);
    });
    child.stderr.resume();
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 30000 });
    const context = browser.contexts()[0]; if (!context) throw Error('CHROMIUM_CONTEXT_MISSING');
    return { context, close: stop };
  } catch { await stop(); throw Error('RESIDENT_CHROMIUM_START_FAILED'); }
}
