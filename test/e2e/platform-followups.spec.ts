import { test, expect } from "@playwright/test";
import { agent, createPage, deletePage, localPageUrl, openClaimed, publish, signInFixture } from "./local-helpers";

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
    const staging = await context.request.put(`${base}bundle`, { headers: { Origin: origin }, data: bundle });
    expect(staging.status()).toBe(202); const staged = await staging.json();
    const prepared = await (await context.request.get(`${base}session`)).json(); expect(prepared.staged_remix).toBe(true);
    expect((await context.request.post(`${base}bundle/publish`, { headers: { Origin: origin }, data: { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: staged.expected_head_revision - 1 } })).status()).toBe(409);
    expect((await context.request.post(`${base}bundle/publish`, { headers: { Origin: origin }, data: { cid: crypto.randomUUID(), expected_generations: {}, expected_head_revision: staged.expected_head_revision } })).status()).toBe(200);
    const remix = await agent(h, "/remix", "POST", { owner: "owner@example.test", name: "Independent garden notebook", include_data: true });
    expect(remix.status).toBe(201); copy = remix.data;
    expect(copy.id).not.toBe(h.id); expect(copy.token).not.toBe(h.token);
    expect((await agent(copy, "/timers")).data.timers).toEqual([]);
    expect((await agent(copy, "/scopes")).data.scopes).toEqual([]);
    expect((await agent(copy, "/workflows")).data.workflows).toEqual([]);
    expect((await agent(copy, "/session")).data.staged_remix).toBe(true);
  } finally { if (copy) await deletePage(copy); await deletePage(h); }
});
