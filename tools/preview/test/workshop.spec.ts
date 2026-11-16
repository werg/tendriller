import { test, expect, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRecipe } from "./recipe-fixtures";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const frameUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="skyblue"/></svg>');
let server: any;

test.beforeEach(async () => {
  server = await startRecipe("multi-device-workshop", {
    workshop: { step: { id: "fold", title: "Fold the support", instruction: "Fold the sheet in half." } },
  });
});
test.afterEach(async ({ page }) => { await page.close(); await server?.stopPreview(); });

async function open(page: Page) {
  await page.addInitScript(() => {
    const requests: any[] = [];
    (window as any).__cameraRequests = requests;
    // Hold permission resolution deterministically. Canvas tracks behave like
    // real MediaStreamTracks without opening a camera or needing permission.
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      const request: any = { stops: 0, track: null, release: null };
      request.release = () => {
        const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
        canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
        const stream = canvas.captureStream(1), track = stream.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => { request.stops++; stop(); };
        request.track = track; request.canvas = canvas; resolve(stream);
      };
      requests.push(request);
    });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return this.id === "video" ? Promise.resolve() : play.call(this); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.tendril.connected);
  await expect(page.locator("#start-camera")).toBeEnabled();
}

async function startRequest(page: Page, count: number) {
  await page.locator("#start-camera").click();
  await expect.poll(() => page.evaluate(() => (window as any).__cameraRequests.length)).toBe(count);
}
async function release(page: Page, index: number) {
  await page.evaluate(index => (window as any).__cameraRequests[index].release(), index);
}
async function ended(page: Page, index: number) {
  await expect.poll(() => page.evaluate(index => (window as any).__cameraRequests[index].track?.readyState, index)).toBe("ended");
  expect(await page.evaluate(index => (window as any).__cameraRequests[index].stops, index)).toBeGreaterThan(0);
}

for (const change of ["display role", "pending approval", "controller purpose", "speaker purpose", "display purpose", "paused"] as const) {
  test(`camera stops and pending permission cannot reopen it after ${change}`, async ({ page }) => {
    await open(page);
    const device = await page.evaluate(() => window.tendril.device.id);
    async function setIneligible(value: boolean) {
      if (change === "display role") server.preview.setRole(value ? "display" : "owner");
      else if (change === "pending approval") server.preview.broadcast({ t: "role", role: "owner", pending: value });
      else if (change === "paused") server.preview.updateState([{ op: "set", path: ["workshop", "paused"], value }]);
      else server.preview.updateDevice({ id: device, purpose: value ? change.split(" ")[0] : "general" });
      if (value) await expect(page.locator("#start-camera")).toBeDisabled();
      else await expect(page.locator("#start-camera")).toBeEnabled();
    }

    await startRequest(page, 1);
    // The Start button is already disabled during permission. Wait for the
    // actual state/role/purpose change before resolving that pending request.
    await setIneligible(true);
    if (change === "display role") await page.waitForFunction(() => window.tendril.device.role === "display");
    else if (change === "pending approval") await page.waitForFunction(() => window.tendril.device.pending);
    else if (change === "paused") await expect(page.locator("#pause-banner")).toBeVisible();
    else await expect(page.locator("body")).toHaveAttribute("data-purpose", change.split(" ")[0]);
    await release(page, 0); await ended(page, 0);
    await expect(page.locator("#video")).toBeHidden(); await expect(page.locator("#capture")).toBeDisabled();
    expect(await page.locator("#video").evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();

    await setIneligible(false);
    await startRequest(page, 2); await release(page, 1);
    await expect(page.locator("#video")).toBeVisible(); await expect(page.locator("#capture")).toBeEnabled();
    await setIneligible(true); await ended(page, 1);
    await expect(page.locator("#video")).toBeHidden(); await expect(page.locator("#capture")).toBeDisabled();
  });
}

test("pagehide cancels pending camera permission without stopping a newer session when it resolves late", async ({ page }) => {
  await open(page); await startRequest(page, 1);
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
  await expect(page.locator("#start-camera")).toBeEnabled();
  await startRequest(page, 2); await release(page, 1);
  await expect(page.locator("#capture")).toBeEnabled();
  await release(page, 0); await ended(page, 0);
  expect(await page.evaluate(() => (window as any).__cameraRequests[1].track.readyState)).toBe("live");
  await expect(page.locator("#video")).toBeVisible(); await expect(page.locator("#capture")).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide"))); await ended(page, 1);
  await expect(page.locator("#video")).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect(page.locator("#start-camera")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__cameraRequests.length)).toBe(2);
});

