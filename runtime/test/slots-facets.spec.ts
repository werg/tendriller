import { test, expect, type WebSocketRoute } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';

// Real Chromium verification of atomic publication hot-swapping & URL-addressable facets:
// proves that editing a facet module or adding a new facet in facets.json updates the
// active Shadow DOM stage live with zero page reload, preserving live shell state/canvases.
const compiled = await build({
  stdin: {
    contents: `
      export { watchPublicationUpdates } from './runtime/src/updates.ts';
      export { createSlotManager } from './runtime/src/slots.ts';
      export { mountFacets, buildFacetUrl } from './runtime/src/facets.ts';
    `,
    resolveDir: new URL('../..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'TendrilFacets',
  platform: 'browser',
  target: 'es2022',
  write: false,
});

const RUNTIME_ID = 'a'.repeat(64);
let server: Server;
let origin: string;
let currentVersion = 1;

const publicationFiles: Record<number, Record<string, { type: string; body: string; sha256: string }>> = {
  1: {
    'index.html': { type: 'text/html', body: '<html>v1</html>', sha256: 'h_html_1' },
    'page.mjs': { type: 'text/javascript', body: '// shell v1', sha256: 'h_shell_1' },
    'facets.json': {
      type: 'application/json',
      sha256: 'h_fj_1',
      body: JSON.stringify({
        default: 'stage',
        facets: [
          { id: 'stage', title: 'Stage', module: 'facets/stage.mjs' },
          { id: 'notes', title: 'Notes', module: 'facets/notes.mjs' },
        ],
      }),
    },
    'facets/stage.mjs': {
      type: 'text/javascript',
      sha256: 'h_stage_1',
      body: `export function mount(root, ctx) {
        ctx.slotState.set('panX', 42);
        const el = document.createElement('div');
        el.id = 'facet-body';
        el.textContent = 'Stage v1 (' + ctx.app.label + ')';
        root.append(el);
        return () => { window.__unmounts = (window.__unmounts || 0) + 1; };
      }`,
    },
    'facets/notes.mjs': {
      type: 'text/javascript',
      sha256: 'h_notes_1',
      body: `export function mount(root, ctx) {
        const el = document.createElement('div');
        el.id = 'facet-body';
        el.textContent = 'Notes v' + ctx.version;
        root.append(el);
      }`,
    },
  },
  2: {
    'index.html': { type: 'text/html', body: '<html>v1</html>', sha256: 'h_html_1' },
    'page.mjs': { type: 'text/javascript', body: '// shell v1', sha256: 'h_shell_1' },
    'facets.json': {
      type: 'application/json',
      sha256: 'h_fj_2',
      body: JSON.stringify({
        default: 'stage',
        facets: [
          { id: 'stage', title: 'Stage', module: 'facets/stage.mjs' },
          { id: 'notes', title: 'Notes', module: 'facets/notes.mjs' },
          { id: 'board', title: 'Whiteboard', module: 'facets/board.mjs' },
        ],
      }),
    },
    'facets/stage.mjs': {
      type: 'text/javascript',
      sha256: 'h_stage_2',
      body: `export function mount(root, ctx) {
        const el = document.createElement('div');
        el.id = 'facet-body';
        el.textContent = 'Stage v2 LIVE (' + ctx.app.label + ', panX=' + ctx.slotState.get('panX') + ')';
        root.append(el);
      }`,
    },
    'facets/notes.mjs': {
      type: 'text/javascript',
      sha256: 'h_notes_1',
      body: `export function mount(root, ctx) {
        const el = document.createElement('div');
        el.id = 'facet-body';
        el.textContent = 'Notes v' + ctx.version;
        root.append(el);
      }`,
    },
    'facets/board.mjs': {
      type: 'text/javascript',
      sha256: 'h_board_1',
      body: `export function mount(root) {
        const el = document.createElement('div');
        el.id = 'facet-body';
        el.textContent = 'Whiteboard LIVE';
        root.append(el);
      }`,
    },
  },
  3: {
    'index.html': { type: 'text/html', body: '<html>v3</html>', sha256: 'h_html_1' },
    'page.mjs': { type: 'text/javascript', body: '// shell v3 changed', sha256: 'h_shell_3' },
    'facets.json': {
      type: 'application/json',
      sha256: 'h_fj_2',
      body: JSON.stringify({
        default: 'stage',
        facets: [
          { id: 'stage', title: 'Stage', module: 'facets/stage.mjs' },
          { id: 'notes', title: 'Notes', module: 'facets/notes.mjs' },
          { id: 'board', title: 'Whiteboard', module: 'facets/board.mjs' },
        ],
      }),
    },
    'facets/stage.mjs': { type: 'text/javascript', sha256: 'h_stage_2', body: 'export function mount() {}' },
    'facets/notes.mjs': { type: 'text/javascript', sha256: 'h_notes_1', body: 'export function mount() {}' },
    'facets/board.mjs': { type: 'text/javascript', sha256: 'h_board_1', body: 'export function mount() {}' },
  },
};

const manifestFor = (v: number) => ({
  id: String(v),
  base: `/s/demo/_publications/${v}/`,
  entry: 'index.html',
  runtime: { id: RUNTIME_ID, version: '0.3.0-rc.17', base: `/_tendril/runtime/${RUNTIME_ID}/` },
  assets: Object.entries(publicationFiles[v]).map(([path, file]) => ({ path, sha256: file.sha256, type: file.type })),
});

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/harness.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(compiled.outputFiles[0].text);
      return;
    }
    if (url.pathname === '/s/demo/_tendril/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: currentVersion, publication: manifestFor(currentVersion) }));
      return;
    }
    const pubMatch = /^\/s\/demo\/_publications\/(\d+)\/(.+)$/.exec(url.pathname);
    if (pubMatch) {
      const file = publicationFiles[Number(pubMatch[1])]?.[pubMatch[2]];
      if (file) {
        res.writeHead(200, { 'Content-Type': file.type });
        res.end(file.body);
        return;
      }
    }
    if (url.pathname === '/s/demo/' || url.pathname === '/s/demo/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <canvas id="call-canvas" width="40" height="40"></canvas>
        <div id="stage-host"></div>
        <script src="/harness.js"></script>
      </body></html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('hot-swaps facet modules and catalog live without reloading the call canvas, and defers shell reload under hold()', async ({ page }) => {
  currentVersion = 1;
  let stream!: WebSocketRoute;
  await page.routeWebSocket('**/_tendril/publication-ready', route => {
    stream = route;
    route.send(JSON.stringify({ type: 'publication', version: 1, current: 1 }));
  });

  await page.goto(`${origin}/s/demo/`);
  await page.evaluate(async ({ manifest }) => {
    const w = window as any;
    w.__shellToken = { alive: true };
    w.__reloads = 0;
    w.__updates = [];
    const cfg = { id: 'demo', base: '/s/demo/', version: 1, publication: manifest, documentPath: 'index.html' };
    const latest = async () => (await fetch('/s/demo/_tendril/info', { cache: 'no-store' })).json();
    w.__manager = w.TendrilFacets.createSlotManager(cfg, { latest });
    w.__updatesCtrl = w.TendrilFacets.watchPublicationUpdates(cfg, {
      pinned: false,
      watch: true,
      reload: () => { w.__reloads++; },
      hasHotSwappableSlots: () => w.__manager.hasRegistrations(),
      onBeforeSwitch: (v: number) => w.__manager.handlePublicationChange(v),
    });
    w.__updatesCtrl.onUpdate((u: unknown) => w.__updates.push(u));
    w.__releaseHold = w.__updatesCtrl.hold();
    w.__facets = await w.TendrilFacets.mountFacets(w.__manager, cfg, document.getElementById('stage-host')!, {
      context: { label: 'LiveCall' },
    });
  }, { manifest: manifestFor(1) });

  await expect.poll(() => !!stream).toBe(true);
  await expect(page.locator('#stage-host >> #facet-body')).toHaveText('Stage v1 (LiveCall)');

  // 1. Publish v2 (only facets/stage.mjs + facets.json + facets/board.mjs changed):
  //    must hot-swap live with ZERO reload and preserve __shellToken + canvas!
  currentVersion = 2;
  stream.send(JSON.stringify({ type: 'publication', version: 1, current: 2 }));
  await expect(page.locator('#stage-host >> #facet-body')).toHaveText('Stage v2 LIVE (LiveCall, panX=42)');
  expect(await page.evaluate(() => ({
    reloads: (window as any).__reloads,
    unmounts: (window as any).__unmounts,
    shellAlive: (window as any).__shellToken?.alive,
    facets: (window as any).__facets.list().map((f: any) => f.id),
    lastUpdate: (window as any).__updates.at(-1),
  }))).toEqual({
    reloads: 0,
    unmounts: 1,
    shellAlive: true,
    facets: ['stage', 'notes', 'board'],
    lastUpdate: expect.objectContaining({ version: 2, kind: 'hot-swapped' }),
  });

  // 2. Switch to newly added Whiteboard facet -> URL encodes ?view=board, zero reload!
  await page.evaluate(() => (window as any).__facets.select('board'));
  await expect(page.locator('#stage-host >> #facet-body')).toHaveText('Whiteboard LIVE');
  expect(new URL(page.url()).searchParams.get('view')).toBe('board');
  expect(await page.evaluate(() => (window as any).__reloads)).toBe(0);

  // 3. Publish v3 (shell page.mjs changed) -> deferred by hold(), then reloads on release!
  currentVersion = 3;
  stream.send(JSON.stringify({ type: 'publication', version: 1, current: 3 }));
  await expect.poll(() => page.evaluate(() => (window as any).__updatesCtrl.updateAvailable)).toBe(true);
  expect(await page.evaluate(() => (window as any).__reloads)).toBe(0);
  await page.evaluate(() => (window as any).__releaseHold());
  expect(await page.evaluate(() => (window as any).__reloads)).toBe(1);
});
