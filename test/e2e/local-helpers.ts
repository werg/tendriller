import { expect, request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "../../dist/sdk/client.mjs";
import { publishAssetGraph } from "./publication-helpers";
import WebSocket from "ws";

export const SERVICE = "https://service.localhost:8790";
export const OWNER = "owner@example.test";
export const OWNER_TOKEN = "tendriller-local-e2e-session";
export const OTHER_TOKEN = "tendriller-local-e2e-other-session";
let nextIp = 1;
let localRequest: Promise<APIRequestContext> | undefined;

export function requester() {
  return localRequest ??= request.newContext({ ignoreHTTPSErrors: true });
}

export type Handle = { id: string; page_url: string; api: string; token: string; agent_setup?: { next_step: string } };

const agentSockets = new Map<string, WebSocket>();

/** A live authenticated socket, not an HTTP-held request, establishes interactive delivery. */
export async function connectAgentSocket(h: Handle): Promise<WebSocket> {
  const previous = agentSockets.get(h.id);
  if (previous?.readyState === WebSocket.OPEN) return previous;
  const url = new URL(h.api + "/events/socket");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url.toString(), ["tendriller.agent.v2", h.token], {
    rejectUnauthorized: false, // local E2E server uses a self-signed certificate
    lookup: (_host, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      if (typeof options !== "function" && options?.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    },
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("open", () => { socket.off("error", onError); resolve(); });
  });
  socket.on("error", () => {}); // connection errors are observed by presence assertions
  agentSockets.set(h.id, socket);
  socket.once("close", () => { if (agentSockets.get(h.id) === socket) agentSockets.delete(h.id); });
  return socket;
}

export async function disconnectAgentSocket(h: Handle) {
  const socket = agentSockets.get(h.id);
  if (!socket) return;
  agentSockets.delete(h.id);
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  socket.terminate();
  await closed;
}

export async function createPage(owner = OWNER): Promise<Handle> {
  const res = await (await requester()).post(`${SERVICE}/api/tendrils`, { headers: {
    "Content-Type": "application/json", "CF-Connecting-IP": `198.18.0.${nextIp++}`,
  }, data: JSON.stringify({ owner, name: "E2E page", application: { kind: "cloudflare", id: `cf:${crypto.randomUUID()}` } }) });
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
  await connectAgentSocket(h);
  await expect.poll(async () => (await agent(h)).data.presence.state).toBe("listening");
  return publishFiles(h, { "index.html": { type: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body>${body}</body></html>` } });
}

export function publishFiles(h: Handle, files: Record<string, { type: string; body: string }>) {
  const client = createClient(h, { fetch: async (url, init) => {
    const response = await (await requester()).fetch(String(url), {
      method: init?.method, headers: init?.headers as Record<string, string>,
      data: init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body as string | undefined,
    });
    return new Response(response.status() === 204 ? null : await response.body(), {
      status: response.status(), headers: response.headers(),
    });
  } });
  return publishAssetGraph(client, files);
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
  await disconnectAgentSocket(h);
  await (await requester()).delete(h.api, { headers: { Authorization: `Bearer ${h.token}` } });
}
