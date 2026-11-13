import { expect, type Page } from "@playwright/test";

export const BASE = "http://localhost:8790";

export interface Handle { id: string; page_url: string; api: string; token: string }

export async function createTendril(body: object = {}): Promise<Handle> {
  const r = await fetch(`${BASE}/api/tendrils`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status, await r.clone().text()).toBe(201);
  return r.json();
}

export async function api(h: Handle, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${h.token}`, ...(init.headers as any) };
  let body = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] = "application/json"; }
  const r = await fetch(`${h.api}${path}`, { ...init, headers, body });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, data };
}

export async function upload(h: Handle, html: string, path = "index.html") {
  const r = await api(h, `/files/${path}`, { method: "PUT", body: html, headers: { "content-type": "text/html" } });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.version as number;
}

/** Waits until the page has a connected tendril runtime. */
export async function openPage(page: Page, h: Handle, url = h.page_url) {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).tendril && (window as any).tendril.connected === true, null, { timeout: 15_000 });
}

export async function waitForVersionStatus(h: Handle, version: number, status: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(h, "/versions");
    const v = r.data.versions?.find((x: any) => x.version === version);
    if (v?.status === status) return r.data;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`version ${version} did not become ${status}`);
}

export const page = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;
