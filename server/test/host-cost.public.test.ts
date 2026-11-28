import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createVersion, storeContent } from '../src/files';
import { route } from '../src/router';
import { barePageUrl, pageUrl } from '../src/urls';
import { create, inDO, ownerHeaders } from './helpers';

/** A router whose own D1 statements and Durable Object calls are counted. */
function countedRouter() {
  const d1: string[] = [], objects: string[] = [];
  const accounts = new Proxy(env.ACCOUNTS, { get(target, key) {
    if (key === 'prepare') return (query: string) => { d1.push(query); return target.prepare(query); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const config: Env = { ...env, ACCOUNTS: accounts, TENDRIL: {
    idFromName: (name: string) => env.TENDRIL.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: (request: Request) => {
      objects.push(new URL(request.url).pathname);
      return env.TENDRIL.get(id).fetch(request);
    } }),
  } as unknown as DurableObjectNamespace };
  return { d1, objects, fetch: (url: string, init?: RequestInit) => route(new Request(url, init), config) };
}

/** Counts R2 reads and Cache API opens inside the page object. */
function countBytes(t: { env: Env }) {
  const calls = { r2: 0, cache: 0 };
  const files = t.env.FILES;
  t.env.FILES = new Proxy(files, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { if (property === 'get' || property === 'head') calls.r2++; return value.apply(target, args); };
  } });
  const open = caches.open.bind(caches);
  caches.open = (name: string) => { calls.cache++; return open(name); };
  return { calls, restore: () => { t.env.FILES = files; caches.open = open; } };
}

describe('host request cost', () => {
  it('routes warm page hosts with no router D1 reads and still rejects unknown IDs without an object call', async () => {
    const h = await create();
    const router = countedRouter();
    const perRequest: number[] = [];
    for (const url of [h.page_url, h.page_url, barePageUrl(env, h.id), barePageUrl(env, h.id)]) {
      router.d1.length = 0;
      const response = await router.fetch(url, { headers: ownerHeaders(h.page_url) });
      expect(response.status, url).toBeLessThan(500);
      expect(response.headers.get('Server-Timing')).toMatch(/(^|, )route;dur=\d+/);
      await response.arrayBuffer();
      perRequest.push(router.d1.length);
    }
    // Cold keyed: named-subdomain miss. Cold bare: page existence. Warm: none.
    expect(perRequest).toEqual([1, 0, 1, 0]);

    const unknown = barePageUrl(env, 'abcdefghijkl');
    router.d1.length = 0; router.objects.length = 0;
    for (let i = 0; i < 3; i++) expect((await router.fetch(unknown)).status).toBe(404);
    expect(router.d1).toHaveLength(2);
    expect(router.objects).toEqual([]);
    const unknownKeyed = pageUrl(env, 'abcdefghijkl', 'a'.repeat(26));
    router.d1.length = 0;
    await (await router.fetch(unknownKeyed)).arrayBuffer();
    expect(router.d1).toHaveLength(0);
  });

  it('answers HTML revalidation before any byte read and renders an unchanged document once', async () => {
    const h = await create();
    await inDO(h.id, async t => {
      const files = new Map();
      for (const [path, type, text] of [['index.html', 'text/html', '<html><head></head><body>cost page</body></html>'], ['app.js', 'text/javascript', 'self.app = 1;']]) {
        const stored = await storeContent(t, new TextEncoder().encode(text).buffer as ArrayBuffer, type);
        files.set(path, { path, type, ...stored });
      }
      await createVersion(t, files, null, null, { entry: 'index.html', beforeCommit: async () => {}, commit: () => {} });
      const page = new URL(h.page_url);
      const request = (rest: string, headers: Record<string, string> = {}) => t.fetch(new Request('https://tendril.internal/page', { headers: {
        ...ownerHeaders(h.page_url), ...headers, 'x-tendril-key': page.pathname.split('/')[2],
        'x-tendril-origin': page.origin, 'x-tendril-base': page.pathname, 'x-tendril-rest': encodeURIComponent(rest),
      } }));
      const first = await request('');
      const html = await first.text();
      expect(first.status).toBe(200);
      expect(html).toContain('cost page');
      expect(first.headers.get('Server-Timing')).toMatch(/object;dur=\d+/);
      const tag = first.headers.get('ETag')!;
      const { calls, restore } = countBytes(t);
      try {
        const revalidated = await request('', { 'If-None-Match': tag });
        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.get('ETag')).toBe(tag);
        const again = await request('');
        expect(again.status).toBe(200);
        expect(await again.text()).toBe(html);
        // Revalidation and unchanged renders touch neither R2 nor the Cache API.
        expect(calls).toEqual({ r2: 0, cache: 0 });
        // A changed injected input (page name) changes the tag and renders again.
        t.db.set('name', 'Renamed page');
        const renamed = await request('', { 'If-None-Match': tag });
        expect(renamed.status).toBe(200);
        expect(renamed.headers.get('ETag')).not.toBe(tag);
        await renamed.text();
        expect(calls.r2 + calls.cache).toBeGreaterThan(0);
        // Non-HTML revalidation is answered from metadata as well.
        const before = { ...calls };
        const script = await request('app.js', { 'If-None-Match': `"${files.get('app.js').hash}"` });
        expect(script.status).toBe(304);
        expect(calls).toEqual(before);
      } finally { restore(); }
    });
  });
});
