// Headless preview: serves a page directory locally with a fake window.tendril
// that records calls, opens it in Chromium (fake camera/mic), and reports
// console errors, uncaught exceptions, recorded calls and a screenshot.
// Needs `playwright` (or `@playwright/test`) resolvable from the current project.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { guessType } from "./pack.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadPlaywright(cwd = process.cwd()) {
  for (const base of [join(cwd, "noop.js"), import.meta.url]) {
    const req = createRequire(base);
    for (const name of ["playwright", "@playwright/test"]) {
      try { const m = req(name); if (m.chromium) return m; } catch { /* next */ }
    }
  }
  return null;
}

export const STUB = String.raw`(function(){
  var calls = window.__tendrilCalls = [];
  var rec = function(name, args){ try { calls.push({ at: Date.now(), fn: name, args: JSON.parse(JSON.stringify(args)) }); } catch(e) { calls.push({ at: Date.now(), fn: name, args: String(args) }); } };
  var state = window.__TENDRIL_PREVIEW_STATE__ || {};
  var listeners = {}, stateListeners = [];
  var path = function(p){ return Array.isArray(p) ? p.map(String) : (p == null || p === "" ? [] : String(p).split(".").filter(Boolean)); };
  var get = function(p){ var o = state; for (var k of path(p)) { if (o == null) return undefined; o = o[k]; } return o; };
  var set = function(p, v){ var ks = path(p), o = state; for (var i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== "object" || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; } if (v === undefined || v === null) delete o[ks[ks.length-1]]; else o[ks[ks.length-1]] = v; };
  var merge = function(t, p){ for (var k in p) { if (p[k] === null) delete t[k]; else if (typeof p[k] === "object" && !Array.isArray(p[k])) { if (typeof t[k] !== "object" || t[k] === null || Array.isArray(t[k])) t[k] = {}; merge(t[k], p[k]); } else t[k] = p[k]; } };
  var fire = function(){ stateListeners.forEach(function(f){ try { f(state, [], "device:d_preview"); } catch(e) { setTimeout(function(){ throw e; }); } }); };
  var ready = function(){ rec("ready", []); };
  ready.manual = function(){ rec("ready.manual", []); };
  var seq = 0;
  window.tendril = {
    send: function(data, opts){ rec("send", [data, opts]); return Promise.resolve({ seq: ++seq, queued: false }); },
    state: {
      get: function(p){ return get(p); },
      set: function(p, v){ rec("state.set", [p, v]); set(p, v); fire(); },
      delete: function(p){ rec("state.delete", [p]); set(p, null); fire(); },
      patch: function(m){ rec("state.patch", [m]); merge(state, m); fire(); },
      mine: function(){ return (state._device || {}).d_preview; },
      on: function(f){ stateListeners.push(f); return function(){ stateListeners = stateListeners.filter(function(x){ return x !== f; }); }; }
    },
    on: function(type, f){ (listeners[type] = listeners[type] || []).push(f); return function(){}; },
    upload: function(blob, opts){ rec("upload", [{ size: blob && blob.size, type: blob && blob.type }, opts]); return Promise.resolve({ id: "b_preview", url: "_tendril/blob/b_preview" }); },
    ready: ready,
    expose: function(name, opts, fn){ rec("expose", [name, opts]); return function(){}; },
    voice: { start: function(){ rec("voice.start", []); return Promise.resolve(); }, stop: function(){ rec("voice.stop", []); }, state: "unavailable" },
    speak: function(t){ rec("speak", [t]); },
    capabilities: function(){ var report = window.__TENDRIL_PREVIEW_CAPABILITIES__ || {captured_at:Date.now(),secure:true,capabilities:{camera:{available:true,permission:"granted",needs_user_tap:true,active:false},microphone:{available:true,permission:"granted",needs_user_tap:true,active:false},location:{available:true,permission:"granted",needs_user_tap:true,active:false},motion:{available:true,permission:"unknown",needs_user_tap:true,active:false},file_picker:{available:true,permission:"unknown",needs_user_tap:true,active:null}}}; for(var name of window.__TENDRIL_PREVIEW_DENIED__ || []) if(report.capabilities[name]) report.capabilities[name].permission = "denied"; return Promise.resolve(report); },
    device: { id: "d_preview", role: "owner", name: "preview", pending: false },
    version: 1,
    connected: true,
    control: { hide: function(){ rec("control.hide", []); }, show: function(){ rec("control.show", []); }, position: function(p){ rec("control.position", [p]); } }
  };
  window.__tendrilEmit = function(type, payload){ (listeners[type] || []).forEach(function(fn){ fn(payload); }); };
})();`;

