// Serve exact authored files. A live preview installs the application's own
// public session; this harness supplies no hosted data protocol or database.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep, posix } from 'node:path';
import { guessType, listFiles } from '../../cli/lib/pack.mjs';
import { assets as runtimeAssets, manifest as runtimeManifest } from './preview-bundle.mjs';

export function loadPlaywright(cwd = process.cwd(), explicitPath) {
  const require = createRequire(join(cwd, 'preview-loader.cjs'));
  if (explicitPath) {
    const loaded = require(resolve(cwd, explicitPath));
    if (!loaded?.chromium) throw Error('--playwright-path must export chromium');
    return loaded;
  }
  for (const base of [join(cwd, 'preview-loader.cjs'), import.meta.url]) {
    const from = createRequire(base);
    for (const name of ['playwright', '@playwright/test']) {
      try { const loaded = from(name); if (loaded.chromium) return loaded; } catch { /* Try the next public installation. */ }
    }
  }
  return null;
}
const literal = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const assetPath = path => path.split('/').map(encodeURIComponent).join('/');

export function injectRuntime(html, publication, documentPath, bootstrap) {
  const directory = posix.dirname(documentPath);
  const base = publication.base + (directory === '.' ? '' : assetPath(directory) + '/');
  let tags = `<base href="${base.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`;
  if (bootstrap) {
    const configuration = { id: 'preview', base: '/', version: publication.version, preview: true,
      publication, documentPath, features: { push: false, vapid: null, shared_by: 'Local preview', speech: null } };
    tags += `<script>globalThis.tendrilReady=(async()=>{
const configuration=${literal(configuration)};
const {openPreview}=await import(${literal(publication.base + assetPath(bootstrap))});
if(typeof openPreview!=='function')throw Error('Preview bootstrap must export openPreview');
const owned=await openPreview({configuration});
if(!owned?.application||typeof owned.close!=='function')throw Error('openPreview must return {application,signals?,close} from an owned public session');
globalThis.__tendrilPreviewClose=()=>owned.close();
addEventListener('pagehide',()=>{void owned.close()},{once:true});
const {startRuntime}=await import(${literal(`/_tendril/runtime/${runtimeManifest.id}/kernel.mjs`)});
const runtime=startRuntime({...configuration,application:{id:owned.application.id}},{application:owned.application,signals:owned.signals});
globalThis.tendril=runtime;await runtime.ready();return runtime;
})();globalThis.tendrilReady.catch(error=>{globalThis.__tendrilPreviewError=error.message;console.error(error)});</script>`;
  }
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length) : tags + html;
}

