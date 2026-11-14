import { test, expect } from "@playwright/test";
import { agent, createPage, deletePage, openClaimed, publish, signInFixture } from "./local-helpers";

test("live capabilities, user-triggered location, and agent journey", async ({ page, context }) => {
  const h = await createPage();
  try {
  await publish(h, `<div id="inputs"></div><script src="_tendril/snippets/input-kit.js"></script>
    <script>tendrilSnippets.inputs.mount('#inputs',{modalities:['location']})</script>`);
  await signInFixture(context);
  await context.setGeolocation({ latitude: 52.52, longitude: 13.405 });
  await openClaimed(page, h);
  const caps = await agent(h, "/capabilities");
  expect(caps.status).toBe(200);
  expect(caps.data.devices[0].source).toBe("live");
  expect(caps.data.devices[0].report.capabilities.location.available).toBe(true);
  await page.getByRole("button", { name: "Share location once" }).click();
  await expect(page.locator("#inputs").getByRole("status")).toContainText("Location sent");
  const batch = await agent(h, "/events");
  const input = batch.data.events.find((e: any) => e.data?.modality === "location");
  expect(input).toMatchObject({ type: "event", role: "owner" });
  expect(input.data.latitude).toBeCloseTo(52.52, 1);
  await agent(h, "/say", "POST", { text: "I got your location", speak: false, in_reply_to: input.seq });
  const journey = await agent(h, "/journey");
  expect(journey.data.entries.some((e: any) => e.source === "event" && e.seq === input.seq)).toBe(true);
  expect(journey.data.entries.some((e: any) => e.kind === "events_read")).toBe(true);
  expect(journey.data.entries.some((e: any) => e.kind === "say" && e.summary.includes(`#${input.seq}`))).toBe(true);
  } finally { await deletePage(h); }
});

test("agent changes a choice block through shared state", async ({ page, context }) => {
  const h = await createPage();
  try {
  await publish(h, `<div id="app"></div><script src="_tendril/snippets/ui.js"></script>
    <script>tendrilSnippets.ui.mount('#app')</script>`);
  await signInFixture(context);
  await openClaimed(page, h);
  const state = await agent(h, "/state", "PATCH", { interface: { title: "Choose a route", blocks: [
    { id: "route", type: "choice", label: "Where next?", options: ["Park", "River"] }
  ] } });
  expect(state.status).toBe(200);
  await expect(page.getByRole("heading", { name: "Choose a route" })).toBeVisible();
  await page.getByLabel("Where next?").selectOption("River");
  const batch = await agent(h, "/events");
  expect(batch.data.events.some((e: any) => e.data?.type === "ui" && e.data?.block === "route" && e.data?.value === "River")).toBe(true);
  } finally { await deletePage(h); }
});

test("device playground captures a photo only after a tap", async ({ page, context }) => {
  const h = await createPage();
  try {
    await publish(h, `<div id="explore"></div><script src="_tendril/snippets/playground.js"></script>
      <script>tendrilSnippets.playground.mount('#explore')</script>`);
    await signInFixture(context);
    await openClaimed(page, h);
    await expect(page.locator("#explore").getByRole("heading", { name: "Explore this device" })).toBeVisible();
    await page.getByRole("button", { name: "Take photo" }).click();
    await expect(page.locator("#explore").getByRole("status").last()).toContainText("Photo sent");
    const batch = await agent(h, "/events");
    const photo = batch.data.events.find((e: any) => e.data?.modality === "photo");
    expect(photo).toMatchObject({ type: "event", role: "owner" });
    expect(photo.data.blob).toMatch(/^b_/);
    const caps = await agent(h, "/capabilities");
    expect(caps.data.devices[0].report.capabilities.camera.active).toBe(false);
  } finally { await deletePage(h); }
});
