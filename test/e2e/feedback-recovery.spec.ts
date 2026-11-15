import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { agent, createPage, deletePage, localPageUrl, openClaimed, publish, signInFixture, type Handle } from "./local-helpers";

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

async function openSession(page: Page, h: Handle) {
  await publish(h, "<p>Preparing draft recovery</p>");
  expect((await agent(h, "/files", "POST", { replace: true, files: {
    "index.html": recipe("index.html"), "assignments.js": recipe("assignments.js"),
  } })).status).toBe(200);
  await signInFixture(page.context()); await openClaimed(page, h);
  await expect(page.locator("#participant-code")).toContainText("Your participant code:");
  await expect(page.locator("#saved")).toContainText("No response sent");
}

test("a task draft keeps its first-edit session through rollover and a delayed rejection until explicitly reused", async ({ page, context }) => {
  const h = await createPage(), title = "Observe the quiet corner", instructions = "Describe the light beside the window.";
  let releasePost: (() => void) | undefined;
  try {
    await openSession(page, h);
    const base = `${localPageUrl(h)}_tendril/`;
    const archiveElsewhere = async () => {
      const snapshot = await (await context.request.get(`${base}archives/preview?scope=facilitation`)).json();
      const response = await context.request.post(`${base}archives`, { headers: { Origin: new URL(base).origin }, data: {
        scope: "facilitation", request_id: crypto.randomUUID(), expected_state_revision: snapshot.state_revision,
        expected_interaction_revision: snapshot.interaction_revision,
      } });
      expect(response.status()).toBe(201);
      return (await response.json()).archive.id as string;
    };
    const assign = page.getByRole("button", { name: "Assign privately", exact: true });
    const reuse = page.getByRole("button", { name: "Use task draft in current session", exact: true });
    await expect(assign).toBeEnabled();
    await expect(page.locator("#assignment-participant")).toHaveValue(/\S+/);
    const recipient = await page.locator("#assignment-participant").inputValue(); expect(recipient).toBeTruthy();
    await page.locator("#assignment-title").fill(title);

    // The generation belongs to the first keystroke, even when the private
    // instructions are composed after another owner rolls the session over.
    const firstSession = await archiveElsewhere();
    await page.waitForFunction(id => (window as any).tendril.state.get("facilitation.session_id") === id, firstSession);
    await page.locator("#assignment-prompt").fill(instructions);
    await expect(reuse).toBeVisible(); await expect(assign).toBeDisabled();
    await expect(page.locator("#assignment-title")).toHaveValue(title);
    await expect(page.locator("#assignment-participant")).toHaveValue(recipient);
    expect((await agent(h, "/assignments")).data.assignments).toEqual([]);
    await reuse.click(); await expect(assign).toBeEnabled();

    // Delay the actual request, not the Worker response. Archiving while it is
    // in transit exercises the service's stale-session rejection and UI recovery.
    let markCaptured!: () => void;
    const captured = new Promise<void>(resolve => { markCaptured = resolve; });
    const held = new Promise<void>(resolve => { releasePost = resolve; });
    let submitted: any;
    await page.route(`${base}assignments`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      submitted = route.request().postDataJSON(); markCaptured(); await held; await route.continue();
    });
    await assign.click(); await captured;
    expect(submitted).toMatchObject({ title, prompt: instructions, participant: recipient, expected_session_id: firstSession });
    const nextSession = await archiveElsewhere();
    await page.waitForFunction(id => (window as any).tendril.state.get("facilitation.session_id") === id, nextSession);
    const rejected = page.waitForResponse(response => response.url() === `${base}assignments` && response.request().method() === "POST");
    releasePost();
    const response = await rejected; expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("stale_session");
    await expect(page.locator("#assignment-status")).toContainText("Your task title and private instructions are kept.");
    await expect(page.locator("#assignment-title")).toHaveValue(title);
    await expect(page.locator("#assignment-prompt")).toHaveValue(instructions);
    await expect(reuse).toBeEnabled(); await expect(assign).toBeDisabled();
    expect((await agent(h, "/assignments")).data.assignments).toEqual([]);

    await page.unroute(`${base}assignments`);
    await reuse.click();
    const accepted = page.waitForResponse(response => response.url() === `${base}assignments` && response.request().method() === "POST");
    await assign.click();
    const saved = await accepted; expect(saved.status()).toBe(201);
    expect(saved.request().postDataJSON().expected_session_id).toBe(nextSession);
    await expect(page.locator("#assignment-status")).toContainText("Task assigned privately.");
    await expect(page.locator("#assignment-title")).toHaveValue("");
    await expect(page.locator("#assignment-prompt")).toHaveValue("");
    const tasks = (await agent(h, "/assignments")).data.assignments;
    expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ title, prompt: instructions, participant: recipient });
  } finally { releasePost?.(); await deletePage(h); }
});

