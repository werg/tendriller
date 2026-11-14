import { test, expect } from "@playwright/test";
import { load, calls } from "./helpers";

test("clipboard and directory require explicit action and emit bounded input events", async ({ page }) => {
  await load(page, "connectors");
  const result = await page.evaluate(async () => {
    const w = window as any;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "abcdef" } });
    w.showDirectoryPicker = async () => ({ name: "field", async *entries() { yield ["one.txt", { kind: "file" }]; yield ["sub", { kind: "directory" }]; } });
    const c = w.tendrilSnippets.connectors;
    return { clip: await c.readClipboard({ maxChars: 3 }), dir: await c.pickDirectory({ maxEntries: 1 }) };
  });
  expect(result.clip).toBe("abc");
  expect(result.dir).toMatchObject({ name: "field", entries: [{ name: "one.txt", kind: "file" }], truncated: true });
  const sent = (await calls(page)).send.map((x: any) => x.data);
  expect(sent).toEqual([
    expect.objectContaining({ type: "input", modality: "clipboard", text: "abc", truncated: true }),
    expect.objectContaining({ type: "input", modality: "directory", name: "field", truncated: true }),
  ]);
});

test("gamepad observations stay local until the user sends a snapshot", async ({ page }) => {
  await load(page, "connectors");
  await page.evaluate(() => {
    const w = window as any;
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [{ index: 0, id: "Pad", connected: true, buttons: [{ pressed: true, value: .8 }], axes: [.25] }] });
    w.__pad = w.tendrilSnippets.connectors.gamepads();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__pad.snapshot().length)).toBe(1);
  expect((await calls(page)).send).toHaveLength(0);
  await page.evaluate(async () => { await (window as any).__pad.sendSnapshot(); (window as any).__pad.stop(); });
  expect((await calls(page)).send[0].data).toMatchObject({ type: "input", modality: "gamepad", gamepads: [{ id: "Pad", axes: [.25] }] });
});

test("MIDI, HID, USB and NFC use bounded packets and explicit snapshots", async ({ page }) => {
  await load(page, "connectors");
  const result = await page.evaluate(async () => {
    const w = window as any;
    const input = new EventTarget() as any; input.id = "i"; input.name = "keys";
    const access = new EventTarget() as any; access.inputs = new Map([["i", input]]);
    Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: async () => access });
    const hidDevice = new EventTarget() as any;
    Object.assign(hidDevice, { productName: "Switch", vendorId: 1, productId: 2, collections: [], open: async () => {}, close: async () => {}, sendReport: async () => {} });
    Object.defineProperty(navigator, "hid", { configurable: true, value: { requestDevice: async () => [hidDevice] } });
    const usbDevice: any = { productName: "Meter", vendorId: 3, productId: 4, configurations: [], open: async () => {}, close: async () => {}, transferIn: async () => ({ status: "ok", data: new DataView(new Uint8Array([5, 6]).buffer) }) };
    Object.defineProperty(navigator, "usb", { configurable: true, value: { requestDevice: async () => usbDevice } });
    const readers: any[] = [];
    w.NDEFReader = class extends EventTarget { constructor() { super(); readers.push(this); } async scan() {} };
    const c = w.tendrilSnippets.connectors;
    const midi = await c.midi();
    input.dispatchEvent(new MessageEvent("midimessage", { data: new Uint8Array([144, 60, 100, 200]) }));
    const hid = await c.hid();
    hidDevice.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: 7, data: new DataView(new Uint8Array([1, 2, 3]).buffer) }));
    const usb = await c.usb();
    const read = await usb.read(1);
    const nfc = await c.nfc();
    readers[0].dispatchEvent(Object.assign(new Event("reading"), { serialNumber: "a1", message: { records: [{ recordType: "text", data: new TextEncoder().encode("tag") }] } }));
    await midi.sendSnapshot(); await hid.sendSnapshot(); await usb.sendSnapshot();
    nfc.stop(); midi.stop(); await hid.stop(); await usb.stop();
    return { read, midi: midi.messages, hid: hid.reports };
  });
  expect(result.read.bytes).toEqual([5, 6]);
  expect(result.midi[0].data).toEqual([144, 60, 100]);
  expect(result.hid[0].bytes).toEqual([1, 2, 3]);
  const modalities = (await calls(page)).send.map((x: any) => x.data.modality);
  expect(modalities).toEqual(["nfc", "midi", "hid", "usb"]);
});

test("hardware lab renders supported controls and reports chooser errors", async ({ page }) => {
  await load(page, "connectors", "hardware-lab");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => { throw new DOMException("Not allowed", "NotAllowedError"); } } });
    (window as any).tendrilSnippets.hardwareLab.mount("#app");
  });
  const button = page.getByRole("button", { name: "Read clipboard text" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText("Not allowed")).toBeVisible();
});

test("device playground loads the hardware lab and links to editable starters", async ({ page }) => {
  await load(page, "playground");
  await page.evaluate(async () => {
    (window as any).tendril.capabilities = async () => ({ capabilities: { camera: { available: false, permission: "unknown" }, microphone: { available: false, permission: "unknown" } } });
    await (window as any).tendrilSnippets.playground.mount("#app");
  });
  await expect(page.getByRole("heading", { name: "Hardware lab" })).toBeVisible();
  await page.getByRole("button", { name: "Build Field notebook" }).click();
  expect((await calls(page)).send[0].data).toMatchObject({ type: "recipe_choice", recipe: "field-notebook" });
  await expect(page.getByRole("link", { name: "Browse recipe source" })).toHaveAttribute("href", "https://github.com/werg/tendriller/tree/master/recipes");
});

