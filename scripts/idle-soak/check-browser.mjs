// Explicit local-only headed Chromium qualification. No provider, app, enrollment or deployment calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from './browser.mjs';
const directory = mkdtempSync(join(tmpdir(), 'tendriller-soak-browser-'));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic soak qualification</title><main>Local fixture</main>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const adapter = join(directory, 'adapter.mjs');
  writeFileSync(adapter, 'export async function ready({page}){await page.locator("main").waitFor();} export async function reconnect({page}){await page.reload();await page.locator("main").waitFor();return true;}');
  const events = [];
  browser = await startBrowser({ browserProfile: join(directory, 'profile'), adapter, pageUrl: `http://127.0.0.1:${server.address().port}`, headless: false }, e => events.push(e));
  assert.equal((await browser.phase('closed')).observed, 'closed');
  assert.equal((await browser.phase('background')).observed, 'hidden');
  assert.equal((await browser.phase('foreground')).observed, 'visible');
  const result = await browser.reconnect(); assert.equal(result.verified, true);
  assert(events.some(x => x.kind === 'requests'));
  console.log('Real Chromium residency and measured reload reconnect passed against local synthetic HTTP fixture.');
} finally {
  await browser?.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true });
}
