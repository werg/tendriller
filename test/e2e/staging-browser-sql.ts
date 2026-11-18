import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checklist, intake } from './specimens/sql-domains.mjs';
import type { createClient } from '../../dist/sdk/client.mjs';

type Peers = ReturnType<typeof createClient>['peers'];
type Fixture = { page: Page; name: string; id: string };

export async function openBrowserSqlSpecimen(options: {
  consumer: string; engineDirectory: string; peers: Peers; pageUrl: string; applicationId: string;
  pages: [Page, Page]; isPrivate: boolean; guestAccount: string;
}) {
  const { consumer, engineDirectory, peers, pageUrl, applicationId, pages, isPrivate } = options;
  const packageRoot = resolve(consumer, 'node_modules/@chronolog/peer-session');
  const load = (path: string) => import(pathToFileURL(resolve(packageRoot, path)).href);
  const [log, sql, native] = await Promise.all([load('index.mjs'), load('sql.mjs'), load('sql-native.mjs')]);
  const source = 'test/e2e/specimens';
  const common = { bundle: true, platform: 'browser' as const, format: 'esm' as const, write: false,
    minify: true, nodePaths: [resolve(consumer, 'node_modules')],
    alias: { '@tendriller/core/peers': resolve('dist/sdk/peers.mjs') } };
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
      const id = await page.evaluate(({ bootstrap, name }) => new Promise<string>((resolve, reject) => {
        const worker = new Worker(bootstrap, { type: 'module' });
        const finish = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { finish(); reject(new Error('Browser identity timed out')); }, 10_000);
        worker.onerror = event => { finish(); reject(new Error(event.message)); };
        worker.onmessage = ({ data }) => {
          finish();
          if (data.type === 'identity') resolve(data.id);
          else reject(new Error(data.message));
        };
        worker.postMessage({ type: 'identity', name });
      }), { bootstrap, name });
      fixtures.push({ page, name, id });
    } finally {
      await page.unroute(bootstrap);
    }
  }
  const [first, second] = fixtures;
  const signer = await log.createPeerIdentity();
  const definition = isPrivate ? intake(log, first.id) : checklist(log);
  const key = new Uint8Array(randomBytes(32));
  const signedSchema = await sql.prepareSqlApplication({ engine: native.createNativeSqlEngine(), applicationId,
    definition, schemaAdministrator: signer });
  const authority = await peers.configureApplication({ historyId: isPrivate ? 'browser-intake' : 'browser-checklist',
    definition: log.describeApplication(definition), schema: signedSchema.schema,
    executionManifestDigest: signedSchema.binding.executionManifestDigest, schemaAdministrator: signer.publicKey,
    epoch: 0, keyDigest: await log.bytesDigest(key),
    members: [
      { grant: { ...log.controlParticipantGrant(signer.publicKey), administrator: false, recovery: false, publisher: true } },
      { grant: log.participantGrant(first.id) },
      { grant: log.participantGrant(second.id), accountId: options.guestAccount },
    ],
  });
  expect(authority.controls[0].payload.grants.filter(grant => grant.reader).map(grant => grant.publicKey).sort())
    .toEqual([first.id, second.id].sort());
  const descriptor = authority.descriptor.payload;
  await peers.administerGeneration({ expectedGeneration: null, coordinator: first.id, controlRevision: 0,
    base: null, reason: 'create', transitionId: randomUUID() });

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
    const hash = await log.bytesDigest(bytes);
    files.push({ path, type, hash, size: bytes.length });
    assets.push({ hash, bytes: Buffer.from(bytes).toString('base64') });
  }
  const publication = await log.signPublicationManifest({ applicationId, historyId: descriptor.historyId,
    profile: descriptor.profile, controlRevision: 0, author: signer.publicKey, operationId: randomUUID(), revision: 0,
    previous: null, definitionDigest: descriptor.definitionDigest, executionManifestDigest: descriptor.executionManifestDigest,
    entry: 'index.html', files }, signer);
  await peers.publish(publication, assets);
  await Promise.all(pages.map(page => expect(page.getByRole('heading', { name: 'Shared work' })).toBeVisible({ timeout: 25_000 })));
  const channel = randomUUID();
  const open = async (fixture: Fixture, remote?: string) => {
    await fixture.page.waitForFunction(() => typeof (window as any).openAcceptanceSession === 'function');
    await fixture.page.evaluate(async input => (window as any).openAcceptanceSession({ ...input, key: new Uint8Array(input.key) }),
      { name: fixture.name, remote, channel, key: Array.from(key), respondent: isPrivate ? first.id : undefined });
    await expect(fixture.page.getByRole('status').first()).toHaveText('Ready');
  };
  await Promise.all([open(first, second.id), open(second, first.id)]);
  return { async reopenFirst() {
    await first.page.evaluate(async () => (window as any).closeAcceptanceSession());
    await first.page.reload();
    await open(first);
  } };
}
