/** Static publication fixture: application behavior belongs to a supplied session. */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const asset = (path: string) => readFileSync(join(root, 'dist/runtime/assets', path));
const runtimeManifest = JSON.parse(asset('manifest.json').toString());
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface MockTendril {
  id: string; version: number; html: string; noSw: boolean;
  files: Record<string, { type: string; body: string }>;
  publications: Map<number, { html: string; files: MockTendril['files']; manifest: any }>;
}
export class MockServer {
  server!: http.Server;
  port = 0;
  readonly requests: string[] = [];
  upgrades = 0;
  upgradeUrls: string[] = [];
  readonly pages = new Map<string, MockTendril>();
  get origin() { return `http://127.0.0.1:${this.port}`; }
  create(options: Partial<Pick<MockTendril, 'html' | 'noSw'>> = {}): MockTendril {
    const page = { id: `page-${this.pages.size + 1}`, version: 1, html: '<main>Owned application</main>', noSw: true,
      files: {}, publications: new Map(), ...options };
    this.pages.set(page.id, page); return page;
  }
  base(page: MockTendril) { return `/t/${page.id}/s/key/`; }
  url(page: MockTendril) { return this.origin + this.base(page); }
  runtimeUrl(page: MockTendril) { return `${this.base(page)}_tendril/runtime/${runtimeManifest.id}/`; }
  publication(page: MockTendril, version = page.version) {
    const previous = page.publications.get(version); if (previous) return previous;
    const base = this.base(page), publicationBase = `${base}_publications/${version}/`, files = structuredClone(page.files);
    const manifest = { id: String(version), base: publicationBase, entry: 'index.html',
      runtime: { version: runtimeManifest.version, id: runtimeManifest.id, base: this.runtimeUrl(page) },
      assets: [{ path: 'index.html', sha256: hash(page.html), type: 'text/html' },
        ...Object.entries(files).map(([path, file]) => ({ path, sha256: hash(file.body), type: file.type }))] };
    const cfg = { id: page.id, base, version, documentPath: 'index.html', publication: manifest,
      application: { id: hash(page.id) }, features: { speech: null, shared_by: 'Fixture' } };
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${publicationBase}"><script>window.__TENDRIL__=${JSON.stringify(cfg)};</script>` +
      (page.noSw ? '<script>window.__TENDRIL_NO_SW__=true</script>' : '') +
      `<script src="${this.runtimeUrl(page)}tendril.js"></script><title>Page ${page.id}</title></head><body>${page.html}</body></html>`;
    const publication = { html, files, manifest }; page.publications.set(version, publication); return publication;
  }
  async start() {
    this.server = http.createServer((req, res) => this.http(req, res));
    this.server.on('upgrade', (req, socket) => { this.upgrades++; this.upgradeUrls.push(req.url ?? ''); socket.destroy(); });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }
  async stop() { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
  private http(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', this.origin); this.requests.push(url.pathname);
    const match = /^\/t\/([^/]+)\/s\/key\/(.*)$/.exec(url.pathname), page = match && this.pages.get(match[1]);
    if (!page) { res.writeHead(404).end('not found'); return; }
    const rel = decodeURIComponent(match![2]);
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...headers }).end(body);
    if (!rel || rel === 'index.html') return send(200, 'text/html', this.publication(page).html, { 'X-Tendril-Publication': String(page.version) });
    const runtime = `_tendril/runtime/${runtimeManifest.id}/`;
    if (rel.startsWith(runtime)) {
      const path = rel.slice(runtime.length), entry = runtimeManifest.assets.find((item: any) => item.path === path);
      if (path === 'manifest.json') return send(200, 'application/json', JSON.stringify(runtimeManifest));
      return entry ? send(200, entry.type, asset(path)) : send(404, 'text/plain', 'not found');
    }
    const pinned = /^_publications\/(\d+)\/(.*)$/.exec(rel);
    if (pinned) {
      const publication = page.publications.get(Number(pinned[1])); if (!publication) return send(404, 'text/plain', 'not found');
      const headers = { 'X-Tendril-Publication': pinned[1] };
      if (!pinned[2] || pinned[2] === 'index.html') return send(200, 'text/html', publication.html, headers);
      const file = publication.files[pinned[2]];
      return file ? send(200, file.type, file.body, headers) : send(404, 'text/plain', 'not found');
    }
    if (rel === '_tendril/sw.js') return send(200, 'text/javascript', asset('sw.js'), { 'Service-Worker-Allowed': this.base(page) });
    if (rel === '_tendril/info') return send(200, 'application/json', JSON.stringify({ id: page.id, version: page.version, publication: this.publication(page).manifest }));
    return send(404, 'text/plain', 'not found');
  }
}
