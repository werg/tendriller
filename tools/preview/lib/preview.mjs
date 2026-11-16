import { createHash } from "node:crypto";
// Headless preview: serves the production runtime with a local protocol adapter.
// Uses production state, durability and lifecycle behavior with explicit fixtures.
// Needs `playwright` (or `@playwright/test`) resolvable from the current project.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { guessType, listFiles } from "../../cli/lib/pack.mjs";
import { attachRuntime, FIXTURE_TRANSPORT, resolveFixture } from "./preview-runtime.mjs";
import { assets as runtimeAssets, implementation as runtimeSupport, manifest as runtimeManifest } from "./preview-bundle.mjs";
import { schemaDocument, CONTRACT_VERSION, assertValid } from "@tendriller/core/contract";

export function loadPlaywright(cwd = process.cwd()) {
  for (const base of [join(cwd, "noop.js"), import.meta.url]) {
    const req = createRequire(base);
    for (const name of ["playwright", "@playwright/test"]) {
      try { const m = req(name); if (m.chromium) return m; } catch { /* next */ }
    }
  }
  return null;
}

export function injectRuntime(html, publication = { id: "preview", base:"/_publications/preview/", entry:"index.html", version:1, runtime:{id:runtimeManifest.id,version:runtimeManifest.version,base:"/_tendril/runtime/"+runtimeManifest.id+"/"}, assets:[] }, documentPath = "index.html") {
  const config = { id: "preview", base: "/", version: publication.version, preview: true, publication, documentPath, ws: "/_tendril/ws", features: {
    push: false, vapid: null, shared_by: "Local preview", speech: null,
  } };
  const directory = posix.dirname(documentPath);
  const base = publication.base + (directory === "." ? "" : directory.split("/").map(encodeURIComponent).join("/") + "/");
  const escapedBase = base.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const configJson = JSON.stringify(config).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const tags = `<base href="${escapedBase}"><script>window.__TENDRIL__=${configJson};</script><script src="/_tendril/runtime/${runtimeManifest.id}/tendril.js"></script><script>${FIXTURE_TRANSPORT}</script>`;
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tags + html.slice(m.index + m[0].length);
  return tags + html;
}

