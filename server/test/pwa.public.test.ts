import { describe, expect, it } from 'vitest';
import { api, apiJson, create, req } from './helpers';

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
    await apiJson(handle, 'PATCH', '', { icon: '🌱' });
    for (const route of ['manifest.webmanifest', 'icon', 'icon.svg', 'icon-maskable.svg']) {
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

  it('converts configured emoji into private SVG artwork and supports changing or resetting it', async () => {
    const handle = await create({ name: 'Garden notes' });
    const base = new URL(handle.page_url).pathname;
    for (const icon of ['🌱', '❤️', '👍🏽', '🧑🏽‍🚀', '👨‍👩‍👧‍👦', '🇦🇹', '1️⃣']) {
      const updated = await apiJson(handle, 'PATCH', '', { icon });
      expect(updated.meta.icon).toBe(icon);
      expect((await apiJson(handle, 'GET', '')).meta.icon).toBe(icon);
      for (const route of ['icon', 'icon.svg']) {
        const response = await req(handle.page_url + '_tendril/' + route);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
        expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(await response.text()).toContain(`>${icon}</text>`);
      }
      const manifest = await (await req(handle.page_url + '_tendril/manifest.webmanifest')).json() as Manifest;
      expect(manifest.icons).toEqual([
        { src: `${base}_tendril/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: `${base}_tendril/icon-maskable.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
      ]);
    }

    expect((await apiJson(handle, 'PATCH', '', { icon: null })).meta.icon).toBeNull();
    const reset = await (await req(handle.page_url + '_tendril/icon.svg')).text();
    expect(reset).toContain('>G</text>');
    expect(reset).not.toContain('1️⃣');
    const manifest = await (await req(handle.page_url + '_tendril/manifest.webmanifest')).json() as Manifest;
    expect(manifest.icons).toHaveLength(3);
    expect(manifest.icons).toContainEqual({ src: `${base}_tendril/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' });
    expect(manifest.icons).toContainEqual({ src: `${base}_tendril/icon-maskable.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' });
  });

  it('rejects invalid icons without replacing the configured emoji', async () => {
    const handle = await create();
    await apiJson(handle, 'PATCH', '', { icon: '🌱' });
    for (const icon of ['', 'garden', '🌱🌻', '🌱 garden', '1', 'http://example.test/icon.png',
      'javascript:alert(1)', 'data:image/svg+xml,<svg/>', '<svg onload="alert(1)">🌱</svg>', 123, true, {}, ['🌱']]) {
      const response = await api(handle, 'PATCH', '', { icon });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'bad_request', message: 'icon must be a single emoji, an https URL, or null to reset' } });
      expect((await apiJson(handle, 'GET', '')).meta.icon).toBe('🌱');
    }
  });

  it('uses custom installation artwork in supported formats and defaults for other formats', async () => {
    const handle = await create();
    for (const [icon, type] of [
      ['https://images.example.test/app.svg?version=2', 'image/svg+xml'],
      ['https://images.example.test/app.webp', 'image/webp'],
      ['https://images.example.test/app.PNG', 'image/png'],
      ['https://images.example.test/app.jpg', undefined],
      ['https://images.example.test/dynamic-icon', undefined],
      [null, undefined],
    ]) {
      await apiJson(handle, 'PATCH', '', { icon });
      const manifest = await (await req(handle.page_url + '_tendril/manifest.webmanifest')).json() as Manifest;
      const base = new URL(handle.page_url).pathname;
      const maskable = { src: `${base}_tendril/icon-maskable.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' };
      if (type) {
        expect(manifest.icons).toEqual([{ src: icon, type, sizes: 'any', purpose: 'any' }, maskable]);
      } else {
        expect(manifest.icons).toEqual([
          { src: '/_tendril/brand/icon-180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
          { src: `${base}_tendril/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          maskable,
        ]);
      }
    }
  });
});
