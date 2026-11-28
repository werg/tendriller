import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checklist, intake } from './specimens/sql-domains.mjs';
import { publishAssetGraph, type PublishedAssets } from './publication-helpers';
import type { PageClient } from '../../dist/sdk/client.mjs';

type Peers = PageClient['peers'];
type Fixture = { page: Page; name: string; id: string };
type CapabilityReport = {
  secureContext: boolean;
  dedicatedWorker: boolean;
  events: { supported: boolean; reason?: string };
  indexedDb: { supported: boolean; writable: boolean };
};

export async function openBrowserSqlSpecimen(options: {
  consumer?: string; engineDirectory?: string; peers: Peers; pageUrl: string; applicationId: string;
  pages: [Page, Page]; isPrivate: boolean; guestAccount: string;
}) {
  const { consumer, peers, pageUrl, applicationId, pages, isPrivate } = options;
  const packageRoot = consumer
    ? resolve(consumer, 'node_modules/@chronolog/peer-session')
    : resolve('node_modules/@chronolog/peer-session');
  const load = (path: string) => import(pathToFileURL(resolve(packageRoot, path)).href);
  const log = await load('index.mjs');
  const source = 'test/e2e/specimens';
  const outdir = resolve('.tmp-browser-sql-specimen');
  const common = {
    bundle: true,
    platform: 'browser' as const,
    format: 'esm' as const,
    write: false,
    minify: true,
    outdir,
    loader: { '.wasm': 'file' as const },
    assetNames: 'assets/[name]-[hash]',
    alias: {
      '@tendriller/core/peers': resolve('dist/sdk/peers.mjs'),
      '@tendriller/core/authority': resolve('dist/sdk/authority.mjs'),
      '@tendriller/core/browser-owner': resolve('session/browser.mjs'),
      '@tendriller/core/worker-owner': resolve('session/worker.mjs'),
      '@chronolog/peer-session': resolve(packageRoot, 'index.mjs'),
      '@chronolog/peer-session/browser': resolve(packageRoot, 'browser.mjs'),
      '@chronolog/peer-session/worker': resolve(packageRoot, 'worker.mjs'),
      '@chronolog/peer-session/websocket': resolve(packageRoot, 'websocket.mjs'),
      '@chronolog/peer-session/webrtc': resolve(packageRoot, 'webrtc.mjs'),
      '@chronolog/peer-session/sqlite-cas.wasm': resolve(packageRoot, 'wasm/sqlite-cas.wasm'),
    },
  };
  const [worker, ui] = await Promise.all([
    build({ ...common, entryPoints: { 'browser-sql-worker': `${source}/browser-sql-worker.mjs` } }),
    build({ ...common, entryPoints: { 'browser-sql': `${source}/browser-sql.mjs` } }),
  ]);
  const workerEntry = worker.outputFiles.find(file => file.path.endsWith('browser-sql-worker.js'))!;
  const workerCode = workerEntry.text;
  const fixtures: Fixture[] = [];
  for (const page of pages) {
    const name = randomUUID(), bootstrap = new URL('acceptance-identity.mjs', pageUrl).href;
    await page.route(bootstrap, route => route.fulfill({ contentType: 'text/javascript', body: workerCode }));
    try {
      const { id, report } = await page.evaluate(({ bootstrap, name }) => new Promise<{
        id: string; report: CapabilityReport;
      }>((resolve, reject) => {
        const worker = new Worker(bootstrap, { type: 'module' });
        const finish = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { finish(); reject(new Error('Browser capability and identity checks timed out')); }, 20_000);
        let report: CapabilityReport | undefined;
        worker.onerror = event => { finish(); reject(new Error(event.message)); };
        worker.onmessage = ({ data }) => {
          if (data.type === 'capabilities') {
            report = data.report;
            if (report?.events.supported) {
              worker.postMessage({ type: 'identity', name });
              return;
            }
            finish();
            reject(new Error('Browser prerequisites unavailable: ' + (report?.events.reason ?? 'unsupported')));
            return;
          }
          finish();
          if (data.type === 'identity' && report) resolve({ id: data.id, report });
          else reject(new Error(data.message));
        };
        worker.postMessage({ type: 'capabilities' });
      }), { bootstrap, name });
      expect(report.secureContext).toBe(true);
      expect(report.dedicatedWorker).toBe(true);
      expect(report.indexedDb).toEqual({ supported: true, writable: true });
      fixtures.push({ page, name, id });
    } finally {
      await page.unroute(bootstrap);
    }
  }
  const [first, second] = fixtures;
  const signer = await log.createSigningIdentity();
  const definition = isPrivate ? intake(log, first.id) : checklist(log);
  const key = new Uint8Array(randomBytes(32));
  const prepared = await peers.prepare({
    executionProfile: 'chronolog-v2-sqlite',
    publisherKeys: [signer.publicKey],
    tools: log.describeApplication(definition),
  });
  expect(prepared.selection.id).toBe(applicationId);
  expect(prepared.configuration?.publisherKeys).toEqual([signer.publicKey]);
  expect(prepared.genesis, 'No browser has created the page data yet').toBeNull();

  const assets: PublishedAssets = {
    'index.html': { type: 'text/html', body: await readFile(`${source}/browser-sql.html`) },
  };
  for (const output of [...ui.outputFiles, ...worker.outputFiles]) {
    let rel = relative(outdir, output.path).replaceAll('\\', '/');
    if (rel === 'browser-sql.js') rel = 'browser-sql.mjs';
    else if (rel === 'browser-sql-worker.js') rel = 'browser-sql-worker.mjs';
    const type = rel.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    assets[rel] = { type, body: output.contents };
  }
  await publishAssetGraph(peers, signer, assets, 'index.html');
  await Promise.all(pages.map(page => expect(page.getByRole('heading', { name: 'Shared work' })).toBeVisible({ timeout: 25_000 })));

  for (const fixture of fixtures) {
    await fixture.page.waitForFunction(() => typeof (window as any).prepareAcceptanceSession === 'function');
    await fixture.page.evaluate(async input => (window as any).prepareAcceptanceSession({ ...input, key: new Uint8Array(input.key) }),
      { name: fixture.name, key: Array.from(key), respondent: isPrivate ? first.id : undefined,
        members: fixture === first ? fixtures.map(item => item.id) : undefined });
  }
  await first.page.evaluate(() => (window as any).initializeAcceptanceApplication());
  const open = async (fixture: Fixture, remote?: string, channel?: string) => {
    await fixture.page.waitForFunction(() => typeof (window as any).openAcceptanceSession === 'function');
    await fixture.page.evaluate(async input => (window as any).openAcceptanceSession({ ...input, key: new Uint8Array(input.key) }),
      { name: fixture.name, remote, channel, key: Array.from(key), respondent: isPrivate ? first.id : undefined });
    await expect(fixture.page.getByRole('status').first()).toHaveText('Ready');
  };
  const pair = () => {
    const channel = randomUUID();
    return Promise.all([open(first, second.id, channel), open(second, first.id, channel)]);
  };
  await pair();
  const created = await peers.application();
  expect(created.genesis).not.toBeNull();
  return {
    async reopenFirst() {
      const context = first.page.context();
      await first.page.close();
      first.page = await context.newPage();
      await first.page.goto(pageUrl);
      await open(first);
      return first.page;
    },
    async reconnect() {
      const channel = randomUUID();
      await Promise.all([[first, second], [second, first]].map(([local, remote]) => local.page.evaluate(
        input => (window as any).reconnectAcceptanceSession(input.channel, input.remote), { channel, remote: remote.id })));
    },
  };
}
