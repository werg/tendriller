import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { agent, createPage, deletePage, localPageUrl, openClaimed, publish, signInFixture } from "./local-helpers";

const recipe = (file: string) => readFileSync(new URL(`../../recipes/facilitated-session/${file}`, import.meta.url), "utf8");

test("private feedback survives another owner's archive and reload, then stays out of a display session", async ({ page, context, browser }) => {
  const h = await createPage();
  const otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const feedback = "Keep the quiet corner observation; ask about the afternoon light.";
  try {
    await publish(h, "<p>Preparing private feedback recovery</p>");
    const published = await agent(h, "/files", "POST", { replace: true, files: {
      "index.html": recipe("index.html"), "assignments.js": recipe("assignments.js"),
    } });
    expect(published.status).toBe(200);
    await signInFixture(context); await signInFixture(otherContext);
    await openClaimed(page, h);
    const otherPage = await otherContext.newPage(); await openClaimed(otherPage, h);
    const directory = await agent(h, "/assignments/participants");
    expect(directory.status).toBe(200);
    const owner = directory.data.participants.find((participant: any) => participant.role === "owner");
    expect(owner).toBeTruthy();
    const assignment = await agent(h, "/assignments", "POST", {
      participant: owner.id, title: "Observe the room", prompt: "Describe the quietest place to work.",
    });
    expect(assignment.status).toBe(201);
    await page.getByRole("button", { name: "Refresh participants and tasks", exact: true }).click();
    await expect(page.locator("#assignment-list")).toContainText("Observe the room");
    const draft = page.locator("#assignment-list textarea");
    await draft.fill(feedback);
    await expect(draft).toHaveValue(feedback);
    expect((await agent(h, "/assignments")).data.assignments[0].feedback).toBe("");

    // The second authenticated owner can finish the session while this device
    // has a local draft. Its archive must contain only accepted server feedback.
    const base = `${localPageUrl(h)}_tendril/`;
    const previewResponse = await otherContext.request.get(`${base}archives/preview?scope=facilitation`);
    expect(previewResponse.status()).toBe(200);
    const preview = await previewResponse.json();
    const archivedResponse = await otherContext.request.post(`${base}archives`, {
      headers: { Origin: new URL(base).origin }, data: {
        scope: "facilitation", title: "Finished observation round", request_id: crypto.randomUUID(),
        expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision,
      },
    });
    expect(archivedResponse.status()).toBe(201);
    const archived = await archivedResponse.json();
    expect(archived.archive.assignments[0].feedback).toBe("");
    await expect(page.locator("#assignment-list textarea")).toHaveCount(0);
    const retained = page.locator("#retained-drafts");
    await expect(retained).toBeVisible();
    await expect(retained).toContainText(/feedback/i);
    await expect(retained.locator("textarea")).toHaveValue(feedback);
    expect((await agent(h, "/assignments")).data.assignments).toEqual([]);
    expect(JSON.stringify((await agent(h, "/state")).data)).not.toContain(feedback);

    await page.reload();
    await page.waitForFunction(() => (window as any).tendril?.connected === true);
    await expect(retained).toBeVisible();
    await expect(retained.locator("textarea")).toHaveValue(feedback);

    // Keep this origin's local storage, but enter through an owner-created
    // display link. A recovered owner draft must never render in that role.
    await otherPage.getByRole("button", { name: /^Agent status:/ }).click();
    await otherPage.getByRole("tab", { name: "Share and devices", exact: true }).click();
    await otherPage.getByText("Add a device", { exact: true }).click();
    await otherPage.getByRole("button", { name: "Big screen (display)", exact: true }).click();
    const createdLink = otherPage.locator("#tendril-add .qrbox .url");
    await expect(createdLink).toHaveText(/^https:\/\/.*\/s\/[a-z2-7]+\/$/);
    const displayUrl = new URL((await createdLink.textContent())!.trim());
    displayUrl.port = "8790";
    expect(displayUrl.origin).toBe(new URL(page.url()).origin);
    await page.goto(displayUrl.href);
    await page.waitForFunction(() => (window as any).tendril?.connected === true && (window as any).tendril.device.role === "display");
    await expect(page.locator("#retained-drafts")).toBeHidden();
    await expect(page.locator("#retained-draft-list textarea")).toHaveCount(0);
    expect(await page.locator("textarea").evaluateAll((fields, text) => fields.some(field => (field as HTMLTextAreaElement).value.includes(text)), feedback)).toBe(false);
    expect((await context.request.get(new URL("_tendril/assignments", displayUrl).href)).status()).toBe(403);
  } finally { await otherContext.close(); await deletePage(h); }
});
