import { expect, request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

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
  return publishAssets(h, { "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body>${body}</body></html>` });
}

export async function uploadAsset(h: Handle, content: string, type = "text/html") {
  const bytes = Buffer.from(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const started = await agent(h, "/uploads", "POST", { cid: randomUUID(), sha256, size: bytes.length, type });
  expect(started.status).toBe(201);
  if (started.data.upload_required) {
    const contentResponse = await (await requester()).put(`${h.api}/uploads/${started.data.id}/content`, {
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/octet-stream" }, data: bytes });
    expect(contentResponse.status(), await contentResponse.text()).toBe(204);
  }
  const finished = await agent(h, `/uploads/${started.data.id}/complete`, "POST", {});
  expect(finished.status).toBe(200);
  return finished.data.blob;
}

export async function publishAssets(h: Handle, content: Record<string, string>) {
  const head = await agent(h, "/publications");
  expect(head.status).toBe(200);
  const files = [];
  for (const [path, data] of Object.entries(content)) {
    const type = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "text/javascript" : "text/plain";
    const blob = await uploadAsset(h, data, type);
    files.push({ path, blob_id: blob.id, type });
  }
  const result = await agent(h, "/publications", "POST", { cid: randomUUID(), expected_generations: {},
    expected_head_revision: head.data.head_revision, entry: "index.html", files });
  expect(result.status).toBe(200);
  return result.data;
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
