import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checklist, intake } from './specimens/sql-domains.mjs';
import type { PageClient } from '../../dist/sdk/client.mjs';

type Peers = PageClient['peers'];
type Fixture = { page: Page; name: string; id: string };
type CapabilityReport = {
  secureContext: boolean;
  dedicatedWorker: boolean;
  events: { supported: boolean; reason?: string };
  opfs: { syncAccessHandle: boolean };
  sql: { apiEligible: boolean; qualified: boolean; reason: string };
};

export async function openBrowserSqlSpecimen(options: {
  consumer: string; engineDirectory: string; peers: Peers; pageUrl: string; applicationId: string;
  pages: [Page, Page]; isPrivate: boolean; guestAccount: string;
}) {
  const { consumer, engineDirectory, peers, pageUrl, applicationId, pages, isPrivate } = options;
  const packageRoot = resolve(consumer, 'node_modules/@chronolog/peer-session');
  const load = (path: string) => import(pathToFileURL(resolve(packageRoot, path)).href);
  const [log, sqlBrowser] = await Promise.all([load('index.mjs'), load('sql-browser.mjs')]);
  const source = 'test/e2e/specimens';
  const common = { bundle: true, platform: 'browser' as const, format: 'esm' as const, write: false,
    minify: true,
    // The workspace carries an events-only package for the host. Pin both
    // browser bundles to the same SQL package used by the native fixture.
    alias: {
      '@tendriller/core/peers': resolve('dist/sdk/peers.mjs'),
      '@tendriller/core/authority': resolve('dist/sdk/authority.mjs'),
      '@tendriller/core/browser-owner': resolve('session/browser.mjs'),
      '@tendriller/core/worker-owner': resolve('session/worker.mjs'),
      '@chronolog/peer-session': resolve(packageRoot, 'index.mjs'),
      '@chronolog/peer-session/browser': resolve(packageRoot, 'browser.mjs'),
      '@chronolog/peer-session/worker': resolve(packageRoot, 'worker.mjs'),
      '@chronolog/peer-session/sql': resolve(packageRoot, 'sql.mjs'),
      '@chronolog/peer-session/sql-browser': resolve(packageRoot, 'sql-browser.mjs'),
      '@chronolog/peer-session/websocket': resolve(packageRoot, 'websocket.mjs'),
      '@chronolog/peer-session/webrtc': resolve(packageRoot, 'webrtc.mjs'),
    } };
  const [worker, ui] = await Promise.all([
    build({ ...common, entryPoints: [`${source}/browser-sql-worker.mjs`] }),
    build({ ...common, entryPoints: [`${source}/browser-sql.mjs`] }),
  ]);
  const workerCode = worker.outputFiles[0].text;
  const fixtures: Fixture[] = [];
  // Allocate identities in the real page origins before signing their initial
  // grants. Fulfill only this bootstrap URL. Application Workers and SQL
  // assets subsequently load from the authenticated signed publication.
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
            if (report?.events.supported && report.sql.apiEligible) {
              worker.postMessage({ type: 'identity', name });
              return;
            }
            finish();
            reject(new Error('Browser prerequisites unavailable: ' + (report?.events.reason ?? report?.sql.reason)));
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
      expect(report.opfs.syncAccessHandle).toBe(true);
      expect(report.sql.qualified).toBe(false, 'API eligibility is not SQL application qualification');
      fixtures.push({ page, name, id });
    } finally {
      await page.unroute(bootstrap);
    }
  }
  const [first, second] = fixtures;
  // Authority is not configured by this harness. The host signs it from the first enrolling browser's own
  // proof (that device becomes the root and administrator; an additional account-bound device enrolls into
  // the existing membership with the same explicitly test-provisioned data key), so the harness only
  // prepares publication: the independent publisher, the exact execution graph and the declared tools.
  const signer = await log.createSigningIdentity();
  const definition = isPrivate ? intake(log, first.id) : checklist(log);
  const key = new Uint8Array(randomBytes(32));
  const engineManifest = JSON.parse(await readFile(resolve(engineDirectory, 'manifest.json'), 'utf8'));
  const execution = sqlBrowser.createDoltLiteExecutionManifest({ engineDigest: sqlBrowser.digestEngineManifest(engineManifest.nativeManifest) });
  const executionManifestDigest = log.bytesToHex((await log.executionManifestArtifacts(execution)).executionManifestDigest);
  const prepared = await peers.prepare({ executionManifestDigest, executionProfile: 'sql', publisherKeys: [signer.publicKey],
    tools: log.describeApplication(definition) });
  expect(prepared.selection.id).toBe(applicationId);
  expect(prepared.publicationAuthority.publisherKeys).toEqual([signer.publicKey]);
  expect(prepared.authority, 'No browser has enrolled yet, so no data authority exists').toBeNull();
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  const assetTypes = { 'manifest.json': 'application/json', 'sqlite3.mjs': 'text/javascript',
    'sqlite3.wasm': 'application/wasm', 'sqlite3-opfs-async-proxy.js': 'text/javascript' };
  const input: Record<string, { type: string; bytes: Uint8Array }> = {
    'index.html': { type: 'text/html', bytes: await readFile(`${source}/browser-sql.html`) },
    'browser-sql.mjs': { type: 'text/javascript', bytes: ui.outputFiles[0].contents },
    'browser-sql-worker.mjs': { type: 'text/javascript', bytes: worker.outputFiles[0].contents },
  };
  for (const [name, type] of Object.entries(assetTypes)) {
    input[`engine/${name}`] = { type, bytes: await readFile(resolve(engineDirectory, name)) };
  }
  const files = [], assets = [];
  for (const path of Object.keys(input).sort()) {
    const { type, bytes } = input[path];
    const hash = sha256(bytes);
    files.push({ path, type, hash, size: bytes.length });
    assets.push({ hash, bytes: Buffer.from(bytes).toString('base64') });
  }
  const publication = await log.signPublicationManifest({ applicationId, membershipId: prepared.publicationAuthority.grantId,
    author: signer.publicKey, operationId: randomUUID(), revision: 0, previous: null, executionManifestDigest,
    entry: 'index.html', files }, signer);
  await peers.publish(publication, assets);
  await Promise.all(pages.map(page => expect(page.getByRole('heading', { name: 'Shared work' })).toBeVisible({ timeout: 25_000 })));
  // Metadata/device startup can differ across origins. Finish it on both sides
  // before starting either bounded physical connection; a peer's network-read
  // latency must not consume the other peer's relay opening deadline.
  // This SQL specimen deliberately wires a one-shot relay, without participate().
  // Canonical session participation owns discovery, bounded attempts and failure
  // backoff for asymmetric startup; this barrier is not a product readiness rule
  // or a substitute for qualification of that controller.
  // The first fixture must enroll first: it becomes the root device. Each device keeps its own bounded
  // metadata budget, so preparing them one after another cannot consume a peer's opening deadline.
  for (const fixture of fixtures) {
    await fixture.page.waitForFunction(() => typeof (window as any).prepareAcceptanceSession === 'function');
    await fixture.page.evaluate(async input => (window as any).prepareAcceptanceSession({ ...input, key: new Uint8Array(input.key) }),
      { name: fixture.name, key: Array.from(key), respondent: isPrivate ? first.id : undefined });
  }
  // Tables are created by an ordinary authorized DDL transaction on the root device before any live view
  // exists; opening then synchronizes it to the other device before that device's single initial read.
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
  const enrolled = await peers.application();
  const bundle = log.decodeRecord(Uint8Array.from(Buffer.from(enrolled.authority.record, 'hex')));
  expect(bundle.descriptor.payload.rootPrincipal).toBe(first.id);
  expect(bundle.memberships.at(-1).payload.members.filter((member: { reader: boolean }) => member.reader).map((member: { publicKey: string }) => member.publicKey).sort())
    .toEqual([first.id, second.id].sort());
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
