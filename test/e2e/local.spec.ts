import { test, expect } from "@playwright/test";
import { agent, claim, createPage, deletePage, localPageUrl, openClaimed, publish, requester, signInFixture, OTHER_TOKEN } from "./local-helpers";

test("email invitation auto-claims for a verified account and opens the published page", async ({ page, context }) => {
  const h = await createPage();
  try {
    expect(h.page_url).toMatch(/^https:\/\/[a-z2-7]{12}\.pages\.localhost\/s\/[a-z2-7]{26}\/$/);
    expect(h.token).toMatch(/^tk_/);
    await publish(h, '<h1 id="welcome">Hello, owner</h1>');
    await signInFixture(context);
    await openClaimed(page, h);
    await expect(page.locator("#welcome")).toHaveText("Hello, owner");
    expect(await page.evaluate(() => (window as any).tendril.device.role)).toBe("owner");
    expect(page.url()).not.toContain("/auth/page");
  } finally { await deletePage(h); }
});

test("unverified email cannot claim another person's page", async ({ page, context }) => {
  const h = await createPage();
  try {
    await signInFixture(context, OTHER_TOKEN);
    const denied = await claim(context, h);
    expect(denied.status()).toBe(403);
    expect(await denied.text()).toMatch(/not|match|forbidden|verified/i);
  } finally { await deletePage(h); }
});

test("agent reminder and each event poll point to the next continuous poll", async () => {
  const h = await createPage();
  try {
    expect(JSON.stringify(h)).toMatch(/poll|listen/i);
    const first = await agent(h, "/events?wait=0");
    expect(first.status).toBe(200);
    expect(first.data.next_poll).toContain(`/api/t/${h.id}/events?after=`);
    expect(first.data.agent_reminder).toMatch(/poll|listen/i);
    const next = await agent(h, `/events?after=${first.data.cursor}&wait=1`);
    expect(next.status).toBe(200);
    expect(next.data.events).toEqual([]);
    expect(next.data.next_poll).toContain("wait=25");
    expect(next.data.agent_reminder).toMatch(/poll|listen/i);
  } finally { await deletePage(h); }
});

test("first interactive publication requires a live listener", async () => {
  const h = await createPage();
  try {
    const res = await (await requester()).put(`${h.api}/files/index.html`, { headers: {
      Authorization: `Bearer ${h.token}`, "Content-Type": "text/html",
    }, data: "<!doctype html><button>Tap</button>" });
    expect(res.status()).toBe(428);
    expect(await res.text()).toMatch(/listener_required|listen|poll/i);
    await publish(h, "<button>Tap</button>");
  } finally { await deletePage(h); }
});

test("page tap reaches a held poll and agent speech reply reaches the page", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, '<button id="send" onclick="tendril.send({kind:\'tap\',value:7})">Send</button>');
    await signInFixture(context);
    await openClaimed(page, h);
    const initial = await agent(h, "/events?wait=0");
    const poll = agent(h, `/events?after=${initial.data.cursor}&wait=10`);
    await expect.poll(async () => (await agent(h)).data.presence.state).toBe("listening");
    await page.locator("#send").click();
    const events = await poll;
    expect(events.data.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "event", role: "owner", data: { kind: "tap", value: 7 } })]));
    const say = await agent(h, "/say", "POST", { text: "I heard your tap", speak: false });
    expect(say.status).toBe(200);
    await expect(page.locator("body")).toContainText("I heard your tap");
  } finally { await deletePage(h); }
});

test("presence distinguishes active polling from away and explicit working", async ({ page, context }) => {
  const h = await createPage();
  try {
    await signInFixture(context);
    await openClaimed(page, h);
    await agent(h, "/events?wait=0");
    await expect.poll(async () => (await agent(h)).data.presence.state).toBe("away");
    const cursor = (await agent(h, "/events?wait=0")).data.cursor;
    const held = agent(h, `/events?after=${cursor}&wait=3`);
    await expect.poll(async () => (await agent(h)).data.presence.state).toBe("listening");
    await held;
    await expect.poll(async () => (await agent(h)).data.presence.state).toBe("away");
    expect((await agent(h, "/status", "POST", { state: "working", text: "Thinking" })).data.presence.state).toBe("working");
  } finally { await deletePage(h); }
});

test("cross-page origin cannot mutate a sibling page", async ({ browser }) => {
  const a = await createPage(); const b = await createPage();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await signInFixture(context);
    const pa = await context.newPage(); const pb = await context.newPage();
    await openClaimed(pa, a); await openClaimed(pb, b);
    expect(new URL(pa.url()).origin).not.toBe(new URL(pb.url()).origin);
    await pa.evaluate(() => localStorage.setItem("e2e-origin", "a"));
    expect(await pb.evaluate(() => localStorage.getItem("e2e-origin"))).toBeNull();
    const reportUrl = `${localPageUrl(b)}_tendril/report`;
    const blocked = pa.waitForResponse(response => response.url() === reportUrl && response.request().method() === "POST");
    await pa.evaluate(async url => { await fetch(url, { method: "POST", mode: "no-cors", credentials: "include", body: "reason=probe" }).catch(() => {}); }, reportUrl);
    expect((await blocked).status()).toBe(403);
  } finally { await context.close(); await Promise.all([deletePage(a), deletePage(b)]); }
});

test("agent can change the live DOM and a new published version reloads the browser", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, '<h1 id="version">one</h1>');
    await signInFixture(context);
    await openClaimed(page, h);
    await expect(page.locator("#version")).toHaveText("one");
    const evalResult = await agent(h, "/eval", "POST", { code: "document.querySelector('#version').textContent = 'changed'; return 42" });
    expect(evalResult.status).toBe(200);
    expect(evalResult.data.value).toBe(42);
    await expect(page.locator("#version")).toHaveText("changed");
    await publish(h, '<h1 id="version">two</h1>');
    await expect(page.locator("#version")).toHaveText("two", { timeout: 15_000 });
  } finally { await deletePage(h); }
});

test("browser event remains queued until the agent polls and is not duplicated", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, '<button id="tap" onclick="tendril.send({reading:19})">Record</button>');
    await signInFixture(context);
    await openClaimed(page, h);
    const before = (await agent(h, "/events?wait=0")).data.cursor;
    await page.locator("#tap").click();
    const first = await agent(h, `/events?after=${before}&wait=2`);
    expect(first.data.events.filter((e: any) => e.data?.reading === 19)).toHaveLength(1);
    const second = await agent(h, `/events?after=${first.data.cursor}&wait=0`);
    expect(second.data.events.filter((e: any) => e.data?.reading === 19)).toHaveLength(0);
  } finally { await deletePage(h); }
});

test("agent token is required for state mutation", async () => {
  const h = await createPage();
  try {
    const denied = await (await requester()).post(`${h.api}/say`, { data: { text: "forged" } });
    expect(denied.status()).toBe(401);
    const bad = await (await requester()).post(`${h.api}/say`, { headers: { Authorization: "Bearer tk_invalid" }, data: { text: "forged" } });
    expect(bad.status()).toBe(401);
  } finally { await deletePage(h); }
});
