import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import {
  createApplicationSession,
  createLiveView,
  createLogGenesis,
  openApplicationDevice,
} from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { NODE_PREVIEW_PLUGINS, renderEditableSitePages } from '../copy-editor-app/build.mjs';
import { definition, deriveCopyState, imports, topics } from '../copy-editor-app/domain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE_COPY = JSON.parse(readFileSync(join(ROOT, 'server/src/site-copy.json'), 'utf8'));

function getByPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const part of parts) {
    const k = /^\d+$/.test(part) ? Number(part) : part;
    if (cur == null || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

test('copy-editor renders all site pages with valid site-copy.json keys and zero leaks in production mode', async () => {
  const result = await renderEditableSitePages({
    repoRoot: ROOT,
    displayOrigin: 'https://tendriller.dev',
    bundle: esbuild,
  });

  const paths = result.pages.map((p) => p.path);
  for (const required of [
    '/',
    '/pricing',
    '/self-host',
    '/status',
    '/auth',
    '/agents',
    '/agents/claude-code',
    '/dashboard',
    '/dashboard/empty',
    '/dashboard/billing',
    '/dashboard/domains',
    '/dashboard/domains/upsell',
    '/connections',
    '/oauth/connections',
    '/dashboard/activity',
    '/_tendril/manage',
    '/auth/page',
    '/auth/page/guest',
    '/auth/page/quota',
    '/auth/page/missing',
    '/report',
  ]) {
    assert.ok(paths.includes(required), `Expected editable page ${required}`);
  }

  const allKeys = new Set();
  for (const page of result.pages) {
    const matches = [...page.html.matchAll(/data-copy="([^"]+)"\s+data-copy-raw="/g)].map((m) => m[1]);
    assert.ok(matches.length > 0, `Page ${page.path} should have at least one editable copy slot`);
    for (const key of matches) {
      allKeys.add(key);
      const val = getByPath(SITE_COPY, key);
      assert.equal(typeof val, 'string', `Copy key "${key}" on ${page.path} must map to a string in server/src/site-copy.json`);
    }
  }
  assert.ok(allKeys.size >= 150, `Expected rich site-wide copy coverage, got ${allKeys.size} keys`);

  // Verify non-editable production renders emit zero `data-copy` hooks.
  const prodBundle = await esbuild({
    stdin: {
      contents: `
        export { landingPage } from "./server/src/landing.ts";
        export { renderPricingPageHtml, renderSelfHostPageHtml } from "./server/src/billing/routes.ts";
        export { renderStatusPageHtml } from "./server/src/router.ts";
        export { renderReportPageHtml } from "./server/src/abuse/report.ts";
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: NODE_PREVIEW_PLUGINS,
  });
  const prod = await import('data:text/javascript;base64,' + Buffer.from(prodBundle.outputFiles[0].text).toString('base64'));
  for (const [name, html] of [
    ['landing', prod.landingPage('https://tendriller.dev')],
    ['pricing', prod.renderPricingPageHtml()],
    ['self-host', prod.renderSelfHostPageHtml('https://tendriller.dev')],
    ['status', prod.renderStatusPageHtml()],
    ['report', prod.renderReportPageHtml()],
  ]) {
    assert.equal(html.includes('data-copy='), false, `Production ${name} HTML must not emit data-copy attributes`);
  }
});

test('copy-editor Chronolog v2 session handles putEdit, undoEdit, submitBatch, and markApplied', async () => {
  const admin = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const created = await createLogGenesis({
    creator: { publicKey: admin.identity.publicKey, wrapKey: admin.wrapKey.publicKey, reader: true, writer: true, administrator: true, publisher: true },
    privateLog: true,
    imports,
    topics,
  });

  const session = await createApplicationSession({
    device: admin,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
    epochKeys: new Map([[0, created.epoch0Key]]),
    definition,
  });

  try {
    const op1 = await session.command('putEdit', {
      key: 'home.hero.title',
      before: 'A face for your agent',
      after: 'A live face for your agent',
    }, { operationId: 'op-1' });
    assert.equal((await op1.materialized()).outcome, 'accepted');

    const op2 = await session.command('putEdit', {
      key: 'pricing.hero.title',
      before: 'Grow with your agent',
      after: 'Scale with your agent',
    }, { operationId: 'op-2' });
    assert.equal((await op2.materialized()).outcome, 'accepted');

    const op3 = await session.command('undoEdit', {
      key: 'pricing.hero.title',
    }, { operationId: 'op-3' });
    assert.equal((await op3.materialized()).outcome, 'accepted');

    let snap = (await session.query('state', null)).value;
    assert.equal(snap.edits.length, 1);
    assert.equal(snap.edits[0].key, 'home.hero.title');
    assert.equal(snap.edits[0].after, 'A live face for your agent');

    const live = createLiveView(session, deriveCopyState);
    try {
      const lvSnap = await live.ready();
      assert.equal(lvSnap.value.edits.length, 1);
    } finally {
      live.close();
    }

    const op4 = await session.command('submitBatch', {
      batchId: 'batch_1',
      page: '/',
      note: 'Tighten hero',
      edits: [{ key: 'home.hero.title', before: 'A face for your agent', after: 'A live face for your agent' }],
    }, { operationId: 'op-4' });
    assert.equal((await op4.materialized()).outcome, 'accepted');

    snap = (await session.query('state', null)).value;
    assert.equal(snap.edits.length, 0);
    assert.equal(snap.submitted.length, 1);
    assert.equal(snap.batches.length, 1);
    assert.equal(snap.batches[0].batchId, 'batch_1');

    const op5 = await session.command('markApplied', {
      batchId: 'batch_1',
      keys: ['home.hero.title'],
    }, { operationId: 'op-5' });
    assert.equal((await op5.materialized()).outcome, 'accepted');

    snap = (await session.query('state', null)).value;
    assert.equal(snap.submitted.length, 0);
    assert.equal(snap.batches.length, 1);
  } finally {
    await session.close();
  }
});
