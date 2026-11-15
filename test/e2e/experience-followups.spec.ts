import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { agent, claim, createPage, deletePage, localPageUrl, openClaimed, publish, signInFixture, OTHER_TOKEN } from "./local-helpers";

const recipe = (file: string) => readFileSync(new URL(`../../recipes/facilitated-session/${file}`, import.meta.url), "utf8");

test("private participant tasks and feedback cross real authenticated browser sessions", async ({ page, context, browser }) => {
  const h = await createPage(), guestContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await publish(h, "<p>Preparing this session</p>");
    expect((await agent(h, "/files", "POST", { replace: true, files: { "index.html": recipe("index.html"), "assignments.js": recipe("assignments.js") } })).status).toBe(200);
    await signInFixture(context); await openClaimed(page, h);
    const invite = await agent(h, "/links", "POST", { role: "guest" }); expect(invite.status).toBe(201);
    const guestHandle = { ...h, page_url: invite.data.url };
    await signInFixture(guestContext, OTHER_TOKEN); await claim(guestContext, guestHandle);
    const base = `${localPageUrl(h)}_tendril/`;
    const pending = await (await context.request.get(`${base}guests`)).json();
    expect(pending.guests).toHaveLength(1);
    const participant = pending.guests[0];
    expect((await context.request.post(`${base}guests/${participant.account_id}/${participant.link_id}/approve`, { headers: { Origin: new URL(base).origin } })).status()).toBe(200);
    const guestPage = await guestContext.newPage(); await openClaimed(guestPage, guestHandle);
    await page.getByRole("button", { name: "Refresh participants and tasks" }).click();
    await page.locator("#assignment-participant").selectOption(participant.account_id);
    await page.locator("#assignment-title").fill("Be the observer");
    await page.locator("#assignment-prompt").fill("Look for a quiet place and describe what you notice.");
    await page.getByRole("button", { name: "Assign privately", exact: true }).click();
    await expect(page.locator("#assignment-status")).toContainText("Task assigned privately");
    await guestPage.getByRole("button", { name: "Refresh my tasks" }).click();
    await expect(guestPage.locator("#my-tasks")).toContainText("Be the observer");
    await expect(page.locator("#my-tasks")).not.toContainText("Be the observer");
    await guestPage.locator("#my-tasks textarea").fill("The room is quiet beside the window.");
    await guestPage.getByRole("button", { name: "Send task answer" }).click();
    await expect(guestPage.locator("#task-status")).toContainText("Task answer saved privately");
    await page.getByRole("button", { name: "Refresh participants and tasks" }).click();
    await expect(page.locator("#assignment-list")).toContainText("quiet beside the window");
    await page.locator("#assignment-list textarea").fill("Use that observation as your starting point.");
    await page.getByRole("button", { name: "Save private feedback" }).click();
    await expect(page.locator("#assignment-status")).toContainText("Private task updated");
    await guestPage.getByRole("button", { name: "Refresh my tasks" }).click();
    await expect(guestPage.locator("#my-tasks")).toContainText("Use that observation as your starting point");
    await guestPage.reload(); await expect(guestPage.locator("#my-tasks textarea")).toHaveValue("The room is quiet beside the window.");
    expect(JSON.stringify((await agent(h, "/state")).data)).not.toContain("quiet beside the window");
    expect(JSON.stringify((await agent(h, "/events?after=0")).data)).not.toContain("starting point");
    const preview = await (await context.request.get(`${base}archives/preview?scope=facilitation`)).json();
    const response = await context.request.post(`${base}archives`, { headers: { Origin: new URL(base).origin }, data: {
      scope: "facilitation", title: "Our first session", expected_state_revision: preview.state_revision,
      expected_interaction_revision: preview.interaction_revision, request_id: crypto.randomUUID(),
    } });
    expect(response.status()).toBe(201); const archived = await response.json();
    expect(archived.archive.responses[0].answer).toBe("The room is quiet beside the window.");
    await expect(guestPage.locator("#my-tasks")).not.toContainText("Be the observer");
    expect((await guestContext.request.get(`${localPageUrl(guestHandle)}_tendril/archives/${archived.archive.id}`)).status()).toBe(403);
  } finally { await guestContext.close(); await deletePage(h); }
});

test("saved context, due timer, staged restore and independent remix use the actual Worker", async ({ page, context }) => {
  const h = await createPage(); let copy: any;
  try {
    await publish(h, '<h1>Original notebook</h1><label>Observation<input id="observation"></label>');
    await signInFixture(context); await openClaimed(page, h);
    const base = `${localPageUrl(h)}_tendril/`, origin = new URL(base).origin;
    const save = await context.request.put(`${base}session`, { headers: { Origin: origin }, data: { purpose: "Track the garden", current_task: "Measure tomorrow", expected_revision: 0 } });
    expect(save.status()).toBe(200); const saved = await save.json();
    expect((await agent(h, "/session")).data.session.current_task).toBe("Measure tomorrow");
    expect((await context.request.put(`${base}session`, { headers: { Origin: origin }, data: { current_task: "Stale overwrite", expected_revision: 0 } })).status()).toBe(409);
    const timer = await agent(h, "/timers", "POST", { title: "Inspect the notebook", due_at: Date.now() + 1500 }); expect(timer.status).toBe(201);
    await page.close();
    await expect.poll(async () => (await agent(h, "/timers/history")).data.runs.filter((run: any) => run.timer_id === timer.data.id).length, { timeout: 20000 }).toBe(1);
    const returned = await context.newPage(); await returned.goto(localPageUrl(h)); await returned.waitForFunction(() => (window as any).tendril?.connected);
    const session = await (await context.request.get(`${base}session`)).json();
    expect(session.revision).toBe(saved.revision); expect(session.pending_inputs.count).toBeGreaterThan(0);
    const bundle = await (await context.request.get(`${base}bundle?include_data=true`)).json();
    expect(bundle.session.current_task).toBe("Measure tomorrow");
    expect((await context.request.put(`${base}bundle`, { headers: { Origin: origin }, data: bundle })).status()).toBe(202);
    const prepared = await (await context.request.get(`${base}session`)).json(); expect(prepared.staged_remix).toBe(true);
    expect((await context.request.post(`${base}bundle/publish`, { headers: { Origin: origin }, data: { expected_version: prepared.version - 1 } })).status()).toBe(409);
    expect((await context.request.post(`${base}bundle/publish`, { headers: { Origin: origin }, data: { expected_version: prepared.version } })).status()).toBe(200);
    const remix = await agent(h, "/remix", "POST", { owner: "owner@example.test", name: "Independent garden notebook", include_data: true });
    expect(remix.status).toBe(201); copy = remix.data;
    expect(copy.id).not.toBe(h.id); expect(copy.token).not.toBe(h.token);
    expect((await agent(copy, "/timers")).data.timers).toEqual([]);
    expect((await agent(copy, "/assignments")).data.assignments).toEqual([]);
    expect((await agent(copy, "/archives")).data.archives).toEqual([]);
    expect((await agent(copy, "/session")).data.staged_remix).toBe(true);
  } finally { if (copy) await deletePage(copy); await deletePage(h); }
});
