// Node-only page bundling shared by the starter templates' build.mjs. Never bundled into a page.
//
// Boot shape (one network round trip for the whole code graph, no dependent waves):
// - page.mjs: built alone, so its critical graph is (nearly) one module and contains no
//   Worker/QuickJS code. Only code the page loads lazily (dynamic `import()`) is split out.
// - worker.mjs: built alone with code splitting. A single flat Worker module was measured
//   ~190 ms slower to start on every warm reload (the whole graph is compiled before the
//   Worker answers), so the Worker keeps its chunks and instead has every one of them,
//   static and dynamic, preloaded by the document.
// - index.html: `<link rel=modulepreload>` for page.mjs and its static chunks, plus
//   `<link rel=preload as=fetch>` for configuration.json and the Worker's complete graph
//   (modules and WASM). They download in parallel while the HTML is parsed; the page's
//   configuration fetch consumes its preload, and the Worker's import waves and WASM
//   compile read from the HTTP cache (publication files are immutable).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';

const common = {
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outExtension: { '.js': '.mjs' },
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: { '.wasm': 'file' },
  metafile: true,
};

const attr = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Output paths (relative to `outdir`, POSIX) of `entry` and its import closure (static, or static + dynamic). */
function importClosure(metafile, workdir, outdir, entryName, { dynamic = false } = {}) {
  if (!metafile?.outputs) return { entry: null, closure: [], assets: [] };
  // esbuild reports metafile paths relative to absWorkingDir.
  const rel = path => relative(outdir, resolve(workdir, path)).split(sep).join('/');
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, value]) => [rel(path), value]));
  const entry = [...outputs.keys()].find(path => path === `${entryName}.mjs`) ?? null;
  const closure = [], assets = new Set(), seen = new Set();
  const visit = path => {
    if (seen.has(path)) return;
    seen.add(path);
    const output = outputs.get(path);
    if (!output) return;
    if (path !== entry) closure.push(path);
    for (const item of output.imports ?? []) {
      if (item.external) continue;
      const target = rel(item.path);
      if (item.kind === 'file-loader' || /\.wasm$/.test(target)) assets.add(target);
      else if (item.kind === 'import-statement' || (dynamic && item.kind === 'dynamic-import')) visit(target);
    }
  };
  if (entry) visit(entry);
  return { entry, closure, assets: [...assets] };
}

/**
 * Bundle `page.mjs` + `worker.mjs` from `root` into `output` and add preload hints to
 * `output/index.html` (copied there beforehand). `bundle` is esbuild's `build`.
 * `extra` overrides esbuild options for both builds (for example `logLevel`).
 */
export async function bundlePage(bundle, { root, output, extra = {} }) {
  const absWorkingDir = fileURLToPath(root), outdir = fileURLToPath(output);
  const page = await bundle({ ...common, ...extra, absWorkingDir, outdir, entryPoints: { page: 'page.mjs' }, splitting: true });
  const worker = await bundle({ ...common, ...extra, absWorkingDir, outdir, entryPoints: { worker: 'worker.mjs' }, splitting: true });
  const pageGraph = importClosure(page?.metafile, absWorkingDir, outdir, 'page');
  // The Worker's dynamic imports (session runtime, QuickJS glue, storage) all load during boot.
  const workerGraph = importClosure(worker?.metafile, absWorkingDir, outdir, 'worker', { dynamic: true });
  const hints = [
    '<link rel="preload" href="./configuration.json" as="fetch" crossorigin>',
    ...(pageGraph.entry ? [pageGraph.entry, ...pageGraph.closure] : []).map(path => `<link rel="modulepreload" href="./${attr(path)}">`),
    ...(workerGraph.entry ? [workerGraph.entry, ...workerGraph.assets, ...workerGraph.closure] : []).map(path => `<link rel="preload" href="./${attr(path)}" as="fetch" crossorigin>`),
  ].join('');
  const htmlUrl = new URL('index.html', output);
  let html;
  try { html = await readFile(htmlUrl, 'utf8'); } catch { return; }
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  // Hints follow the authored <head> start (after <meta charset> when it comes first).
  const charset = /<meta\s+charset[^>]*>/i.exec(html);
  const at = charset && head && charset.index > head.index ? charset.index + charset[0].length : head ? head.index + head[0].length : 0;
  await writeFile(htmlUrl, html.slice(0, at) + hints + html.slice(at));
}
