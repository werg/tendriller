import { expect, request, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { createAgentClient } from '../../dist/sdk/client.mjs';
import { newAgentSigner, publishAssetGraph, registrationKey, registrationWrapKey, type AgentSigner, type PublicationReceipt } from './publication-helpers';

import { LOCAL_WORKER_SERVICE } from '../../scripts/e2e-network.mjs';
export const SERVICE = LOCAL_WORKER_SERVICE;
export const OWNER = 'owner@example.test';
export const OWNER_TOKEN = 'tendriller-local-e2e-session';
export const OTHER_TOKEN = 'tendriller-local-e2e-other-session';
export const LOGOUT_TOKEN = 'tendriller-local-e2e-logout-session';
let nextIp = 1;
let localRequest: Promise<APIRequestContext> | undefined;
export function requester() { return localRequest ??= request.newContext({ ignoreHTTPSErrors: true }); }
/** A page plus the account-level credential of the agent that created it. */
export type PageHandle = { id: string; page_url: string; api: string; token: string; agent: { id: string }; application: { id: string } };
/** A created page plus the agent's one shared signing key, which signs every page's publications. */
export type Handle = PageHandle & { signer: AgentSigner };
const clients = new Map<string, ReturnType<ReturnType<typeof createAgentClient>['page']>>();

/**
 * One agent has one credential and one signing key shared by all of its pages. By default a new unclaimed
 * agent for `owner` registers that key and creates one page; the owner claims both by signing in. Pass an
 * existing `handle` to create a further page with the same agent: the host grants it to that agent
 * automatically and the same key signs its publications.
 */
export async function createPage(owner = OWNER, sameAgent?: Handle): Promise<Handle> {
  const ip = `198.18.${Math.floor(nextIp / 250)}.${nextIp++ % 250 + 1}`;
  const http = await requester();
  let token: string, agent: { id: string }, signer: AgentSigner;
  if (sameAgent) ({ token, agent, signer } = sameAgent);
  else {
    signer = await newAgentSigner();
    const registered = await http.post(`${SERVICE}/api/agents`, { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      data: { owner, handle: 'e2e-agent', publicKey: registrationKey(signer), wrapKey: registrationWrapKey() } });
    expect(registered.status(), await registered.text()).toBe(201);
    ({ token, agent } = await registered.json() as { token: string; agent: { id: string } });
  }
  const response = await http.post(`${SERVICE}/api/agent/pages`, { headers: {
    'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Authorization: `Bearer ${token}`,
  }, data: { name: 'E2E page' } });
  expect(response.status(), await response.text()).toBe(201);
  return { ...await response.json(), token, agent, signer } as Handle;
}

export function client(handle: PageHandle) {
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

export async function agent(handle: PageHandle, path = '', method = 'GET', body?: unknown) {
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
  return publishAssetGraph(client(handle).peers, handle.signer, files);
}
/** The host's selected signed publication (or the one with this ID), read through the public authority client. */
export async function selectedPublication(handle: PageHandle, id?: string) {
  return await client(handle).peers.publication(id) as PublicationReceipt | null;
}
export function localPageUrl(handle: Pick<PageHandle, 'page_url'>) {
  const url = new URL(handle.page_url); url.port = new URL(SERVICE).port; return url.href;
}
export async function signInFixture(context: BrowserContext, token = OWNER_TOKEN) {
  await context.addCookies([{ name: '__Host-tendriller', value: token, domain: 'service.localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}
export async function claim(context: Pick<BrowserContext, 'request'>, handle: Pick<PageHandle, 'page_url'>) {
  const initial = await context.request.get(localPageUrl(handle), { maxRedirects: 0 });
  if (initial.status() === 200) return initial;
  expect(initial.status()).toBe(302);
  const auth = await context.request.get(initial.headers().location, { maxRedirects: 0 });
  if (auth.status() !== 303) return auth;
  const redeem = new URL(auth.headers().location); redeem.port = new URL(SERVICE).port;
  const session = await context.request.get(redeem.href, { maxRedirects: 0 });
  expect(session.status()).toBe(303); return session;
}
export async function openClaimed(page: Page, handle: PageHandle) {
  await claim(page.context(), handle);
  await page.goto(localPageUrl(handle));
  await page.waitForURL(url => url.hostname.endsWith('.pages.localhost') && url.port === new URL(SERVICE).port, { timeout: 15_000 });
  await page.waitForFunction(() => typeof (window as any).tendril?.ready === 'function');
  await page.evaluate(() => (window as any).tendril.ready());
}
/** Deletes the page; revoking the agent too keeps the owner's unclaimed-agent capacity free. */
export async function deletePage(handle: PageHandle, { revokeAgent = true } = {}) {
  clients.delete(handle.id);
  const http = await requester(), headers = { Authorization: `Bearer ${handle.token}` };
  await http.delete(handle.api, { headers });
  if (revokeAgent) await http.delete(`${SERVICE}/api/agent`, { headers });
}
