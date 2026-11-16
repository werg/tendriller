import { test, expect } from "@playwright/test";
import { agent, createPage, deletePage, localPageUrl, openClaimed, publish, signInFixture } from "./local-helpers";

test("browser state claims and timer commands use the real authority and correlated receipts", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, '<h1>Shared work</h1><p>Claim a task and review its reminder.</p>');
    await signInFixture(context); await openClaimed(page, h);
    const before = await page.evaluate(() => (window as any).tendril.state.snapshot());
    expect(before.state).toEqual({});
    await page.evaluate(async () => {
      const runtime = (window as any).tendril;
      (window as any).stateResults = [];
      runtime.on("state_result", (result: any) => (window as any).stateResults.push(result));
      await Promise.all(["first", "second"].map(owner => runtime.state.apply([
        { op: "set", path: ["claims", "task"], value: owner },
      ], { conditions: [{ path: ["claims", "task"], exists: false }] })));
    });
    await expect.poll(() => page.evaluate(() => (window as any).stateResults.length)).toBe(2);
    const claims = await page.evaluate(() => ({
      results: (window as any).stateResults, pending: (window as any).tendril.state.pending(),
    }));
    expect(claims.results.map((result: any) => result.status).sort()).toEqual(["accepted", "rejected"]);
    expect(new Set(claims.results.map((result: any) => result.cid)).size).toBe(2);
    expect(claims.results.find((result: any) => result.status === "rejected").error).toBe("state_conflict");
    expect(claims.pending).toEqual([]);
    const accepted = claims.results.find((result: any) => result.status === "accepted");
    const confirmed = await page.evaluate(() => (window as any).tendril.state.snapshot());
    expect(confirmed.state.claims.task).toBe(accepted.ops[0].value);
    expect(confirmed.rev).toBe(before.rev + 1);

    const created = await page.evaluate(() => (window as any).tendril.timers.create({
      title: "Review claimed task", due_at: Date.now() + 60_000,
    }));
    expect(created.status).toBe("accepted");
    expect(created.value.revision).toBe(1);
    const cancelled = await page.evaluate(timer => (window as any).tendril.timers.update(
      timer.id, { state: "cancelled" }, { expected_revision: timer.revision },
    ), created.value);
    expect(cancelled.status).toBe("accepted");
    expect(cancelled.value.revision).toBe(2);
    const stale = await page.evaluate(timer => (window as any).tendril.timers.update(
      timer.id, { title: "Stale edit" }, { expected_revision: timer.revision },
    ), created.value);
    expect(stale.status).toBe("rejected");
    expect(stale.error).toBe("timer_conflict");
    const removed = await page.evaluate(timer => (window as any).tendril.timers.remove(
      timer.id, { expected_revision: timer.revision },
    ), cancelled.value);
    expect(removed).toMatchObject({ status: "accepted", value: { id: created.value.id, revision: 3, deleted: true } });
    expect(await page.evaluate(() => (window as any).tendril.timers.pending())).toEqual([]);
    expect((await agent(h, "/timers")).data.timers).toEqual([]);
  } finally { await deletePage(h); }
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
    const timer = await agent(h, "/timers", "POST", { cid: crypto.randomUUID(), expected_generations: {}, title: "Inspect the notebook", due_at: Date.now() + 1500 }); expect(timer.status).toBe(201);
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