export async function startServer(directory, options = {}) {
  const allowed = new Set(['bootstrap', 'assets']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw Error(`Unknown preview option: ${key}`);
  const root = realpathSync(resolve(directory)), publications = new Map(), sockets = new Set();
  const bootstrap = options.bootstrap;
  if (bootstrap !== undefined && (typeof bootstrap !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.mjs$/u.test(bootstrap)
      || bootstrap.split('/').some(part => part === '.' || part === '..'))) throw Error('Bootstrap must be an authored relative .mjs path');
  const assets = options.assets ?? runtimeAssets;
  let current, stopping = false, stopPromise;
  const safeFile = path => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || !existsSync(file) || realpathSync(file) !== file || !statSync(file).isFile()) return null;
    return file;
  };
  function snapshot() {
    const contents = new Map();
    let bytes = 0;
    for (const path of listFiles(root)) {
      const file = safeFile(path);
      if (!file) throw Error(`Unsafe authored asset: ${path}`);
      const content = readFileSync(file); bytes += content.length;
      if (bytes > 64 * 1024 * 1024 || contents.size >= 1024) throw Error('Preview graph exceeds its byte or file limit');
      contents.set(path, content);
    }
    if (!contents.has('index.html')) throw Error('Preview directory must contain index.html');
    if (bootstrap && !contents.has(bootstrap)) throw Error('The complete authored graph must contain its bootstrap module');
    const entries = [...contents].map(([path, content]) => ({ path, type: guessType(path), size: content.length,
      sha256: createHash('sha256').update(content).digest('hex') }));
    const id = createHash('sha256').update(JSON.stringify({ runtime: runtimeManifest.id, bootstrap: bootstrap ?? null, assets: entries })).digest('hex');
    if (!publications.has(id)) {
      if (publications.size >= 64) throw Error('Restart preview after 64 authored revisions');
      publications.set(id, { contents, manifest: { id, version: publications.size + 1, base: `/_publications/${id}/`, entry: 'index.html',
        runtime: { id: runtimeManifest.id, version: runtimeManifest.version, base: `/_tendril/runtime/${runtimeManifest.id}/` }, assets: entries } });
    }
    current = publications.get(id);
    return current;
  }
  snapshot();
  const server = createServer(async (request, response) => {
    const send = (status, type, body, extra = {}) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }); response.end(body); };
    const json = (status, body) => send(status, 'application/json', JSON.stringify(body));
    try {
      if (stopping) { request.socket.destroy(); return; }
      if (!['GET', 'HEAD'].includes(request.method)) return json(405, { error: 'Preview accepts authored asset reads only' });
      const path = decodeURIComponent(new URL(request.url, 'http://preview').pathname);
      if (path === '/_preview/info') return json(200, { mode: bootstrap ? 'owned-application-session' : 'authored-files',
        publication: current.manifest, runtime: runtimeManifest.id, bootstrap: bootstrap ?? null });
      if (path === '/favicon.ico') return send(204, 'image/x-icon', '');
      if (path.startsWith('/_tendril/')) {
        const content = assets[path];
        return content ? send(200, guessType(path), Buffer.from(content, 'base64')) : json(404, { error: 'No preview host service exists at this path' });
      }
      const immutable = /^\/_publications\/([a-f0-9]{64})\/(.*)$/u.exec(path);
      const selected = immutable ? publications.get(immutable[1]) : snapshot();
      const logical = immutable ? immutable[2] : path.slice(1), name = !logical || logical.endsWith('/') ? logical + 'index.html' : logical;
      const content = selected?.contents.get(name);
      if (!content) return json(404, { error: 'No such authored asset' });
      const type = guessType(name);
      send(200, type, request.method === 'HEAD' ? '' : type === 'text/html' ? injectRuntime(content.toString('utf8'), selected.manifest, name, bootstrap) : content,
        { 'X-Tendril-Publication': selected.manifest.id, 'cache-control': immutable ? 'public,max-age=31536000,immutable' : 'no-store' });
    } catch (error) { json(400, { error: error.message }); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.stopPreview = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    for (const socket of sockets) socket.destroy();
    return stopPromise;
  };
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server;
}

export async function preview(directory, options = {}) {
  const allowed = new Set(['bootstrap', 'playwrightPath', 'out', 'headed', 'desktop', 'waitMs', 'steps']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw Error(`Unknown preview option: ${key}`);
  const playwright = loadPlaywright(process.cwd(), options.playwrightPath);
  if (!playwright) throw Error('Install Playwright or supply --playwright-path with its public module');
  const server = await startServer(directory, options.bootstrap ? { bootstrap: options.bootstrap } : {});
  let browser, page;
  const errors = [], consoleMessages = [];
  try {
    browser = await playwright.chromium.launch({ headless: !options.headed,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    page = await browser.newPage({ viewport: options.desktop ? { width: 1280, height: 800 } : { width: 390, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    if (options.bootstrap) await page.evaluate(() => globalThis.tendrilReady);
    for (const step of options.steps ?? []) {
      if (step.action === 'click') await page.locator(step.selector).click();
      else if (step.action === 'fill') await page.locator(step.selector).fill(step.value);
      else if (step.action === 'select') await page.locator(step.selector).selectOption(step.value);
      else if (step.action === 'wait') await page.locator(step.selector).waitFor({ state: step.state ?? 'visible' });
      else throw Error(`Unknown preview action: ${step.action}`);
    }
    if (options.waitMs) await page.waitForTimeout(options.waitMs);
    if (options.out) await page.screenshot({ path: resolve(options.out), fullPage: true });
    const info = await (await fetch(`${origin}/_preview/info`)).json();
    return { ok: errors.length === 0, ...info, errors, console: consoleMessages, screenshot: options.out ? resolve(options.out) : null,
      limits: ['Authored assets and the supplied session bootstrap ran locally; no deployed host, login, network or billing result is inferred.'] };
  } finally {
    await page?.evaluate(() => globalThis.__tendrilPreviewClose?.()).catch(() => {});
    await browser?.close(); await server.stopPreview();
  }
}
