import { describe, expect, it } from 'vitest';
import { apiJson, create, req } from './helpers';

interface Manifest {
  id: string; start_url: string; scope: string; display: string; name: string; short_name: string;
  theme_color: string; background_color: string;
  icons: { src: string; type?: string; sizes?: string; purpose?: string }[];
}

describe('page installation metadata', () => {
  it('keeps each authenticated page install identity stable and launches its latest publication', async () => {
    const first = await create({ name: 'Shopping list' });
    const second = await create({ name: 'Garden notes' });
    for (const handle of [first, second]) {
      const response = await req(handle.page_url + '_tendril/manifest.webmanifest');
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/manifest+json; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
      const manifest = await response.json() as Manifest;
      const base = new URL(handle.page_url).pathname;
      expect(manifest).toMatchObject({ name: handle.name, id: base, start_url: base, scope: base, display: 'standalone' });
      expect(new URL(manifest.start_url, handle.page_url).href).toBe(handle.page_url);
      expect(manifest.icons).toContainEqual({ src: `${base}_tendril/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' });
      expect(manifest.icons).toContainEqual({ src: '/_tendril/brand/icon-180.png', sizes: '180x180', type: 'image/png', purpose: 'any' });
      const svg = await req(new URL(`${base}_tendril/icon.svg`, handle.page_url).href);
      expect(svg.headers.get('Content-Type')).toBe('image/svg+xml');
      expect(await svg.text()).toContain('viewBox="0 0 512 512"');
      const png = await req(new URL('/_tendril/brand/icon-180.png', handle.page_url).href);
      expect(png.status).toBe(200);
      const bytes = new DataView(await png.arrayBuffer());
      expect(bytes.getUint32(16)).toBe(180);
      expect(bytes.getUint32(20)).toBe(180);
    }
    await apiJson(first, 'PATCH', '', { name: 'Shopping for home', short_name: 'Shopping', theme_color: '#123456', background_color: '#f0f0f0' });
    const changed = await (await req(first.page_url + '_tendril/manifest.webmanifest')).json() as Manifest;
    expect(changed).toMatchObject({ id: new URL(first.page_url).pathname, start_url: new URL(first.page_url).pathname,
      name: 'Shopping for home', short_name: 'Shopping', theme_color: '#123456', background_color: '#f0f0f0' });
    const html = await (await req(first.page_url)).text();
    expect(html).toContain('crossorigin="use-credentials"');
    expect(html).toContain('<meta name="theme-color" content="#123456">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Shopping">');
  });

  it('retains access gates for manifests and private page icons, including HEAD', async () => {
    const handle = await create();
    for (const route of ['manifest.webmanifest', 'icon', 'icon.svg']) {
      const url = handle.page_url + '_tendril/' + route;
      const head = await req(url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      for (const method of ['GET', 'HEAD']) {
        const denied = await req(url, { method, anonymous: true, redirect: 'manual' });
        expect(denied.status).toBe(302);
        expect(denied.headers.get('Location')).toContain('/auth/page?');
      }
    }
  });

  it('describes custom icon formats accurately and always retains an installable fallback', async () => {
    const handle = await create();
    for (const [icon, type, sizes] of [
      ['https://images.example.test/app.svg?version=2', 'image/svg+xml', 'any'],
      ['https://images.example.test/app.webp', 'image/webp', undefined],
      ['https://images.example.test/app.PNG', 'image/png', undefined],
      ['https://images.example.test/dynamic-icon', undefined, undefined],
    ]) {
      await apiJson(handle, 'PATCH', '', { icon });
      const manifest = await (await req(handle.page_url + '_tendril/manifest.webmanifest')).json() as Manifest;
      const custom = manifest.icons.at(-1)!;
      expect(custom.src).toBe(icon);
      expect(custom.type).toBe(type);
      expect(custom.sizes).toBe(sizes);
      expect(manifest.icons.some(entry => entry.src.endsWith('/icon.svg') && entry.sizes === 'any')).toBe(true);
      const fallback = await req(handle.page_url + '_tendril/icon.svg');
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get('Content-Type')).toBe('image/svg+xml');
    }
  });
});