test("an unsent answer restored after reload blocks archive review", async ({ page }) => {
  const h = await createPage(), answer = "This answer is still a draft after reopening the page.";
  try {
    await openSession(page, h);
    await page.locator("#answer").fill(answer);
    await page.reload();
    await page.waitForFunction(() => (window as any).tendril?.connected === true);
    await expect(page.locator("#answer")).toHaveValue(answer);
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/_tendril/archives")) writes.push(request.url());
    });
    const archive = page.locator("#session-archive");
    await archive.locator("summary").click();
    const prepare = archive.getByRole("button", { name: "Review archive and new session", exact: true });
    await expect(prepare).toBeEnabled(); await prepare.click();
    await expect(archive.getByRole("status")).toContainText("Save your answer and feedback drafts before archiving.");
    await expect(archive.locator(".archive-review")).toBeHidden();
    await expect(page.locator("#answer")).toHaveValue(answer);
    expect(writes).toEqual([]);
    expect((await agent(h, "/archives")).data.archives).toEqual([]);
    expect((await agent(h, "/responses")).data.responses).toEqual([]);
  } finally { await deletePage(h); }
});

test("an earlier in-memory answer survives a later owner archive when local storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() {
      throw new DOMException("Local storage is disabled by the explicit test fixture", "SecurityError");
    } });
  });
  const h = await createPage(), answer = "Keep this earlier private draft even when storage is blocked.";
  try {
    await openSession(page, h);
    await page.locator("#answer").fill(answer);
    await expect(page.locator("#status")).toContainText("could not save your draft");
    await page.locator("#question").fill("Which small experiment comes next?");
    await page.getByRole("button", { name: "Start a new question", exact: true }).click();
    await expect(page.locator("#prompt")).toHaveText("Which small experiment comes next?");
    await expect(page.locator("#answer")).toHaveValue("");
    const retained = page.locator("#retained-drafts");
    await expect(retained).toBeVisible();
    await expect(retained.locator("textarea")).toHaveValue(answer);
    await page.waitForFunction(() => {
      const pending = (window as any).tendril.pendingWork();
      return pending.events === 0 && pending.state === 0 && pending.captures === 0;
    });

    const archive = page.locator("#session-archive");
    await archive.locator("summary").click();
    const prepare = archive.getByRole("button", { name: "Review archive and new session", exact: true });
    await expect(prepare).toBeEnabled(); await prepare.click();
    await expect(archive.locator(".archive-review")).toBeVisible();
    const archivedDownload = page.waitForEvent("download");
    await archive.getByRole("button", { name: "Archive and start new session", exact: true }).click();
    await archivedDownload;
    await expect(archive.getByRole("status")).toContainText("Previous session archived.");
    await expect(retained).toBeVisible();
    await expect(retained.locator("textarea")).toHaveValue(answer);
    await expect(page.locator("#answer")).toHaveValue("");
    expect((await agent(h, "/archives")).data.archives).toHaveLength(1);
    expect((await agent(h, "/responses")).data.responses).toEqual([]);
    expect(JSON.stringify((await agent(h, "/state")).data)).not.toContain(answer);

    const exportedDrafts = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download private drafts", exact: true }).click();
    const download = await exportedDrafts;
    expect(download.suggestedFilename()).toBe("private-session-drafts.json");
    const path = await download.path(); expect(path).toBeTruthy();
    const exported = JSON.parse(readFileSync(path!, "utf8"));
    expect(exported.drafts).toEqual(expect.arrayContaining([expect.objectContaining({ answer })]));
    expect(await page.evaluate(() => { try { localStorage.getItem("probe"); return false; } catch { return true; } })).toBe(true);
  } finally { await deletePage(h); }
});
