import { expect, test } from "@playwright/test";

type Handle = { id: string; page_url: string; api: string; token: string };
const base = process.env.E2E_SERVICE_BASE;
const owner = process.env.E2E_OWNER_EMAIL;
if (!base || !owner || new URL(base).protocol !== "https:") {
  throw new Error("Set E2E_SERVICE_BASE and E2E_OWNER_EMAIL for a staging owner account");
}

async function makePage(name: string): Promise<Handle> {
  const created = await fetch(`${base}/api/tendrils`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, owner }) });
  expect(created.status, await created.clone().text()).toBe(201);
  const handle = await created.json() as Handle;
  const upload = await fetch(`${handle.api}/files/index.html`, { method: "PUT",
    headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "text/html" },
    body: `<!doctype html><html><title>${name}</title><p>${name}</p></html>` });
  expect(upload.ok, await upload.clone().text()).toBeTruthy();
  return handle;
}

test("two tendril origins isolate storage, sessions, mutations, and WebSockets", async ({ page, context }) => {
  const first = await makePage(`Isolation A ${Date.now()}`);
  const second = await makePage(`Isolation B ${Date.now()}`);
  try {
    expect(new URL(first.page_url).origin).not.toBe(new URL(second.page_url).origin);
    await page.goto(first.page_url);
    await expect(page.locator("body")).toContainText("Isolation A");
    await page.evaluate(() => localStorage.setItem("isolation-proof", "from-a"));
    const other = await context.newPage();
    await other.goto(second.page_url);
    await expect(other.locator("body")).toContainText("Isolation B");
    expect(await other.evaluate(() => localStorage.getItem("isolation-proof"))).toBeNull();

    // A sibling origin cannot overwrite a __Host- page session cookie.
    await page.evaluate(domain => { document.cookie = `__Host-tendril=forged; Domain=${domain}; Path=/; Secure`; },
      new URL(first.page_url).hostname.split(".").slice(1).join("."));
    await other.reload();
    await expect(other.locator("body")).toContainText("Isolation B");

    const reportUrl = `${second.page_url}_tendril/report`;
    const blocked = page.waitForResponse(res => res.url() === reportUrl && res.request().method() === "POST");
    await page.evaluate(async url => {
      await fetch(url, { method: "POST", credentials: "include", mode: "no-cors",
        body: new URLSearchParams({ reason: "cross-origin probe" }) }).catch(() => {});
    }, reportUrl);
    expect((await blocked).status()).toBe(403);

    const wsUrl = `${second.page_url.replace(/^https:/, "wss:")}_tendril/ws`;
    const opened = await page.evaluate(url => new Promise<boolean>(resolve => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); resolve(false); }, 3000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
    }), wsUrl);
    expect(opened).toBe(false);
  } finally {
    await Promise.allSettled([first, second].map(h => fetch(h.api, { method: "DELETE", headers: { Authorization: `Bearer ${h.token}` } })));
  }
});
