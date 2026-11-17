import { expect, request, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '../../dist/sdk/client.mjs';
import { publishAssetGraph } from './publication-helpers';

export const SERVICE = 'https://service.localhost:8790';
export const OWNER = 'owner@example.test';
export const OWNER_TOKEN = 'tendriller-local-e2e-session';
export const OTHER_TOKEN = 'tendriller-local-e2e-other-session';
let nextIp = 1;
let localRequest: Promise<APIRequestContext> | undefined;
export function requester() { return localRequest ??= request.newContext({ ignoreHTTPSErrors: true }); }
export type Handle = { id: string; page_url: string; api: string; token: string; application: { id: string } };
const clients = new Map<string, ReturnType<typeof createClient>>();

export async function createPage(owner = OWNER): Promise<Handle> {
  const response = await (await requester()).post(`${SERVICE}/api/tendrils`, { headers: {
    'Content-Type': 'application/json', 'CF-Connecting-IP': `198.18.0.${nextIp++}`,
  }, data: { owner, name: 'E2E page' } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<Handle>;
}

export function client(handle: Handle) {
  let value = clients.get(handle.id);
  if (!value) {
    value = createClient(handle, { applicationId: handle.application.id, fetch: async (url, init) => {
      const response = await (await requester()).fetch(String(url), {
        method: init?.method, headers: init?.headers as Record<string, string>,
        data: init?.body as string | undefined,
      });
      return new Response(response.status() === 204 ? null : await response.body(), {
        status: response.status(), headers: response.headers(),
      });
    } });
    clients.set(handle.id, value);
  }
  return value;
}

export async function agent(handle: Handle, path = '', method = 'GET', body?: unknown) {
  const response = await (await requester()).fetch(`${handle.api}${path}`, { method, headers: {
    Authorization: `Bearer ${handle.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, data: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status(), data };
}

export function publish(handle: Handle, body: string) {
  return publishFiles(handle, { 'index.html': { type: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body>${body}</body></html>` } });
}
export function publishFiles(handle: Handle, files: Record<string, { type: string; body: string }>) {
  return publishAssetGraph(client(handle).peers, files);
}
export function localPageUrl(handle: Handle) {
  const url = new URL(handle.page_url); url.port = '8790'; return url.href;
}
export async function signInFixture(context: BrowserContext, token = OWNER_TOKEN) {
  await context.addCookies([{ name: '__Host-tendriller', value: token, domain: 'service.localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}
export async function claim(context: Pick<BrowserContext, 'request'>, handle: Handle) {
  const initial = await context.request.get(localPageUrl(handle), { maxRedirects: 0 });
  if (initial.status() === 200) return initial;
  expect(initial.status()).toBe(302);
  const auth = await context.request.get(initial.headers().location, { maxRedirects: 0 });
  if (auth.status() !== 303) return auth;
  const redeem = new URL(auth.headers().location); redeem.port = '8790';
  const session = await context.request.get(redeem.href, { maxRedirects: 0 });
  expect(session.status()).toBe(303); return session;
}
export async function openClaimed(page: Page, handle: Handle) {
  await claim(page.context(), handle);
  await page.goto(localPageUrl(handle));
  await page.waitForURL(url => url.hostname.endsWith('.pages.localhost') && url.port === '8790', { timeout: 15_000 });
  await page.waitForFunction(() => typeof (window as any).tendril?.ready === 'function');
  await page.evaluate(() => (window as any).tendril.ready());
}
export async function deletePage(handle: Handle) {
  clients.delete(handle.id);
  await (await requester()).delete(handle.api, { headers: { Authorization: `Bearer ${handle.token}` } });
}
