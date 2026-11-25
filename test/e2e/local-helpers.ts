import { expect, request, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { createAgentClient } from '../../dist/sdk/client.mjs';
import { publishAssetGraph } from './publication-helpers';

export const SERVICE = 'https://service.localhost:8790';
export const OWNER = 'owner@example.test';
export const OWNER_TOKEN = 'tendriller-local-e2e-session';
export const OTHER_TOKEN = 'tendriller-local-e2e-other-session';
export const LOGOUT_TOKEN = 'tendriller-local-e2e-logout-session';
let nextIp = 1;
let localRequest: Promise<APIRequestContext> | undefined;
export function requester() { return localRequest ??= request.newContext({ ignoreHTTPSErrors: true }); }
/** A page plus the account-level credential of the agent that created it. */
export type Handle = { id: string; page_url: string; api: string; token: string; agent: { id: string }; application: { id: string } };
const clients = new Map<string, ReturnType<ReturnType<typeof createAgentClient>['page']>>();

/** A base64url Ed25519 public key, the agent's shared page signing key. */
export function agentPublicKey() {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string;
}

/** A new unclaimed agent for `owner` creates one page; the owner claims both by signing in. */
export async function createPage(owner = OWNER): Promise<Handle> {
  const ip = `198.18.${Math.floor(nextIp / 250)}.${nextIp++ % 250 + 1}`;
  const http = await requester();
  const registered = await http.post(`${SERVICE}/api/agents`, { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    data: { owner, name: 'e2e-agent', publicKey: agentPublicKey() } });
  expect(registered.status(), await registered.text()).toBe(201);
  const { token, agent } = await registered.json() as { token: string; agent: { id: string } };
  const response = await http.post(`${SERVICE}/api/agent/pages`, { headers: {
    'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Authorization: `Bearer ${token}`,
  }, data: { name: 'E2E page' } });
  expect(response.status(), await response.text()).toBe(201);
  return { ...await response.json(), token, agent } as Handle;
}

export function client(handle: Handle) {
  let value = clients.get(handle.id);
  if (!value) {
    value = createAgentClient({ service: SERVICE, token: handle.token }, { fetch: async (url, init) => {
      const response = await (await requester()).fetch(String(url), {
        method: init?.method, headers: init?.headers as Record<string, string>,
        data: init?.body as string | undefined,
      });
      return new Response(response.status() === 204 ? null : await response.body(), {
        status: response.status(), headers: response.headers(),
      });
    } }).page(handle.id, { applicationId: handle.application.id });
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
export function publishFiles(handle: Handle, files: Record<string, { type: string; body: string | Uint8Array }>) {
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
  const http = await requester(), headers = { Authorization: `Bearer ${handle.token}` };
  await http.delete(handle.api, { headers });
  // Each page has its own agent; revoking it keeps the owner's unclaimed-agent capacity free.
  await http.delete(`${SERVICE}/api/agent`, { headers });
}
