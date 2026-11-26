import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export * from './runtime/src/slots.ts';
      export * from './runtime/src/facets.ts';
    `,
    resolveDir: new URL('../..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const pub = (id, assets, { runtimeId = 'a'.repeat(64), entry = 'index.html' } = {}) => ({
  id: String(id),
  base: `/s/demo/_publications/${id}/`,
  entry,
  runtime: { id: runtimeId, version: '0.3.0-rc.17', base: `/_tendril/runtime/${runtimeId}/` },
  assets: assets.map(([path, sha256]) => ({ path, sha256, type: path.endsWith('.json') ? 'application/json' : 'text/javascript' })),
});

const cfgFor = (version, publication) => ({
  id: 'demo',
  base: '/s/demo/',
  version,
  publication,
  documentPath: 'index.html',
});

function fakeContainer() {
  let shadowRoot = null;
  const children = [];
  const makeNode = () => ({
    children,
    textContent: '',
    replaceChildren(...items) { children.length = 0; children.push(...items); },
    append(...items) { children.push(...items); },
  });
  return {
    get shadowRoot() { return shadowRoot; },
    attachShadow() { shadowRoot = makeNode(); return shadowRoot; },
    replaceChildren(...items) { children.length = 0; children.push(...items); },
    append(...items) { children.push(...items); },
    get _children() { return children; },
  };
}

test('classifyPublicationUpdate hot-swaps when only owned slot/facet paths change and reloads on shell/runtime/entry changes', () => {
  const v1 = pub(1, [
    ['index.html', 'h_html'],
    ['page.mjs', 'h_page'],
    ['worker.mjs', 'h_worker'],
    ['facets.json', 'h_fjson_1'],
    ['facets/stage.mjs', 'h_stage_1'],
    ['facets/notes.mjs', 'h_notes_1'],
  ]);
  const owned = new Set(['facets.json', 'facets/']);

  // Editing only facets/stage.mjs -> hot-swapped
  const v2 = pub(2, [
    ['index.html', 'h_html'],
    ['page.mjs', 'h_page'],
    ['worker.mjs', 'h_worker'],
    ['facets.json', 'h_fjson_1'],
    ['facets/stage.mjs', 'h_stage_2'],
    ['facets/notes.mjs', 'h_notes_1'],
  ]);
  assert.deepEqual(mod.classifyPublicationUpdate(v1, v2, owned), {
    kind: 'hot-swapped',
    changedPaths: ['facets/stage.mjs'],
  });

  // Adding a brand new facet + updating facets.json -> hot-swapped
  const v3 = pub(3, [
    ['index.html', 'h_html'],
    ['page.mjs', 'h_page'],
    ['worker.mjs', 'h_worker'],
    ['facets.json', 'h_fjson_2'],
    ['facets/stage.mjs', 'h_stage_2'],
    ['facets/notes.mjs', 'h_notes_1'],
    ['facets/board.mjs', 'h_board_1'],
  ]);
  assert.deepEqual(mod.classifyPublicationUpdate(v2, v3, owned), {
    kind: 'hot-swapped',
    changedPaths: ['facets.json', 'facets/board.mjs'],
  });

  // Changing page.mjs -> reload
  const v4 = pub(4, [
    ['index.html', 'h_html'],
    ['page.mjs', 'h_page_2'],
    ['worker.mjs', 'h_worker'],
    ['facets.json', 'h_fjson_2'],
    ['facets/stage.mjs', 'h_stage_2'],
    ['facets/notes.mjs', 'h_notes_1'],
    ['facets/board.mjs', 'h_board_1'],
  ]);
  assert.deepEqual(mod.classifyPublicationUpdate(v3, v4, owned), {
    kind: 'reload',
    changedPaths: ['page.mjs'],
  });

  // Changing runtime id -> reload even if assets are identical
  const v5 = pub(5, v3.assets.map(a => [a.path, a.sha256]), { runtimeId: 'b'.repeat(64) });
  assert.equal(mod.classifyPublicationUpdate(v3, v5, owned).kind, 'reload');
});

test('resolvePublicationAssetUrl enforces declared paths and rejects traversal', () => {
  const v1 = pub(1, [['index.html', 'h1'], ['facets/stage.mjs', 'h2']]);
  const cfg = cfgFor(1, v1);
  assert.equal(
    mod.resolvePublicationAssetUrl(cfg, 'facets/stage.mjs', v1, 'https://app.example/s/demo/'),
    'https://app.example/s/demo/_publications/1/facets/stage.mjs',
  );
  assert.throws(() => mod.resolvePublicationAssetUrl(cfg, 'facets/missing.mjs', v1, 'https://app.example/s/demo/'), /not declared/);
  assert.throws(() => mod.resolvePublicationAssetUrl(cfg, '../escape.mjs', v1, 'https://app.example/s/demo/'), /Invalid publication asset path/);
});

test('buildFacetUrl preserves live vs pinned context, other query params, and hash deep links', () => {
  const v1 = pub(1, [['index.html', 'h1']]);
  const cfg = cfgFor(1, v1);
  assert.equal(
    mod.buildFacetUrl(cfg, 'notes', { href: 'https://app.example/s/demo/?foo=1#note=abc' }),
    'https://app.example/s/demo/index.html?foo=1&view=notes#note=abc',
  );
  assert.equal(
    mod.buildFacetUrl(cfg, 'notes', { pinned: true, href: 'https://app.example/s/demo/_publications/1/?view=stage#top' }),
    'https://app.example/s/demo/_publications/1/index.html?view=notes#top',
  );
  assert.throws(() => mod.buildFacetUrl(cfg, '../bad', { href: 'https://app.example/s/demo/' }), /Invalid facet id/);
});

test('mountSlot hot-swaps live on slot-only publication change, aborts previous signal, and preserves active slot on bad import', async () => {
  const v1 = pub(1, [['index.html', 'h_html'], ['slots/stage.mjs', 'h_s1']]);
  const v2 = pub(2, [['index.html', 'h_html'], ['slots/stage.mjs', 'h_s2']]);
  const v3 = pub(3, [['index.html', 'h_html'], ['slots/stage.mjs', 'h_s3_broken']]);
  const v4 = pub(4, [['index.html', 'h_html_2'], ['slots/stage.mjs', 'h_s3_broken']]);

  let currentServer = { version: 1, publication: v1 };
  const events = [];
  const signals = [];
  const modules = {
    'https://app.example/s/demo/_publications/1/slots/stage.mjs': {
      mount(root, ctx) {
        signals.push(ctx.signal);
        events.push(`mount:v${ctx.version}`);
        root.append(`rendered:v${ctx.version}`);
        return () => { events.push(`unmount:v${ctx.version}`); };
      },
    },
    'https://app.example/s/demo/_publications/2/slots/stage.mjs': {
      mount(root, ctx) {
        signals.push(ctx.signal);
        events.push(`mount:v${ctx.version}`);
        root.append(`rendered:v${ctx.version}`);
        return () => { events.push(`unmount:v${ctx.version}`); };
      },
    },
  };

  const manager = mod.createSlotManager(cfgFor(1, v1), {
    latest: async () => currentServer,
    href: () => 'https://app.example/s/demo/',
    importModule: async url => {
      if (!modules[url]) throw new Error('SYNTAX_ERROR_IN_AGENT_PUSH');
      return modules[url];
    },
  });

  const container = fakeContainer();
  const swaps = [];
  const errors = [];
  const slot = await manager.mountSlot('stage', container, {
    module: 'slots/stage.mjs',
    onSwap: info => swaps.push(info),
    onError: (err, info) => errors.push({ message: err.message, ...info }),
  });

  assert.equal(slot.version, 1);
  assert.ok(container.shadowRoot, 'Default isolation mounts into an open ShadowRoot');
  assert.deepEqual(container.shadowRoot.children, ['rendered:v1']);
  assert.equal(signals[0].aborted, false);

  // Publish v2 (slot-only change) -> hot-swapped live!
  currentServer = { version: 2, publication: v2 };
  const r2 = await manager.handlePublicationChange(2);
  assert.equal(r2.handled, true);
  assert.equal(r2.kind, 'hot-swapped');
  assert.equal(signals[0].aborted, true, 'Previous slot AbortSignal is aborted on swap');
  assert.equal(signals[1].aborted, false);
  assert.deepEqual(events, ['mount:v1', 'unmount:v1', 'mount:v2']);
  assert.deepEqual(container.shadowRoot.children, ['rendered:v2']);
  assert.equal(slot.version, 2);
  assert.equal(swaps.length, 2);

  // Publish v3 (broken slot import) -> error reported, v2 stays mounted and intact!
  currentServer = { version: 3, publication: v3 };
  const r3 = await manager.handlePublicationChange(3);
  assert.equal(r3.handled, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'import');
  assert.deepEqual(container.shadowRoot.children, ['rendered:v2']);
  assert.equal(signals[1].aborted, false);

  // Publish v4 (shell index.html changed) -> falls back to reload
  currentServer = { version: 4, publication: v4 };
  const r4 = await manager.handlePublicationChange(4);
  assert.equal(r4.handled, false);
  assert.equal(r4.kind, 'reload');
  assert.deepEqual(r4.changedPaths, ['index.html']);

  await slot.dispose();
  assert.equal(signals[1].aborted, true);
  manager.close();
});

test('mountFacets reads ?view=<id>, switches via pushState/popstate, and live-updates catalog when facets.json changes', async () => {
  const v1 = pub(1, [
    ['index.html', 'h_html'],
    ['facets.json', 'h_fj1'],
    ['facets/stage.mjs', 'h_stage1'],
    ['facets/notes.mjs', 'h_notes1'],
  ]);
  const v2 = pub(2, [
    ['index.html', 'h_html'],
    ['facets.json', 'h_fj2'],
    ['facets/stage.mjs', 'h_stage1'],
    ['facets/notes.mjs', 'h_notes1'],
    ['facets/board.mjs', 'h_board1'],
  ]);

  let currentServer = { version: 1, publication: v1 };
  let currentUrl = 'https://app.example/s/demo/?view=notes#item=42';
  const popListeners = new Set();
  const manifests = {
    'https://app.example/s/demo/_publications/1/facets.json': {
      default: 'stage',
      facets: [
        { id: 'stage', title: 'Stage', module: 'facets/stage.mjs' },
        { id: 'notes', title: 'Notes', module: 'facets/notes.mjs' },
      ],
    },
    'https://app.example/s/demo/_publications/2/facets.json': {
      default: 'stage',
      facets: [
        { id: 'stage', title: 'Stage', module: 'facets/stage.mjs' },
        { id: 'notes', title: 'Notes', module: 'facets/notes.mjs' },
        { id: 'board', title: 'Whiteboard', module: 'facets/board.mjs' },
      ],
    },
  };

  const cfg = cfgFor(1, v1);
  const manager = mod.createSlotManager(cfg, {
    latest: async () => currentServer,
    href: () => currentUrl,
    importModule: async url => ({
      mount(root, ctx) { root.append(`${ctx.app.facet.id}@v${ctx.version}`); },
    }),
  });

  const container = fakeContainer();
  const changes = [];
  const facets = await mod.mountFacets(manager, cfg, container, {
    fetch: async url => ({ ok: true, status: 200, json: async () => manifests[url] }),
    href: () => currentUrl,
    pushUrl: url => { currentUrl = url; },
    onPopState: fn => { popListeners.add(fn); return () => popListeners.delete(fn); },
    onChange: state => changes.push(state.facets.map(f => f.id)),
  });

  assert.equal(facets.current.id, 'notes', 'Opens directly into ?view=notes');
  assert.deepEqual(container.shadowRoot.children, ['notes@v1']);

  // Publish v2 adding Whiteboard facet -> hot-swapped with zero reload!
  currentServer = { version: 2, publication: v2 };
  const outcome = await manager.handlePublicationChange(2);
  assert.equal(outcome.handled, true);
  assert.equal(outcome.kind, 'hot-swapped');
  assert.deepEqual(facets.list().map(f => f.id), ['stage', 'notes', 'board']);

  // Switch to the brand-new Whiteboard facet -> URL updates and mounts live!
  await facets.select('board');
  assert.equal(facets.current.id, 'board');
  assert.equal(currentUrl, 'https://app.example/s/demo/index.html?view=board#item=42');
  assert.deepEqual(container.shadowRoot.children, ['board@v2']);

  // Browser Back -> popstate switches back to notes cleanly.
  currentUrl = 'https://app.example/s/demo/index.html?view=notes#item=42';
  for (const fn of popListeners) fn();
  await new Promise(r => setTimeout(r, 15));
  assert.equal(facets.current.id, 'notes');
  assert.deepEqual(container.shadowRoot.children, ['notes@v2']);

  await facets.dispose();
  manager.close();
});