test("removing a shared frame removes its image and annotations and ignores a late load callback", async ({ page }) => {
  await open(page);
  server.preview.updateState([
    { op: "set", path: ["workshop", "frame"], value: { id: "frame-one", url: frameUrl, device: "Camera phone", at: Date.now() } },
    { op: "set", path: ["workshop", "annotations"], value: { frame: "frame-one", shapes: [{ shape: "arrow", x: .5, y: .5, text: "Fold here" }] } },
  ]);
  await expect(page.locator("#frame")).toBeVisible();
  await expect(page.locator("[data-tendril-overlay]")).toHaveCount(1);
  await expect(page.locator("#annotations")).toHaveText("Fold here");
  await page.evaluate(() => { (window as any).__lateFrameLoad = (document.getElementById("frame") as HTMLImageElement).onload; });

  server.preview.updateState([{ op: "delete", path: ["workshop", "frame"] }]);
  await expect(page.locator("#frame")).toBeHidden();
  await expect(page.locator("#frame")).not.toHaveAttribute("src");
  await expect(page.locator("#frame-note")).toHaveText("No photo shared yet.");
  await expect(page.locator("#annotations")).toBeEmpty();
  await expect(page.locator("[data-tendril-overlay]")).toHaveCount(0);
  await page.evaluate(() => (window as any).__lateFrameLoad?.());
  await expect(page.locator("[data-tendril-overlay]")).toHaveCount(0);
  await expect(page.locator("#frame")).toBeHidden();

  // A later frame gets a fresh overlay; annotations for the removed frame do
  // not survive on the replacement image.
  server.preview.updateState([{ op: "set", path: ["workshop", "frame"], value: { id: "frame-two", url: frameUrl, at: Date.now() } }]);
  await expect(page.locator("#frame")).toBeVisible();
  await expect(page.locator("[data-tendril-overlay]")).toHaveCount(1);
  await expect(page.locator("#annotations")).toBeEmpty();
  await expect(page.locator("[data-tendril-overlay] svg")).toHaveAttribute("aria-label", "No annotations");
});

test("delayed camera capture and file selection stay in the workshop where they began", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).__photoUploads = [];
    window.tendril.uploadEvent = async (_blob: Blob, options: any) => {
      (window as any).__photoUploads.push(options);
      return { status: "accepted", capture_id: "capture-test" } as any;
    };
    (window as any).__finishCapture = null;
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      (window as any).__finishCapture = () => callback(new Blob(["photo"], { type: "image/jpeg" }));
    };
    CanvasRenderingContext2D.prototype.drawImage = function () {};
  });
  await startRequest(page, 1); await release(page, 0);
  await expect(page.locator("#capture")).toBeEnabled();
  await page.locator("#capture").click();
  await page.waitForFunction(() => !!(window as any).__finishCapture);
  await page.evaluate(() => (document.getElementById("photo") as HTMLInputElement).onclick?.(new MouseEvent("click")));
  server.preview.setScopes(server.preview.scopes.map((scope: any) => ({ ...scope, generation: "new-generation" })));
  server.preview.updateState([{ op: "set", path: ["workshop"], value: { step: { id: "new-step" } } }]);
  await page.waitForFunction(() => window.tendril.scopes.list()[0]?.generation === "new-generation");
  await page.evaluate(() => {
    (window as any).__finishCapture();
    const input = document.getElementById("photo") as HTMLInputElement;
    const files = new DataTransfer(); files.items.add(new File(["photo"], "old.jpg", { type: "image/jpeg" }));
    input.files = files.files; input.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#status")).toContainText("previous workshop");
  expect(await page.evaluate(() => (window as any).__photoUploads)).toEqual([]);
});

test("a selected photo keeps the starting step when that step changes before selection finishes", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).__photoUploads = [];
    window.tendril.uploadEvent = async (_blob: Blob, options: any) => {
      (window as any).__photoUploads.push(options);
      return { status: "accepted", capture_id: "capture-test" } as any;
    };
    (document.getElementById("photo") as HTMLInputElement).onclick?.(new MouseEvent("click"));
  });
  server.preview.updateState([{ op: "set", path: ["workshop", "step"], value: { id: "next-step" } }]);
  await page.waitForFunction(() => window.tendril.state.get("workshop")?.step?.id === "next-step");
  await page.evaluate(() => {
    const input = document.getElementById("photo") as HTMLInputElement;
    const files = new DataTransfer(); files.items.add(new File(["photo"], "step.jpg", { type: "image/jpeg" }));
    input.files = files.files; input.dispatchEvent(new Event("change"));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__photoUploads.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__photoUploads[0])).toMatchObject({
    data: { type: "workshop.frame", step_id: "fold" }, scope: "sessions:workshop", expected_generations: { "sessions:workshop": "fixture-workshop" },
  });
});
