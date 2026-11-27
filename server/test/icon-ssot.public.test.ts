import { describe, expect, it } from 'vitest';
import { BASE, create, inDO, req, stub } from './helpers';
import { createVersion, storeContent, type VersionFile } from '../src/files';

const SVG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#0ea5e9"/></svg>';

describe('Page Icons SSOT & cookieless capability URLs (#154)', () => {
  it('extracts authored <link rel="icon"> into manifest & dashboard summary and serves every manifest icon URL anonymously (CookiePolicy.OMIT)', async () => {
    const h = await create({ name: 'Sky Notes' });
    const html = '<!doctype html><html><head><title>Sky</title><meta name="theme-color" content="#0ea5e9"><link rel="icon" type="image/svg+xml" href="icon.svg"></head><body>Hi</body></html>';
    await inDO(h.id, async (t) => {
      const htmlBuf = new TextEncoder().encode(html).slice().buffer;
      const svgBuf = new TextEncoder().encode(SVG_ICON).slice().buffer;
      const h1 = await storeContent(t, htmlBuf, 'text/html; charset=utf-8');
      const h2 = await storeContent(t, svgBuf, 'image/svg+xml');
      const map = new Map<string, VersionFile>([
        ['index.html', { path: 'index.html', hash: h1.hash, type: 'text/html; charset=utf-8', size: h1.size }],
        ['icon.svg', { path: 'icon.svg', hash: h2.hash, type: 'image/svg+xml', size: h2.size }],
      ]);
      await createVersion(t, map, 'initial', 'test', {
        entry: 'index.html',
        beforeCommit: async () => {},
        commit: () => {},
      });
    });

    // 1. Fetch manifest.webmanifest as authenticated owner
    const manifestRes = await req(h.page_url + '_tendril/manifest.webmanifest');
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json() as {
      theme_color: string;
      launch_handler?: { client_mode: string[] };
      icons: Array<{ src: string; sizes: string; type?: string; purpose: string }>;
    };
    expect(manifest.theme_color).toBe('#0ea5e9');
    expect(manifest.launch_handler?.client_mode).toContain('focus-existing');
    expect(manifest.icons.length).toBeGreaterThan(0);

    // 2. Every manifest icon URL must succeed with 200 OK with ZERO cookies (Firefox Android CookiePolicy.OMIT)
    const origin = new URL(h.page_url).origin;
    let sawAuthored = false;
    for (const ic of manifest.icons) {
      const targetUrl = new URL(ic.src, origin).href;
      const anonRes = await req(targetUrl, { method: 'GET', anonymous: true, redirect: 'manual' });
      expect(anonRes.status).toBe(200);
      if (ic.src.includes('/_tendril/icon-blob/') && ic.src.endsWith('/authored')) {
        sawAuthored = true;
        expect(anonRes.headers.get('Content-Type')).toContain('image/svg+xml');
        expect(anonRes.headers.get('Cache-Control')).toContain('immutable');
        expect(anonRes.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
        expect(await anonRes.text()).toContain('#0ea5e9');
      } else {
        await anonRes.body?.cancel();
      }
    }
    expect(sawAuthored).toBe(true);

    // 3. Forged signature on /_tendril/icon-blob must fail closed with 404
    const authoredEntry = manifest.icons.find(ic => ic.src.includes('/_tendril/icon-blob/'))!;
    const forgedUrl = new URL(authoredEntry.src.replace(/\/[a-f0-9]{32}\//, `/${'0'.repeat(32)}/`), origin).href;
    const forgedRes = await req(forgedUrl, { method: 'GET', anonymous: true, redirect: 'manual' });
    expect(forgedRes.status).toBe(404);
    await forgedRes.body?.cancel();

    // 4. Dashboard summary exposes cookieless icon_url reachable on the service origin without page cookies
    const summaryRes = await stub(h.id).fetch(new Request('https://tendril.internal/account/summary', {
      headers: { 'x-account-id': h.account! },
    }));
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as { icon_url: string | null; theme_color: string | null };
    expect(summary.icon_url).toMatch(/^\/_tendril\/icon-blob\//);
    expect(summary.theme_color).toBe('#0ea5e9');
    const dashIconRes = await req(new URL(summary.icon_url!, BASE).href, { method: 'GET', anonymous: true, redirect: 'manual' });
    expect(dashIconRes.status).toBe(200);
    expect(await dashIconRes.text()).toContain('#0ea5e9');
  });
});