test("agent editable UI can offer a specific hardware control", async ({ page }) => {
  await load(page, "ui");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "hello hardware" } });
    const w = window as any;
    w.tendril.__agentState([{ op: "set", path: ["interface"], value: { title: "Read an input", blocks: [{ id: "paste", type: "hardware", connector: "clipboard" }] } }]);
    w.tendrilSnippets.ui.mount("#app");
  });
  await page.getByRole("button", { name: "Read clipboard text" }).click();
  await expect.poll(async () => (await calls(page)).send.length).toBe(1);
  expect((await calls(page)).send[0].data).toMatchObject({ type: "input", modality: "clipboard", text: "hello hardware" });
});

test("hardware lab connects existing Serial and Bluetooth snippets and sends only on request", async ({ page }) => {
  await load(page, "connectors", "hardware-lab");
  await page.evaluate(() => {
    const w = window as any;
    Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: () => {} } });
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: () => {} } });
    w.tendrilSnippets.serial = { connect: async () => ({ lines: ["42"], close: async () => {} }) };
    w.tendrilSnippets.bluetooth = { connect: async () => ({ name: "Pulse", disconnect: () => {} }) };
    w.tendrilSnippets.hardwareLab.mount("#app");
  });
  await page.getByRole("button", { name: "Choose Serial device" }).click();
  await page.getByRole("button", { name: "Choose Bluetooth device" }).click();
  expect((await calls(page)).send).toHaveLength(0);
  const cards = page.locator("#app > section > div > div");
  await cards.filter({ has: page.locator("strong", { hasText: "Choose Serial device" }) }).getByRole("button", { name: "Send snapshot" }).click();
  await cards.filter({ has: page.locator("strong", { hasText: "Choose Bluetooth device" }) }).getByRole("button", { name: "Send snapshot" }).click();
  expect((await calls(page)).send.map((x: any) => x.data.modality)).toEqual(["serial", "bluetooth"]);
});

test("selected contacts and sensor readings follow explicit send controls", async ({ page }) => {
  await load(page, "connectors");
  const result = await page.evaluate(async () => {
    const w = window as any;
    Object.defineProperty(navigator, "contacts", { configurable: true, value: { select: async () => [{ name: ["Ada"], email: ["ada@example.com"] }] } });
    class FakeLight extends EventTarget { illuminance = 24; start() { this.dispatchEvent(new Event("reading")); } stop() {} }
    w.AmbientLightSensor = FakeLight;
    const c = w.tendrilSnippets.connectors;
    const contacts = await c.pickContacts({ fields: ["name"] });
    const sensor = c.sensor("ambient_light");
    const reading = sensor.snapshot();
    await sensor.sendSnapshot(); sensor.stop();
    return { contacts, reading };
  });
  expect(result).toEqual({ contacts: [{ name: ["Ada"] }], reading: { lux: 24 } });
  expect((await calls(page)).send.map((x: any) => x.data.modality)).toEqual(["contacts", "ambient_light"]);
});

test("agent-authored sensor callback sends automatically on its own threshold", async ({ page }) => {
  await load(page, "connectors");
  await page.evaluate(() => {
    const w = window as any;
    class FakeLight extends EventTarget { illuminance = 40; start() {} stop() {} }
    w.AmbientLightSensor = FakeLight;
    w.__light = w.tendrilSnippets.connectors.sensor("ambient_light", {
      onReading: ({ lux }: { lux: number }) => {
        if (lux < 20) void w.tendril.send({ type: "low_light", lux }, { wake: false });
      },
    });
    w.__light.sensor.dispatchEvent(new Event("reading"));
    w.__light.sensor.illuminance = 12;
    w.__light.sensor.dispatchEvent(new Event("reading"));
    w.__light.stop();
  });
  expect((await calls(page)).send).toEqual([{ data: { type: "low_light", lux: 12 }, wake: false }]);
});

test("XR actions stay local until a snapshot is sent", async ({ page }) => {
  await load(page, "connectors");
  const result = await page.evaluate(async () => {
    const w = window as any;
    const session = new EventTarget() as any; session.end = async () => {};
    Object.defineProperty(navigator, "xr", { configurable: true, value: { requestSession: async () => session } });
    const run = await w.tendrilSnippets.connectors.xr();
    session.dispatchEvent(Object.assign(new Event("select"), { inputSource: { handedness: "left", targetRayMode: "tracked-pointer" } }));
    const before = w.__calls.send.length;
    await run.sendSnapshot(); await run.stop();
    return { before, actions: run.actions };
  });
  expect(result.before).toBe(0);
  expect(result.actions[0]).toMatchObject({ type: "select", handedness: "left" });
  expect((await calls(page)).send[0].data.modality).toBe("xr");
});

test("screen capture uploads one PNG and stops the selected stream", async ({ page }) => {
  await load(page, "connectors");
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 32;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 32);
    const stream = canvas.captureStream();
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => stream });
    const data = await (window as any).tendrilSnippets.connectors.captureScreen();
    return { data, stopped: stream.getTracks().every((track) => track.readyState === "ended") };
  });
  expect(result.stopped).toBe(true);
  expect(result.data).toMatchObject({ blob: expect.any(String), width: 64, height: 32, mime: "image/png" });
  expect((await calls(page)).send[0].data).toMatchObject({ type: "input", modality: "screen" });
});
