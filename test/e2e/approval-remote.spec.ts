import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { agent, createPage, deletePage, localPageUrl, openClaimed, publish, signInFixture } from "./local-helpers";

const html = readFileSync(new URL("../../recipes/approval-remote/index.html", import.meta.url), "utf8");

test("approval remote records one versioned decision and shows its execution result", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, "<p>Preparing the decision inbox</p>");
    expect((await agent(h, "/files", "POST", { replace: true, files: { "index.html": html } })).status).toBe(200);
    await signInFixture(context); await openClaimed(page, h);
    const proposal = await agent(h, "/decisions", "POST", { title: "Apply the reviewed guide", summary: "Update two documentation files.",
      proposal: { change_id: "docs-123", files: ["README.md", "docs/setup.md"] } });
    expect(proposal.status).toBe(201);
    const id = proposal.data.id;
    const card = page.locator(`[data-decision-id="${id}"]`);
    await expect(card).toContainText("Apply the reviewed guide");
    await card.getByRole("button", { name: "Approve v1", exact: true }).click();
    await expect(card).toContainText("Approved · waiting for agent");
    const response = await context.request.post(`${localPageUrl(h)}_tendril/decisions/${id}/respond`, {
      headers: { Origin: new URL(localPageUrl(h)).origin }, data: { expected_version: 1, decision: "approve" },
    });
    expect(response.status()).toBe(409);
    const events = (await agent(h, "/events?after=0&wait=0")).data.events;
    expect(events.filter((event: any) => event.data?.decision_id === id)).toHaveLength(1);
    expect(events.find((event: any) => event.data?.decision_id === id)).toMatchObject({ type: "event", role: "owner", data: { decision: "approve", version: 1 } });
    let current = (await agent(h, "/decisions")).data.decisions.find((decision: any) => decision.id === id);
    const working = await agent(h, `/decisions/${id}`, "PATCH", { expected_version: current.version, status: "working", result: "Applying the approved patch." });
    expect(working.status).toBe(200); current = working.data;
    expect((await agent(h, `/decisions/${id}`, "PATCH", { expected_version: current.version, status: "completed", result: "The guide is updated. Commit abc123 contains the two reviewed files." })).status).toBe(200);
    await expect(card).toContainText("Completed");
    await expect(card).toContainText("Commit abc123");
    await page.reload(); await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.locator(`[data-decision-id="${id}"]`)).toContainText("Commit abc123");
  } finally { await deletePage(h); }
});

test("revision draft survives live updates and reload, then produces a correlated request", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, "<p>Preparing the decision inbox</p>");
    await agent(h, "/files", "POST", { replace: true, files: { "index.html": html } });
    await signInFixture(context); await openClaimed(page, h);
    const first = (await agent(h, "/decisions", "POST", { title: "Choose the documentation layout", summary: "Use a two-column layout." })).data;
    const input = page.locator(`#note-${first.id}`);
    await input.fill("Keep one column for small screens.");
    await agent(h, "/decisions", "POST", { title: "Another proposal", summary: "A separate decision arrives while you type." });
    await expect(page.locator("#decisions")).toContainText("Another proposal");
    await expect(input).toHaveValue("Keep one column for small screens.");
    await page.reload();
    await expect(page.locator(`#note-${first.id}`)).toHaveValue("Keep one column for small screens.");
    await page.locator(`[data-decision-id="${first.id}"]`).getByRole("button", { name: "Request revision", exact: true }).click();
    await expect(page.locator(`[data-decision-id="${first.id}"]`)).toContainText("Revision requested");
    const events = (await agent(h, "/events?after=0&wait=0")).data.events;
    expect(events).toContainEqual(expect.objectContaining({ role: "owner", data: expect.objectContaining({
      type: "decision", decision_id: first.id, decision: "revise", version: first.version, note: "Keep one column for small screens.",
    }) }));
  } finally { await deletePage(h); }
});
