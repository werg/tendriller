// tendril.js entry: wires core → push → control → rules and defines window.tendril
// synchronously (PROTOCOL 5, 11).
import { createCore } from "./core";
import { setupPush } from "./push";
import { mountControl } from "./control";
import { startRules } from "./rules";
import { registry } from "./registry";
import { describeCapabilities, observeCapabilities } from "./capabilities";
import { installSensorWrappers } from "./sensors";
import type { ControlApi, TendrilConfig } from "./types";
import type { CaptureOptions } from "./capture";
import type { RuntimeApi, OperationOptions } from "../../contract/index.mjs";


function guard<T>(what: string, fn: () => T): T | undefined {
  try { return fn(); } catch (e) { console.error(`[tendril] ${what} failed to start`, e); return undefined; }
}

function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>) {
  const w = window as any;
  if (!("serviceWorker" in navigator)) return;
  if (!cfg.publication) return;
  const go = () => {
    if (w.__TENDRIL_NO_SW__) return;
    navigator.serviceWorker.register(cfg.base + "_tendril/sw.js", { scope: cfg.base }).then((reg) => {
      const ping = () => (reg.active || reg.waiting || reg.installing)?.postMessage({ t: "publication", page: cfg.id, publication: cfg.publication });
      core.bus.on("welcome", ping);
      navigator.serviceWorker.addEventListener("controllerchange", ping);
      navigator.serviceWorker.addEventListener("message", event => { if (event.data?.t === "publication_request") ping(); });
      ping();
    }).catch((e) => console.info("[tendril] service worker not registered:", e && e.message ? e.message : e));
  };
  if (document.readyState === "complete") setTimeout(go, 0);
  else window.addEventListener("load", go, { once: true });
}

(function main() {
  const w = window as any;
  if (w.tendril) return;
  const cfg: TendrilConfig = w.__TENDRIL__;
  if (!cfg) throw new Error("The Tendriller runtime requires an explicit page configuration.");
  // The address itself pins a live page, so browser reload/offline recovery is
  // unambiguous even when a navigation has no initiating service-worker client.
  if (cfg.publication && cfg.version > 0) {
    const pinned = new URL(cfg.publication.entry || "index.html", new URL(cfg.publication.base, location.href));
    pinned.search = location.search; pinned.hash = location.hash;
    if (pinned.href !== location.href) history.replaceState(history.state, "", pinned.href);
  }
  const core = createCore(cfg);
  let control: ControlApi | undefined;

  const ready = Object.assign(() => core.ready(), { manual: () => core.readyManual() });

  const api: RuntimeApi = {
    send: (data: any, opts?: OperationOptions & { wake?: boolean }) => core.send(data, opts),
    request: (path, options) => core.request(path, options),
    state: core.state,
    preferences: core.preferences,
    scopes: core.scopes,
    get service() { return core.service; },
    conversation: core.conversation,
    streams: core.streams,
    on: (type: string, fn: (p: any) => void) => core.bus.on(type, fn),
    blobUrl: id => core.blobUrl(id),
    upload: (blob: Blob, opts?: { name?: string; keep?: boolean }) => core.upload(blob, opts),
    uploadEvent: (blob: Blob, opts: CaptureOptions) => core.uploadEvent(blob, opts),
    captures: () => core.captures(),
    pendingWork: () => core.pendingWork(),
    retryCapture: (id: string) => core.retryCapture(id),
    discardCapture: (id: string) => core.discardCapture(id),
    setBlobRetention: (id: string, opts: { keep: boolean }) => core.setBlobRetention(id, opts),
    ready,
    speak: (text: string) => core.speak(text),
    tts: core.tts,
    capabilities: () => describeCapabilities(installSensorWrappers().active()),
    /** Headers proving this device to page HTTP routes. */
    deviceHeaders: () => core.deviceHeaders(),
    device: core.device, // live object: role/pending update in place
    version: cfg.version,
    get connected() { return core.connected; },
    get presence() { return core.presence; },
    control: {
      hide: () => control?.hide(),
      show: () => control?.show(),
      position: (p: "bottom-right" | "bottom-left" | "top-right" | "top-left") => control?.position(p),
    },
  };
  Object.defineProperty(w, "tendril", { value: api, configurable: true, enumerable: true, writable: false });

  registry.push = guard("push", () => setupPush(core));
  control = guard("control", () => mountControl(core));
  guard("capabilities", () => {
    const sensors = installSensorWrappers();
    const emit = (report: Awaited<ReturnType<typeof describeCapabilities>>) => core.bus.emit("capabilities", report);
    const stop = observeCapabilities(() => sensors.active(), emit);
    const off = sensors.onChange(() => { void describeCapabilities(sensors.active()).then(emit); });
    window.addEventListener("pagehide", () => { stop(); off(); }, { once: true });
  });
  guard("rules", () => startRules(core));
  registerServiceWorker(cfg, core);
})();
