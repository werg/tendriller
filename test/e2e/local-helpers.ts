import { expect, request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

export const SERVICE = "https://service.localhost:8790";
export const OWNER = "owner@example.test";
export const OWNER_TOKEN = "tendriller-local-e2e-session";
export const OTHER_TOKEN = "tendriller-local-e2e-other-session";
let nextIp = 1;
let localRequest: Promise<APIRequestContext> | undefined;

export function requester() {
  return localRequest ??= request.newContext({ ignoreHTTPSErrors: true });
}

export type Handle = { id: string; page_url: string; api: string; token: string; agent_reminder?: string };

export async function createPage(owner = OWNER): Promise<Handle> {
  const res = await (await requester()).post(`${SERVICE}/api/tendrils`, { headers: {
    "Content-Type": "application/json", "CF-Connecting-IP": `198.18.0.${nextIp++}`,
  }, data: JSON.stringify({ owner, name: "E2E page" }) });
  expect(res.status(), await res.text()).toBe(201);
  return res.json() as Promise<Handle>;
}

export async function agent(h: Handle, path = "", method = "GET", body?: unknown) {
  const res = await (await requester()).fetch(`${h.api}${path}`, { method, headers: {
    Authorization: `Bearer ${h.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  }, data: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: res.status(), data };
}

export async function publish(h: Handle, body: string) {
  // First interactive publication requires an active listener. Keep a real poll held
  // while uploading; it may finish when the version event arrives or after 25 seconds.
  void agent(h, "/events?after=0&wait=25").catch(() => {});
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await agent(h)).data.presence.state === "listening") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const res = await (await requester()).put(`${h.api}/files/index.html`, { headers: {
    Authorization: `Bearer ${h.token}`, "Content-Type": "text/html",
  }, data: `<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body>${body}</body></html>` });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

export function localPageUrl(h: Handle): string {
  const url = new URL(h.page_url);
  url.port = "8790";
  return url.href;
}

export async function signInFixture(context: BrowserContext, token = OWNER_TOKEN) {
  await context.addCookies([{ name: "__Host-tendriller", value: token, domain: "service.localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
}

export async function claim(context: BrowserContext, h: Handle) {
  const initial = await context.request.get(localPageUrl(h), { maxRedirects: 0 });
  expect(initial.status()).toBe(302);
  const auth = await context.request.get(initial.headers().location, { maxRedirects: 0 });
  if (auth.status() !== 303) return auth;
  const redeem = new URL(auth.headers().location);
  redeem.port = "8790"; // Production page URLs intentionally omit the test server port.
  const session = await context.request.get(redeem.href, { maxRedirects: 0 });
  expect(session.status()).toBe(303);
  return session;
}

export async function openClaimed(page: Page, h: Handle) {
  await claim(page.context(), h);
  await page.goto(localPageUrl(h));
  await page.waitForURL(url => url.hostname.endsWith(".pages.localhost") && url.port === "8790", { timeout: 15_000 });
  await page.waitForFunction(() => (window as any).tendril?.connected === true, { timeout: 15_000 });
}

export async function deletePage(h: Handle) {
  await (await requester()).delete(h.api, { headers: { Authorization: `Bearer ${h.token}` } });
}
