import { pathToFileURL } from 'node:url';
import { boundedActive } from './state.mjs';

export async function startBrowser(c, emit, { chromium } = {}) {
  if (!chromium) ({ chromium } = await import('@playwright/test'));
  const context = await chromium.launchPersistentContext(c.browserProfile, { headless: c.headless ?? false, serviceWorkers: 'allow' });
  let page, cover;
  const bytes = v => typeof v === 'string' ? Buffer.byteLength(v) : v?.length ?? 0;
  context.on('request', () => emit({ source: 'browser', kind: 'requests' }));
  context.on('page', p => p.on('websocket', ws => {
    emit({ source: 'browser', kind: 'socketsOpened' });
    ws.on('close', () => emit({ source: 'browser', kind: 'socketsClosed' }));
    ws.on('framesent', e => { emit({ source: 'browser', kind: 'framesSent' }); emit({ source: 'browser', kind: 'bytesSent', count: bytes(e.payload) }); });
    ws.on('framereceived', e => { emit({ source: 'browser', kind: 'framesReceived' }); emit({ source: 'browser', kind: 'bytesReceived', count: bytes(e.payload) }); });
  }));
  for (const p of context.pages()) await p.close();
  const adapter = await import(pathToFileURL(c.adapter).href);
  if (typeof adapter.ready !== 'function' || typeof adapter.reconnect !== 'function') { await context.close(); throw Error('ADAPTER_READY_AND_RECONNECT_REQUIRED'); }
  const open = async () => {
    page = await context.newPage();
    await page.goto(c.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await adapter.ready({ page, context, config: c });
  };
  return {
    context, adapter,
    async phase(phase) {
      if (phase === 'closed') { if (page) await page.close(); page = undefined; return { observed: 'closed' }; }
      if (!page) await open();
      if (phase === 'background') { cover = await context.newPage(); await cover.goto('about:blank'); await cover.bringToFront(); }
      if (phase === 'foreground') { await cover?.close(); cover = undefined; await page.bringToFront(); }
      const expected = phase === 'background' ? 'hidden' : 'visible';
      await page.waitForFunction(value => document.visibilityState === value, expected, { timeout: 10000 });
      return { observed: await page.evaluate(() => document.visibilityState) };
    },
    async reconnect() {
      const started = Date.now();
      // One explicit boundary outage; no network polling during the quiet phase.
      await context.setOffline(true);
      await context.setOffline(false);
      const outcome = await boundedActive((_attempt, signal) => adapter.reconnect({ page, context, config: c, signal }), { attempts: 3 });
      if (outcome !== true) throw Error('RECONNECT_NOT_VERIFIED');
      return { elapsedMs: Date.now() - started, verified: true };
    },
    async settle() { if (adapter.settle) await adapter.settle({ page, context, config: c }); },
    async close() { await context.close(); },
  };
}
