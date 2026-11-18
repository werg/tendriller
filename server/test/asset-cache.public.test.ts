import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createVersion, storeContent } from '../src/files';
import { sha256Hex } from '../src/ids';
import { immutableObject } from '../src/immutable-cache';
import { immutableAsset, runtimeAsset } from '../src/runtime-assets';
import { route } from '../src/router';
import runtimeRelease from '../src/runtime-release.json';
import { pageUrl } from '../src/urls';
import { create, inDO, ownerHeaders } from './helpers';

function countedFiles(config: Env = env) {
  const calls = { get: 0, head: 0 };
  const files = new Proxy(config.FILES, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (property === 'get' || property === 'head') calls[property]++;
      return value.apply(target, args);
    };
  } });
  return { calls, config: { ...config, FILES: files } };
}
const freshId = () => sha256Hex(crypto.randomUUID());
const assetRequest = (id: string, name: string, init?: RequestInit) => new Request(
  `https://abcdefghijkl.tendriller.site/s/${'a'.repeat(26)}/_tendril/assets/${id}/${name}`, init);

describe('immutable R2 byte caching', () => {
  it('rejects a corrupted object size before reading or caching its body', async () => {
    const key = `test/${crypto.randomUUID()}`;
    const sha256 = await sha256Hex('correct');
    await env.FILES.put(key, 'unexpected larger bytes');
    const get = vi.fn(async () => {
      const object = (await env.FILES.get(key))!;
      return { ...object, body: object.body, size: object.size, arrayBuffer: vi.fn(() => { throw new Error('should not buffer'); }) };
    });
    const config = { ...env, FILES: { get } } as unknown as Env;
    await expect(immutableObject(config, key, { sha256, expectedBytes: 7 })).rejects.toMatchObject({ code: 'integrity_mismatch' });
    await env.FILES.put(key, 'correct');
    expect(await (await immutableObject(env, key, { sha256, expectedBytes: 7 }))!.text()).toBe('correct');
  });

  it('shares immutable bytes across page URLs and queries without sharing cookies or partial responses', async () => {
    const id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`assets/${id}/model.bin`, '0123456789', { httpMetadata: { contentType: 'application/octet-stream' } });
    const first = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { Cookie: 'owner=one', Range: 'bytes=2-5' } }), id, 'model.bin');
    expect(first.status).toBe(206);
    expect(first.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe('2345');
    const second = await immutableAsset(config, new Request(`https://other.tendriller.site/another/path?download=1`, {
      headers: { Cookie: 'owner=two', Authorization: 'Bearer unrelated' },
    }), id, 'model.bin');
    expect(second.status).toBe(200);
    expect(new TextDecoder().decode(await second.arrayBuffer())).toBe('0123456789');
    expect(second.headers.get('Content-Length')).toBe('10');
    expect(second.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(second.headers.has('Set-Cookie')).toBe(false);
    expect(calls).toEqual({ get: 1, head: 0 });
  });

  it('uses R2 metadata for a cold HEAD and never caches an empty body as the GET object', async () => {
    const id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`assets/${id}/model.bin`, 'full bytes');
    const head = await immutableAsset(config, assetRequest(id, 'model.bin', { method: 'HEAD' }), id, 'model.bin');
    expect(head.headers.get('Content-Length')).toBe('10');
    expect(await head.text()).toBe('');
    expect(calls).toEqual({ get: 0, head: 1 });
    expect(await (await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin')).text()).toBe('full bytes');
    const warmHead = await immutableAsset(config, assetRequest(id, 'model.bin', { method: 'HEAD' }), id, 'model.bin');
    expect(await warmHead.text()).toBe('');
    expect(calls).toEqual({ get: 1, head: 1 });
  });

  it('handles validators, suffix ranges, If-Range and unsatisfiable ranges without additional R2 reads', async () => {
    const id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`assets/${id}/model.bin`, '0123456789');
    const original = await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin');
    const etag = original.headers.get('ETag')!;
    const modified = original.headers.get('Last-Modified')!;
    await original.text();
    for (const condition of [etag, `"other", W/${etag}`, '*']) {
      const response = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { 'If-None-Match': condition } }), id, 'model.bin');
      expect(response.status).toBe(304); expect(await response.text()).toBe('');
    }
    const range = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { Range: 'bytes=-3', 'If-Range': etag } }), id, 'model.bin');
    expect(range.status).toBe(206); expect(await range.text()).toBe('789');
    const matchingDate = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { Range: 'bytes=0-1', 'If-Range': modified } }), id, 'model.bin');
    expect(matchingDate.status).toBe(206); expect(await matchingDate.text()).toBe('01');
    for (const condition of ['"old"', '"9999"', `W/${etag}`, new Date(Date.parse(modified) + 1000).toUTCString()]) {
      const stale = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { Range: 'bytes=0-1', 'If-Range': condition } }), id, 'model.bin');
      expect(stale.status).toBe(200); expect(await stale.text()).toBe('0123456789');
    }
    const outside = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { Range: 'bytes=10-' } }), id, 'model.bin');
    expect(outside.status).toBe(416); expect(outside.headers.get('Content-Range')).toBe('bytes */10');
    expect(calls).toEqual({ get: 1, head: 0 });
  });

  it('does not cache missing objects or executable bytes that fail verification', async () => {
    const bytes = `self.verified = '${crypto.randomUUID()}'`, id = await sha256Hex(bytes);
    const { config, calls } = countedFiles();
    expect((await immutableAsset(config, assetRequest(id, 'engine.js'), id, 'engine.js')).status).toBe(404);
    await env.FILES.put(`assets/${id}/engine.js`, 'corrupt JavaScript', { httpMetadata: { contentType: 'text/javascript' } });
    await expect(immutableAsset(config, assetRequest(id, 'engine.js'), id, 'engine.js')).rejects.toMatchObject({ status: 503, code: 'integrity_mismatch' });
    await env.FILES.put(`assets/${id}/engine.js`, bytes, { httpMetadata: { contentType: 'text/javascript' } });
    expect(await (await immutableAsset(config, assetRequest(id, 'engine.js'), id, 'engine.js')).text()).toBe(bytes);
    expect(await (await immutableAsset(config, assetRequest(id, 'engine.js'), id, 'engine.js')).text()).toBe(bytes);
    expect(calls).toEqual({ get: 3, head: 0 });
  });

  it('falls back to storage if cache lookup or insertion fails', async () => {
    const id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`assets/${id}/model.bin`, 'still available');
    const open = vi.spyOn(caches, 'open').mockRejectedValue(new Error('cache unavailable'));
    try {
      expect(await (await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin')).text()).toBe('still available');
      open.mockResolvedValue({ match: async () => undefined, put: async () => { throw new Error('cache full'); } } as unknown as Cache);
      expect(await (await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin')).text()).toBe('still available');
      expect(calls).toEqual({ get: 2, head: 0 });
    } finally { open.mockRestore(); }
  });

  it('streams large fills without cloning the R2 body and serves ranges from the complete cached object', async () => {
    const id = await freshId(), { config, calls } = countedFiles(), size = 1024 * 1024 + 1;
    await env.FILES.put(`assets/${id}/model.bin`, new Uint8Array(size).fill(7));
    const clone = vi.spyOn(Response.prototype, 'clone');
    try {
      const response = await immutableAsset(config, assetRequest(id, 'model.bin', { headers: { Range: 'bytes=1048575-' } }), id, 'model.bin');
      expect(response.status).toBe(206);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
      const full = await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin');
      expect((await full.arrayBuffer()).byteLength).toBe(size);
      expect(clone).not.toHaveBeenCalled();
      expect(calls).toEqual({ get: 2, head: 0 });
    } finally { clone.mockRestore(); }
  });

  it('keeps the large client stream when the independent cache fill fails', async () => {
    const id = await freshId(), { config, calls } = countedFiles(), size = 1024 * 1024 + 1;
    await env.FILES.put(`assets/${id}/model.bin`, new Uint8Array(size).fill(9));
    const clone = vi.spyOn(Response.prototype, 'clone');
    const open = vi.spyOn(caches, 'open').mockResolvedValue({
      match: async () => undefined,
      put: async (_key: Request, response: Response) => {
        const reader = response.body!.getReader();
        while (!(await reader.read()).done) { /* The cache consumed the stream before failing. */ }
        throw new Error('cache insertion interrupted');
      },
    } as unknown as Cache);
    try {
      const response = await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(size); expect(bytes[0]).toBe(9); expect(bytes.at(-1)).toBe(9);
      expect(clone).not.toHaveBeenCalled();
      expect(calls).toEqual({ get: 2, head: 0 });
    } finally { open.mockRestore(); clone.mockRestore(); }
  });

  it('cannot satisfy an executable integrity check using an earlier weaker cache fill', async () => {
    const bytes = `self.verified = '${crypto.randomUUID()}'`, id = await sha256Hex(bytes), key = `assets/${id}/engine.js`;
    const { config, calls } = countedFiles();
    await env.FILES.put(key, 'unverified wrong content', { httpMetadata: { contentType: 'text/javascript' } });
    expect(await (await immutableObject(config, key))!.text()).toBe('unverified wrong content');
    await expect(immutableAsset(config, assetRequest(id, 'engine.js'), id, 'engine.js')).rejects.toMatchObject({ status: 503, code: 'integrity_mismatch' });
    expect(calls).toEqual({ get: 2, head: 0 });
  });

  it('separates storage environments even when their immutable object keys are identical', async () => {
    const id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`assets/${id}/model.bin`, 'production bytes');
    expect(await (await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin')).text()).toBe('production bytes');
    // Simulate the same key in a different environment's bucket.
    await env.FILES.put(`assets/${id}/model.bin`, 'preview bytes');
    const preview = { ...config, PUBLIC_BASE: 'https://preview-0123456789ab.tendriller.dev' };
    expect(await (await immutableAsset(preview, assetRequest(id, 'model.bin'), id, 'model.bin')).text()).toBe('preview bytes');
    expect(await (await immutableAsset(config, assetRequest(id, 'model.bin'), id, 'model.bin')).text()).toBe('production bytes');
    expect(calls).toEqual({ get: 2, head: 0 });
  });

  it('keeps optional resources behind live admission after the shared bytes are cached', async () => {
    const h = await create(), id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`assets/${id}/model.bin`, 'model');
    const url = `${h.page_url}_tendril/assets/${id}/model.bin`;
    const cache = await caches.open('tendriller-immutable-bytes-v1');
    const put = vi.spyOn(cache, 'put');
    const open = vi.spyOn(caches, 'open').mockResolvedValue(cache);
    try {
      const owner = await route(new Request(url, { headers: ownerHeaders(h.page_url) }), config);
      expect(owner.status).toBe(200); await owner.text();
      const key = put.mock.calls[0]?.[0] as Request;
      expect(await (await cache.match(key))?.text()).toBe('model');
      expect((await route(new Request(key.url), config)).status).toBe(404);
    } finally { open.mockRestore(); put.mockRestore(); }
    expect((await route(new Request(url), config)).status).toBe(302);
    await inDO(h.id, t => t.db.run('DELETE FROM page_sessions'));
    expect((await route(new Request(url, { headers: ownerHeaders(h.page_url) }), config)).status).toBe(302);
    expect(calls).toEqual({ get: 1, head: 0 });
  });

  it('serves historical root runtime assets on valid page and service hosts with no page object request', async () => {
    const id = await freshId(), { config, calls } = countedFiles();
    await env.FILES.put(`runtime/${id}/old.js`, 'old runtime', { httpMetadata: { contentType: 'text/javascript' } });
    const page = pageUrl(env, 'abcdefghijkl', 'a'.repeat(26));
    const noObjects = { ...config, TENDRIL: new Proxy(env.TENDRIL, { get() { throw new Error('Public runtime must not use an object'); } }) };
    for (const base of [env.PUBLIC_BASE, page]) {
      const url = new URL(`/_tendril/runtime/${id}/old.js`, base);
      const response = await route(new Request(url), noObjects);
      expect(response.status).toBe(200); expect(await response.text()).toBe('old runtime');
    }
    expect(calls).toEqual({ get: 1, head: 0 });
    for (const host of ['invalid.tendriller.site', 'nested.abcdefghijkl.tendriller.site', 'abcdefghijkl--p-0123456789ab.tendriller.site']) {
      expect((await route(new Request(`https://${host}/_tendril/runtime/${id}/old.js`), noObjects)).status).toBe(404);
    }
    const current = await runtimeAsset(config, new Request(`${page}?irrelevant`), runtimeRelease.id, 'tendril.js');
    expect(current.status).toBe(200); await current.text();
    expect(calls).toEqual({ get: 1, head: 0 });
  });

  it('retries an R2 publication write after a transient storage error', async () => {
    const h = await create();
    await inDO(h.id, async t => {
      const files = t.env.FILES;
      let puts = 0;
      t.env.FILES = new Proxy(files, { get(target, name) {
        if (name === 'put') return (...args: Parameters<R2Bucket['put']>) => {
          if (++puts === 1) throw new Error('put: We encountered an internal error. Please try again. (10001)');
          return target.put(...args);
        };
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      try {
        const stored = await storeContent(t, new TextEncoder().encode('publication asset').buffer as ArrayBuffer, 'text/plain');
        expect(puts).toBe(2);
        expect(t.db.one('SELECT status FROM stored_files WHERE hash=?', stored.hash)).toEqual({ status: 'ready' });
      } finally { t.env.FILES = files; }
    });
  });

  it('caches authored source bytes while rebuilding role-specific HTML and enforcing revoked access', async () => {
    const h = await create();
    await inDO(h.id, async t => {
      const files = new Map();
      for (const [path, type, text] of [['index.html', 'text/html', '<html><head></head><body>private page</body></html>'], ['app.js', 'text/javascript', 'self.privateApp = true;']]) {
        const stored = await storeContent(t, new TextEncoder().encode(text).buffer as ArrayBuffer, type);
        files.set(path, { path, type, ...stored });
      }
      await createVersion(t, files, null, null, { entry: 'index.html', beforeCommit: async () => {}, commit: () => {} });
      const display = t.renderLink(await t.createLink('display', null, null));
      const originalFiles = t.env.FILES, originalWait = t.ctx.waitUntil.bind(t.ctx);
      const { config, calls } = countedFiles(t.env), pending: Promise<unknown>[] = [];
      t.env.FILES = config.FILES;
      t.ctx.waitUntil = work => { pending.push(work); originalWait(work); };
      const request = (url: string, rest: string, owner = true) => {
        const page = new URL(url);
        return t.fetch(new Request('https://tendril.internal/page', { headers: {
          ...(owner ? ownerHeaders(url) : {}), 'x-tendril-key': page.pathname.split('/')[2],
          'x-tendril-origin': page.origin, 'x-tendril-base': page.pathname, 'x-tendril-rest': encodeURIComponent(rest),
        } }));
      };
      try {
        const owner = await request(h.page_url, '_publications/1/index.html');
        const ownerHtml = await owner.text(); await Promise.all(pending.splice(0));
        expect(owner.headers.get('Cache-Control')).toBe('private, no-cache');
        expect(ownerHtml).toContain('"peerBootstrap":');
        expect(ownerHtml).toContain(`"base":"/_tendril/runtime/${runtimeRelease.id}/"`);
        const displayed = await request(display.url, '_publications/1/index.html', false);
        const displayHtml = await displayed.text(); await Promise.all(pending.splice(0));
        expect(displayHtml).not.toContain('"peerBootstrap":');
        expect(displayHtml).toContain(`"base":"${new URL(display.url).pathname}"`);
        expect(calls.get).toBe(1);
        const script = await request(h.page_url, '_publications/1/app.js');
        expect(await script.text()).toBe('self.privateApp = true;'); await Promise.all(pending.splice(0));
        const again = await request(h.page_url, '_publications/1/app.js');
        expect(await again.text()).toBe('self.privateApp = true;');
        expect(calls.get).toBe(2);
        t.db.run('DELETE FROM page_sessions');
        expect((await request(h.page_url, '_publications/1/app.js')).status).toBe(401);
        t.db.run('DELETE FROM version_files WHERE version=1');
        expect((await request(display.url, '_publications/1/app.js', false)).status).toBe(404);
        expect(calls.get).toBe(2);
      } finally {
        await Promise.all(pending);
        t.env.FILES = originalFiles;
        t.ctx.waitUntil = originalWait;
      }
    });
  });
});
