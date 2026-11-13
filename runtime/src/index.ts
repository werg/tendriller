// tendril.js entry: wires core → voice → push → control → rules and defines window.tendril
// synchronously (PROTOCOL 5, 11).
import { createCore } from "./core";
import { createVoice } from "./voice";
import { setupPush } from "./push";
import { mountControl } from "./control";
import { startRules } from "./rules";
import { registry } from "./registry";
import type { ControlApi, TendrilConfig } from "./types";

function fallbackConfig(): TendrilConfig {
  const base = location.pathname.replace(/[^/]*$/, "");
  return { id: "local", base, version: 0, ws: base + "_tendril/ws", features: { transcribe: false, voice: false, push: false, vapid: null } };
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

  const ready: any = () => core.ready();
  ready.manual = () => core.readyManual();

  const api: any = {
    send: (data: any, opts?: { wake?: boolean }) => core.send(data, opts),
    state: core.state,
    on: (type: string, fn: (p: any) => void) => core.bus.on(type, fn),
    upload: (blob: Blob, opts?: { name?: string }) => core.upload(blob, opts),
    ready,
    expose: (name: string, opts: any, fn: (args: any) => any) => {
      if (typeof opts === "function" && fn === undefined) { fn = opts; opts = {}; }
      return registry.voice ? registry.voice.expose(name, opts || {}, fn) : () => {};
    },
    voice: {
      start: () => (registry.voice ? registry.voice.start() : Promise.resolve()),
      stop: () => registry.voice?.stop(),
      get state() { return registry.voice ? registry.voice.state : "unavailable"; },
    },
    speak: (text: string) => core.speak(text),
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

  registry.voice = guard("voice", () => createVoice(core));
  registry.push = guard("push", () => setupPush(core));
  control = guard("control", () => mountControl(core));
  guard("rules", () => startRules(core));
  registerServiceWorker(cfg, core);
})();