export async function startServer(dir, initialState, fixture = {}, options = {}) {
  if (fixture.capabilities) throw new Error("Preview derives capabilities from the real browser. Use denied or hardware fixtures to change browser inputs.");
  const root = realpathSync(resolve(dir));
  options = { assets: runtimeAssets, implementation: runtimeSupport, ...options };
  const service = { contract: CONTRACT_VERSION, core_release: runtimeManifest.version,
    workflows: [], limits: {}, ...structuredClone(fixture.service || {}) };
  assertValid("serviceDescriptor", service);
  if (service.contract !== runtimeManifest.contract) throw new Error("Preview service fixture must use the runtime's contract");
  const publications = new Map();
  let currentPublication;
  const snapshotPublication = () => {
    const contents = new Map();
    for (const path of listFiles(root)) { const file=safeFile(root,"/"+path); if(file)contents.set(path,readFileSync(file)); }
    if (!contents.has("index.html")) throw new Error("Preview directory must contain an authored index.html");
    const entries=[...contents].sort(([a],[b])=>a.localeCompare(b)).map(([path,bytes])=>({path,type:guessType(path),sha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.length}));
    const id=createHash("sha256").update(JSON.stringify({runtime:runtimeManifest.id,assets:entries})).digest("hex");
    if(!publications.has(id))publications.set(id,{contents,manifest:{id,version:publications.size+1,base:"/_publications/"+id+"/",entry:"index.html",runtime:{id:runtimeManifest.id,version:runtimeManifest.version,base:"/_tendril/runtime/"+runtimeManifest.id+"/"},assets:entries}});
    currentPublication=publications.get(id).manifest;return publications.get(id);
  };
  const safeFile = (base, pathname) => {
    base = realpathSync(base);
    const file = resolve(base, "." + pathname);
    // Match publication: symlinks (including parent-directory links) are not
    // page assets and must not expose files elsewhere on the preview host.
    return (file === base || file.startsWith(base + sep)) && existsSync(file)
      && realpathSync(file) === file && statSync(file).isFile() ? file : null;
  };
  snapshotPublication();
  let adapter, stopPromise, stopping = false, httpFixtures = structuredClone(fixture.http || []);
  const connections = new Set();
  const mockedHttp = [];
  const installHttp = routes => {
    for (const route of routes) {
      const i = httpFixtures.findIndex(r => r.method === route.method && r.path === route.path && isDeepStrictEqual(r.query, route.query));
      if (i >= 0) httpFixtures[i] = structuredClone(route); else httpFixtures.push(structuredClone(route));
    }
  };
  const server = createServer(async (req, res) => {
    if (stopping) { req.socket.destroy(); return; }
    const send = (code, type, body, extra = {}) => {
      if (stopping || res.destroyed) return;
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra }); res.end(body);
    };
    const json = (status, value) => send(status, "application/json", JSON.stringify(value));
    try {
      const url = new URL(req.url, "http://preview");
      const p = decodeURIComponent(url.pathname);
      const publicationRoute=/^\/_publications\/([a-f0-9]{64})\/(.*)$/.exec(p);
      if(publicationRoute){
        const stored=publications.get(publicationRoute[1]), requested=publicationRoute[2];
        const path=!requested||requested.endsWith("/")?requested+"index.html":requested,bytes=stored?.contents.get(path);
        if(!bytes)return json(404,{error:{code:"not_found",message:"No such publication asset"}});
        const type=guessType(path);return send(200,type,type==="text/html"?injectRuntime(bytes.toString("utf8"),stored.manifest,path):bytes,{"cache-control":"public,max-age=31536000,immutable","X-Tendril-Publication":stored.manifest.id});
      }
      const query = Object.fromEntries(url.searchParams);
      const mock = httpFixtures.find(r => (r.method || "GET") === req.method && r.path === p && isDeepStrictEqual(r.query || {}, query));
      if (mock) {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Fixture request is too large"); }
        const parsed = body ? JSON.parse(body) : undefined;
        const match = !mock.expect_body || Object.entries(mock.expect_body).every(([key, value]) => isDeepStrictEqual(parsed?.[key], value));
        mockedHttp.push({ method: req.method, path: p, ...(url.search ? { query } : {}), body: parsed, matched: match, status: match ? (mock.status || 200) : 400 });
        if (!match) return json(400, { error: { code: "fixture_mismatch", message: "Request body did not match the scenario" } });
        if (mock.once) httpFixtures.splice(httpFixtures.indexOf(mock), 1);
        if (mock.update) installHttp(mock.update);
        if (mock.broadcast) adapter.broadcast(mock.broadcast);
        return json(mock.status || 200, resolveFixture(mock.json ?? {}, { event: adapter.events.at(-1), device: adapter.devices[0] }));
      }
      if (p === "/_preview/events" && req.method === "POST") {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw Error("Fixture event exceeds 64 KiB"); }
        const { event, data } = JSON.parse(body);
        if (typeof event !== "string" || !event) throw Error("Fixture event needs a name");
        adapter.broadcast({ t: "fixture_event", event, data });
        return json(200, { ok: true });
      }
      if (p === "/api/service" || p === "/_tendril/service") return json(200, service);
      if (p === "/_tendril/scopes" && req.method === "GET") return json(200, { scopes: adapter.scopes });
      if (p === `/contract/v${CONTRACT_VERSION}.json`) return json(200, schemaDocument);
      if (p === "/_tendril/info") return json(200, { id: "preview", version: currentPublication.version, files: listFiles(root), publication: currentPublication, features: {} });
      const streamRoute = /^\/_tendril\/streams(?:\/([^/]+)(?:\/(records|latest))?)?$/.exec(p);
      if (streamRoute) {
        if (req.method !== "GET") return json(405, { error: { code: "preview_unsupported", message: "Declare and feed custom streams in the preview fixture" } });
        const [, name, action] = streamRoute;
        if (!name) return json(200, adapter.streams.list());
        if (!action) return json(200, adapter.streams.info(name));
        if (action === "latest") return json(200, adapter.streams.latest(name));
        const after = url.searchParams.get("after");
        if (after === null || after.trim() === "") return json(400, { error: { code: "cursor_required", message: "Provide an explicit after cursor" } });
        return json(200, adapter.streams.read(name, Number(after), url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100));
      }
      if (p === "/_tendril/devices" || p === "/_tendril/focus") {
        if (adapter.role !== "owner") return json(403, { error: { code: "forbidden", message: "Owner access required" } });
        if (req.method === "GET") return json(200, adapter.configuration());
        if ((p.endsWith("devices") && req.method === "PATCH") || (p.endsWith("focus") && req.method === "POST")) {
          let body = ""; for await (const chunk of req) body += chunk;
          return json(200, p.endsWith("devices") ? adapter.updateDevice(JSON.parse(body)) : adapter.setFocus(JSON.parse(body)));
        }
        return json(405, { error: { code: "method_not_allowed", message: "Unsupported device action" } });
      }
      if (p === "/_tendril/manifest.webmanifest") return json(200, { name: "Tendriller preview", start_url: "/", display: "standalone" });
      const stored = await adapter.storage.handle(req, url);
      if (stored) return stored.headers || stored.status === 204
        ? send(stored.status, stored.headers?.["content-type"] || "application/octet-stream", stored.body, stored.headers)
        : json(stored.status, stored.body);
      if (p.startsWith("/_tendril/")) {
        const asset = options.assets?.[p];
        if (asset) return send(200, guessType(p), Buffer.from(asset, "base64"), {
          "cache-control": "no-cache", ...(p.endsWith("/sw.js") ? { "Service-Worker-Allowed": "/" } : {}),
        });
        if (p.startsWith("/_tendril/runtime/")) return json(404, { error: { code: "not_found", message: "Runtime asset is not in this build" } });
        return json(501, { error: { code: "preview_unsupported", message: "This service operation needs an explicit HTTP fixture or a real service" } });
      }
      if (p === "/favicon.ico") return send(204, "image/x-icon", "");
      const file = safeFile(root, p.endsWith("/") ? p + "index.html" : p);
      if (!file) return send(404, "text/plain", "Not found");
      const type = guessType(file);
      return send(200, type === "text/html" ? "text/html; charset=utf-8" : type,
        type === "text/html" ? injectRuntime(readFileSync(file, "utf8"),snapshotPublication().manifest,p.endsWith("/") ? p.slice(1) + "index.html" : p.slice(1)) : readFileSync(file), { "cache-control": "no-cache", "X-Tendril-Publication": currentPublication.id });
    } catch (error) { json(error.status || 400, { error: { code: error.code || "bad_request", message: error.message } }); }
  });
  // Own every TCP connection, including browser preconnects, incomplete HTTP
  // requests and sockets later upgraded to WebSocket. HTTP close alone can wait
  // for peers that have not finished sending a request.
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    if (stopping) socket.destroy();
  });
  adapter = await attachRuntime(server, { state: initialState ?? fixture.state ?? {}, role: fixture.role || "owner", streams: fixture.streams, version: () => currentPublication.version, scopes: fixture.scopes || [], service, implementation: options.implementation,
    onEvent: fixture.reply ? (event, api) => api.say({ text: String(fixture.reply), in_reply_to: event.seq, speak: false }) : undefined });
  server.preview = adapter;
  server.mockedHttp = mockedHttp;
  server.setHttpFixtures = installHttp;
  server.stopPreview = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    // Stop admission before awaiting WebSocket shutdown: the still-open page
    // can otherwise reconnect while afterEach is waiting for its server.
    const httpClosed = new Promise((resolve, reject) => server.close(error => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve();
    }));
    const runtimeClosed = adapter.close();
    // This is an explicit stop of an ephemeral preview, so abort in-flight
    // uploads and partial handshakes instead of waiting for client timeouts.
    for (const socket of connections) socket.destroy();
    stopPromise = Promise.all([httpClosed, runtimeClosed]).then(() => {});
    return stopPromise;
  };
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}

