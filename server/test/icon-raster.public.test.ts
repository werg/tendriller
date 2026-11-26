import { expect, it } from 'vitest';
import { create, apiJson, inDO, req } from './helpers';
import { appleTouchIcon, imageSize } from '../src/icon-raster';

function png(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
type Icon = { src: string; sizes: string; type: string; purpose: string };

it('owner pages draw emoji icons into sized PNGs that the manifest offers to Android first', async () => {
  const h = await create({ name: 'Garden' });
  await apiJson(h, 'PATCH', '', { icon: '🌱' });
  const html = await (await req(h.page_url)).text();
  const key = /"iconRaster":\{"key":("(?:[^"\\]|\\.)*")\}/.exec(html);
  // Before owner rasterization completes, brand 192/512 PNGs satisfy Chromium installability
  // on first load, and no page-specific raster PNG exists yet.
  const manifest = async () => (await (await req(h.page_url + '_tendril/manifest.webmanifest')).json() as { icons: Icon[] }).icons;
  expect((await manifest()).some(icon => icon.src.includes('_tendril/icon-512.png'))).toBe(false);
  expect((await manifest()).some(icon => icon.src === '/_tendril/brand/icon-192.png' && icon.sizes === '192x192')).toBe(true);
  const iconKey = key ? JSON.parse(key[1]!) as string : JSON.stringify([1, '🌱', '#2d6a4f']);
  const origin = new URL(h.page_url).origin, json = { 'Content-Type': 'application/json', Origin: origin };
  expect((await req(h.page_url + '_tendril/icon-raster', { method: 'POST', headers: json, body: JSON.stringify({ key: iconKey, any: png(64, 64), maskable: png(512, 512) }) })).status).toBe(400);
  expect((await req(h.page_url + '_tendril/icon-raster', { method: 'POST', headers: json, body: JSON.stringify({ key: 'stale', any: png(512, 512), maskable: png(512, 512) }) })).status).toBe(409);
  expect((await req(h.page_url + '_tendril/icon-raster', { method: 'POST', headers: json, body: JSON.stringify({ key: iconKey, any: png(512, 512), maskable: png(512, 512) }) })).status).toBe(204);
  const icons = await manifest();
  expect(icons[0]).toMatchObject({ sizes: '512x512', type: 'image/png', purpose: 'any' });
  expect(icons[1]).toMatchObject({ sizes: '512x512', type: 'image/png', purpose: 'maskable' });
  expect(icons.some(icon => icon.src.includes('/_tendril/brand/'))).toBe(false);
  // iOS gets the opaque full-bleed PNG (it turns transparency black).
  const base = new URL(h.page_url).pathname;
  expect(await inDO(h.id, t => appleTouchIcon(t, base, h.page_url))).toEqual({ href: icons[1]!.src, sizes: '512x512' });
  const served = await req(new URL(icons[0]!.src, h.page_url).href);
  expect(served.status).toBe(200); expect(served.headers.get('content-type')).toBe('image/png');
  // A different emoji or theme makes the stored pair stale until the owner's page redraws it.
  await apiJson(h, 'PATCH', '', { theme_color: '#112233' });
  expect((await manifest()).some(icon => icon.src.includes('_tendril/icon-512.png'))).toBe(false);
  expect((await manifest()).some(icon => icon.src === '/_tendril/brand/icon-192.png')).toBe(true);
  expect((await req(h.page_url + '_tendril/icon-512.png')).status).toBe(404);
  expect(await inDO(h.id, t => appleTouchIcon(t, base, h.page_url))).toBeNull();
});

it('only the owner may store home-screen icons', async () => {
  const h = await create();
  await apiJson(h, 'PATCH', '', { icon: '🌱' });
  const display = await apiJson<{ url: string }>(h, 'POST', 'links', { role: 'display' }).catch(() => null);
  if (!display?.url) return;
  const denied = await req(display.url + '_tendril/icon-raster', { anonymous: true, method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(display.url).origin }, body: JSON.stringify({ key: 'x', any: png(512, 512), maskable: png(512, 512) }) });
  expect(denied.status).toBe(403);
});

it('reads real pixel sizes from PNG, GIF, WebP and JPEG headers', () => {
  expect(imageSize(Uint8Array.from(atob(png(192, 96)), c => c.charCodeAt(0)))).toEqual({ type: 'image/png', width: 192, height: 96 });
  const gif = new Uint8Array(10); gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x02, 0x00, 0x01]);
  expect(imageSize(gif)).toEqual({ type: 'image/gif', width: 512, height: 256 });
  const webp = new Uint8Array(30); webp.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); webp.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8);
  webp.set([0xff, 0x01, 0x00, 0xff, 0x01, 0x00], 24);
  expect(imageSize(webp)).toEqual({ type: 'image/webp', width: 512, height: 512 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x80, 0x02, 0x00, 0x03]);
  expect(imageSize(jpeg)).toEqual({ type: 'image/jpeg', width: 512, height: 384 });
});

it('default letter pages also rasterize into page-specific 512px PNGs for mobile favicons and manifests', async () => {
  const h = await create({ name: 'Daily Anchor' });
  const iconKey = JSON.stringify([2, 'D', '#2d6a4f']);
  const origin = new URL(h.page_url).origin;
  const res = await req(h.page_url + '_tendril/icon-raster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ key: iconKey, any: png(512, 512), maskable: png(512, 512) }),
  });
  expect(res.status).toBe(204);
  const manifest = await (await req(h.page_url + '_tendril/manifest.webmanifest')).json() as { icons: Icon[] };
  expect(manifest.icons[0]).toMatchObject({ sizes: '512x512', type: 'image/png', purpose: 'any' });
  expect(manifest.icons.some(icon => icon.src.includes('/_tendril/brand/'))).toBe(false);
  const base = new URL(h.page_url).pathname;
  expect(await inDO(h.id, t => appleTouchIcon(t, base, h.page_url))).toEqual({ href: manifest.icons[1]!.src, sizes: '512x512' });
});
