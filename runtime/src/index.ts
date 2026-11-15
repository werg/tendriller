// tendril.js entry: wires core → push → control → rules and defines window.tendril
// synchronously (PROTOCOL 5, 11).
import { createCore } from "./core";
import { setupPush } from "./push";
import { mountControl } from "./control";
import { startRules } from "./rules";
import { registry } from "./registry";
import { describeCapabilities, observeCapabilities } from "./capabilities";
import { installSensorWrappers } from "./control/sensors";
import type { ControlApi, TendrilConfig } from "./types";
import type { CaptureOptions } from "./capture";
import type { RuntimeApi } from "../../contract/index.mjs";

function fallbackConfig(): TendrilConfig {
  const base = location.pathname.replace(/[^/]*$/, "");
  return { id: "local", base, version: 0, ws: base + "_tendril/ws", features: { push: false, vapid: null,
    shared_by: "Tendriller user", speech: { model: "cactus-whistle-v4", url: "_tendril/speech/whistle.cact",
      sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb" } } };
}

function guard<T>(what: string, fn: () => T): T | undefined {
  try { return fn(); } catch (e) { console.error(`[tendril] ${what} failed to start`, e); return undefined; }
}

function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>) {
  const w = window as any;
  if (!("serviceWorker" in navigator)) return;
  const go = () => {
    if (w.__TENDRIL_NO_SW__) return;
    navigator.serviceWorker.register(cfg.base + "_tendril/sw.js", { scope: cfg.base }).then((reg) => {
      const ping = () => (reg.active || reg.waiting || reg.installing)?.postMessage({ t: "update", version: cfg.version });
      core.bus.on("welcome", ping);
      if (core.connected) ping();
    }).catch((e) => console.info("[tendril] service worker not registered:", e && e.message ? e.message : e));
  };
  if (document.readyState === "complete") setTimeout(go, 0);
  else window.addEventListener("load", go, { once: true });
}

(function main() {
  const w = window as any;
  if (w.tendril && w.tendril._core) return; // included twice
  const cfg: TendrilConfig = w.__TENDRIL__ || fallbackConfig();
  if (!w.__TENDRIL__) console.warn("[tendril] window.__TENDRIL__ missing; using defaults");
  const core = createCore(cfg);
  let control: ControlApi | undefined;

  const ready = Object.assign(() => core.ready(), { manual: () => core.readyManual() });

  const api: RuntimeApi = {
    send: (data: any, opts?: { wake?: boolean }) => core.send(data, opts),
    state: core.state,
    streams: core.streams,
    on: (type: string, fn: (p: any) => void) => core.bus.on(type, fn),
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
  Object.defineProperty(api, "_core", { value: core, enumerable: false }); // internal: control + e2e tests
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