export async function preview(dir, opts = {}) {
  const pw = loadPlaywright();
  if (!pw) {
    return { ok: false, error: "playwright_missing",
      message: "Install Playwright in this project to use preview: npm i -D playwright && npx playwright install chromium" };
  }
  const fixture = opts.fixture || {};
  const server = await startServer(dir, opts.state, fixture, opts);
  const port = server.address().port;
  const errors = [], consoleMsgs = [];
  let browser;
  try {
    try {
      browser = await pw.chromium.launch({
        headless: !opts.headed,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
      });
    } catch (e) {
      return { ok: false, error: "browser_missing", message: `Could not launch Chromium (${String(e.message).split("\n")[0]}). Try: npx playwright install chromium` };
    }
    const mobile = !opts.desktop;
    const context = await browser.newContext({
      viewport: { width: opts.width || (mobile ? 390 : 1280), height: opts.height || (mobile ? 844 : 800) },
      deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
      permissions: fixture.permissions || [],
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
    await page.waitForFunction(() => window.tendril?.connected, null, { timeout: 10000 });
    const fixtureTrace = [];
    for (const rawStep of fixture.steps || []) {
      if (rawStep.wait_ms) await page.waitForTimeout(rawStep.wait_ms);
      const step = resolveFixture(rawStep, { event: server.preview.events.at(-1), device: server.preview.devices[0] });
      try {
        if (step.http) server.setHttpFixtures(step.http);
        if (step.offline !== undefined) { server.preview.setOnline(!step.offline); await context.setOffline(!!step.offline); }
        if (step.role) server.preview.setRole(step.role);
        if (step.reply) server.preview.say(step.reply);
        if (step.scopes) server.preview.setScopes(step.scopes);
        if (step.state_ops) server.preview.updateState(step.state_ops);
        if (step.streams) server.preview.streams.feed(step.streams);
        if (step.presence) server.preview.setPresence(step.presence);
        if (step.reload) await page.reload({ waitUntil: "load" });
        if (step.expect_connected !== undefined) await page.waitForFunction(value => window.tendril.connected === value, step.expect_connected, { timeout: 10000 });
        if (step.click) await page.locator(step.click).click();
        if (step.fill) await page.locator(step.fill).fill(String(step.value ?? ""));
        if (step.event) await page.evaluate(({event, data}) => window.__tendrilEmit(event, data), step);
        if (step.motion) await page.evaluate((m) => window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: m, acceleration: m })), step.motion);
        if (step.hardware_event) await page.evaluate((event) => window.__tendrilHardwareEmit?.(event), step.hardware_event);
        if (step.expect_text) await page.getByText(String(step.expect_text), { exact: false }).first().waitFor({ timeout: 3000 });
        if (step.expect_event) {
          const deadline = Date.now() + 5000;
          while (!server.preview.events.some(event => Object.entries(step.expect_event).every(([key, value]) => JSON.stringify(event.data?.[key]) === JSON.stringify(value)))) {
            if (Date.now() > deadline) throw Error(`No accepted event matched ${JSON.stringify(step.expect_event)}`);
            await page.waitForTimeout(25);
          }
        }
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
    const title = await page.title();
    const shot = opts.out || join(resolve(dir), ".preview.png");
    await page.screenshot({ path: shot, fullPage: false });
    const consoleErrors = consoleMsgs.filter((m) => m.level === "error");
    return {
      ok: errors.length === 0 && consoleErrors.length === 0 && (resp?.ok() ?? false),
      status: resp?.status(), title, uncaught: errors, console_errors: consoleErrors,
      console: consoleMsgs.slice(-50), fixture_trace: fixtureTrace, screenshot: shot,
      runtime: "production", events: server.preview.events, activity: server.preview.activity, state: server.preview.state,
      mocked_http: server.mockedHttp,
    };
  } finally {
    if (browser) await browser.close();
    await server.stopPreview();
  }
}