export function injectRuntime(html) {
  const tags = `<script>window.__TENDRIL__={"id":"preview","base":"/","version":1,"ws":"/_tendril/ws","features":{"transcribe":false,"voice":false,"push":false,"vapid":null}};</script><script src="/_tendril/tendril.js"></script>`;
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tags + html.slice(m.index + m[0].length);
  return tags + html;
}

function snippetDirs() {
  return [join(here, "../../snippets"), join(here, "../../server/public/snippets")];
}

export function startServer(dir, initialState) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    if (p === "/_tendril/tendril.js") {
      return send(200, "text/javascript", `window.__TENDRIL_PREVIEW_STATE__=${JSON.stringify(initialState || {})};\n${STUB}`);
    }
    const sn = /^\/_tendril\/snippets\/([A-Za-z0-9_-]+\.js)$/.exec(p);
    if (sn) {
      for (const d of snippetDirs()) {
        const f = join(d, sn[1]);
        if (existsSync(f)) return send(200, "text/javascript", readFileSync(f));
      }
      return send(404, "text/plain", "no such snippet");
    }
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(root, p));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return send(404, "text/plain", "not found");
    const type = guessType(file);
    if (type === "text/html") return send(200, "text/html; charset=utf-8", injectRuntime(readFileSync(file, "utf8")));
    return send(200, type, readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

export async function preview(dir, opts = {}) {
  const pw = loadPlaywright();
  if (!pw) {
    return { ok: false, error: "playwright_missing",
      message: "Install Playwright in this project to use preview: npm i -D playwright && npx playwright install chromium" };
  }
  const server = await startServer(dir, opts.state);
  const port = server.address().port;
  const errors = [], consoleMsgs = [];
  let browser;
  try {
    try {
      browser = await pw.chromium.launch({
        headless: !opts.headed,
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
      });
    } catch (e) {
      return { ok: false, error: "browser_missing", message: `Could not launch Chromium (${String(e.message).split("\n")[0]}). Try: npx playwright install chromium` };
    }
    const mobile = !opts.desktop;
    const fixture = opts.fixture || {};
    const context = await browser.newContext({
      viewport: { width: opts.width || (mobile ? 390 : 1280), height: opts.height || (mobile ? 844 : 800) },
      deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
      permissions: fixture.permissions || ["camera", "microphone", "geolocation"],
      geolocation: fixture.geolocation || { latitude: 52.52, longitude: 13.405 },
    });
    const page = await context.newPage();
    await page.addInitScript((denyMotion) => {
      for (const event of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
        if (event) Object.defineProperty(event, "requestPermission", { configurable: true,
          value: () => Promise.resolve(denyMotion ? "denied" : "granted") });
      }
    }, !!fixture.denied?.includes("motion"));
    if (fixture.denied?.length) await page.addInitScript((denied) => {
      window.__TENDRIL_PREVIEW_DENIED__ = denied;
      if (navigator.mediaDevices?.getUserMedia) {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (constraints) => {
          if ((constraints?.video && denied.includes("camera")) || (constraints?.audio && denied.includes("microphone")))
            return Promise.reject(new DOMException("Permission denied by preview fixture", "NotAllowedError"));
          return original(constraints);
        };
      }
      if (denied.includes("location") && navigator.geolocation) {
        Object.defineProperty(navigator.geolocation, "getCurrentPosition", { configurable: true,
          value: (_ok, fail) => fail?.({ code: 1, message: "Location denied by preview fixture" }) });
      }
    }, fixture.denied);
    if (fixture.capabilities) await page.addInitScript((caps) => { window.__TENDRIL_PREVIEW_CAPABILITIES__ = caps; }, fixture.capabilities);
    if (fixture.hardware) await page.addInitScript((hardware) => {
      const h = hardware || {};
      const define = (key, value) => Object.defineProperty(navigator, key, { configurable: true, value });
      if ("clipboard" in h) define("clipboard", { readText: async () => String(h.clipboard) });
      if ("contacts" in h) define("contacts", { select: async () => h.contacts });
      if ("directory" in h) window.showDirectoryPicker = async () => ({ name: h.directory.name || "fixture", async *entries() {
        for (const entry of h.directory.entries || []) yield [entry.name, { kind: entry.kind || "file" }];
      } });
      if ("gamepads" in h) define("getGamepads", () => h.gamepads);
      const midiInput = new EventTarget(); midiInput.id = "fixture-midi"; midiInput.name = "Fixture MIDI";
      const midiAccess = new EventTarget(); midiAccess.inputs = new Map([[midiInput.id, midiInput]]);
      if (h.midi) define("requestMIDIAccess", async () => midiAccess);
      const hidDevice = new EventTarget(); Object.assign(hidDevice, { productName: "Fixture HID", vendorId: 1, productId: 1,
        collections: [], open: async () => {}, close: async () => {}, sendReport: async () => {} });
      if (h.hid) define("hid", { requestDevice: async () => [hidDevice] });
      const usbDevice = { productName: "Fixture USB", vendorId: 1, productId: 1, configurations: [],
        open: async () => {}, close: async () => {}, transferIn: async () => ({ status: "ok", data: new DataView(new Uint8Array(h.usb?.bytes || []).buffer) }),
        transferOut: async () => ({ status: "ok" }) };
      if (h.usb) define("usb", { requestDevice: async () => usbDevice });
      const nfcReaders = [];
      if (h.nfc) window.NDEFReader = class extends EventTarget { constructor() { super(); nfcReaders.push(this); } async scan() {} };
      const sensors = {};
      for (const [kind, ctor] of Object.entries({ ambient_light: "AmbientLightSensor", magnetometer: "Magnetometer", proximity: "ProximitySensor", accelerometer: "Accelerometer", gyroscope: "Gyroscope" })) {
        if (!(kind in h)) continue;
        window[ctor] = class extends EventTarget { constructor() { super(); sensors[kind] = this; Object.assign(this, h[kind]); }
          start() { this.dispatchEvent(new Event("reading")); } stop() {} };
      }
      window.__tendrilHardwareEmit = (event) => {
        if (event.modality === "nfc") for (const reader of nfcReaders) reader.dispatchEvent(Object.assign(new Event("reading"), {
          serialNumber: event.serial_number || "fixture", message: { records: [{ recordType: "text", data: new TextEncoder().encode(event.text || "fixture tag") }] } }));
        if (event.modality === "midi") midiInput.dispatchEvent(new MessageEvent("midimessage", { data: new Uint8Array(event.bytes || [144, 60, 100]) }));
        if (event.modality === "hid") hidDevice.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: event.report_id || 1,
          data: new DataView(new Uint8Array(event.bytes || [1]).buffer) }));
        if (event.modality === "gamepad") h.gamepads = event.gamepads || [];
        if (sensors[event.modality]) { Object.assign(sensors[event.modality], event.reading || {}); sensors[event.modality].dispatchEvent(new Event("reading")); }
      };
    }, fixture.hardware);
    page.on("console", (m) => consoleMsgs.push({ level: m.type(), text: m.text() }));
    page.on("pageerror", (e) => errors.push({ message: e.message, stack: e.stack }));
    page.on("requestfailed", (r) => consoleMsgs.push({ level: "error", text: `request failed: ${r.url()} ${r.failure()?.errorText || ""}` }));
    const resp = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load", timeout: 20000 });
    const fixtureTrace = [];
    for (const step of fixture.steps || []) {
      if (step.wait_ms) await page.waitForTimeout(step.wait_ms);
      try {
        if (step.click) await page.locator(step.click).click();
        if (step.fill) await page.locator(step.fill).fill(String(step.value ?? ""));
        if (step.event) await page.evaluate(({event, data}) => window.__tendrilEmit(event, data), step);
        if (step.motion) await page.evaluate((m) => window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: m, acceleration: m })), step.motion);
        if (step.hardware_event) await page.evaluate((event) => window.__tendrilHardwareEmit?.(event), step.hardware_event);
        if (step.expect_text) await page.getByText(String(step.expect_text), { exact: false }).first().waitFor({ timeout: 3000 });
        if (step.expect_send) await page.waitForFunction((expected) => (window.__tendrilCalls || []).some((call) =>
          call.fn === "send" && Object.entries(expected).every(([key, value]) => call.args?.[0]?.[key] === value)), step.expect_send, { timeout: 3000 });
        if (step.expect_no_send && await page.evaluate(() => (window.__tendrilCalls || []).some((call) => call.fn === "send")))
          throw new Error("Expected no tendril.send call");
        fixtureTrace.push({ step, ok: true });
      } catch (e) { fixtureTrace.push({ step, ok: false, error: e.message }); errors.push({ message: `fixture: ${e.message}` }); }
    }
    await page.waitForTimeout(opts.waitMs ?? 2500);
    if (opts.eval) {
      try {
        const value = await page.evaluate(`(async () => { ${opts.eval} })()`);
        consoleMsgs.push({ level: "eval", text: JSON.stringify(value ?? null) });
      } catch (e) { errors.push({ message: `eval: ${e.message}` }); }
    }
    const calls = await page.evaluate(() => window.__tendrilCalls || []);
    const title = await page.title();
    const shot = opts.out || join(resolve(dir), ".preview.png");
    await page.screenshot({ path: shot, fullPage: false });
    const consoleErrors = consoleMsgs.filter((m) => m.level === "error");
    return {
      ok: errors.length === 0 && (resp?.ok() ?? false),
      status: resp?.status(), title, uncaught: errors, console_errors: consoleErrors,
      console: consoleMsgs.slice(-50), calls, fixture_trace: fixtureTrace, screenshot: shot,
    };
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
