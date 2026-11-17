import { documentUrl, validateDocumentContext } from "./document";
// Importing this module mounts nothing and requests no device permissions.
// Hosted applications own one page connection. Peer applications use only their
// selected backend and explicit host operations. A page owns all application UI.
import { createCore } from "./core";
import { setupPush } from "./push";
import { describeCapabilities, observeCapabilities } from "./capabilities";
import { installSensorWrappers } from "./sensors";
import { runtimeAsset } from "./assets";
import { savePublicationOffline } from "./publication";
import type { TendrilConfig } from "./types";
import type { RuntimeApi, RuntimeServices, RuntimeEventMap, PeerRuntimeApi, HostedRuntimeApi } from "../../contract/index.mjs";
import { createSignalBinding } from "../../contract/signals.mjs";
import { createHostedSignals } from "./signals";

async function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>): Promise<void> {
  if (!("serviceWorker" in navigator) || !cfg.publication) return;
  if ((window as any).__TENDRIL_NO_SW__) return;
  try {
    const registration = await navigator.serviceWorker.register(cfg.base + "_tendril/sw.js", { scope: cfg.base });
    // Blocked or unavailable support must not leave callbacks holding no registration.
    if (!registration) return;
    const announce = () => (registration.active || registration.waiting || registration.installing)?.postMessage({ t: "publication", page: cfg.id, publication: cfg.publication });
    core.bus.on("welcome", announce);
    navigator.serviceWorker.addEventListener("controllerchange", announce);
    navigator.serviceWorker.addEventListener("message", event => { if (event.data?.t === "publication_request") announce(); });
    announce();
  } catch (error) { console.info("[tendril] offline support unavailable:", error instanceof Error ? error.message : error); }
}

export interface RuntimeOptions {
  application?: import("../../contract/application.mjs").ApplicationBackend;
  signals?: import("../../contract/signals.mjs").Signals;
}
export function startRuntime(cfg: TendrilConfig & { application: { kind: "peer"; id: string } }, options?: RuntimeOptions): PeerRuntimeApi;
export function startRuntime(cfg: TendrilConfig & { application: { kind: "cloudflare"; id: string } }, options?: RuntimeOptions): HostedRuntimeApi;
export function startRuntime(cfg: TendrilConfig, options?: RuntimeOptions): RuntimeApi;
export function startRuntime(cfg: TendrilConfig, options: RuntimeOptions = {}): RuntimeApi {
  validateDocumentContext(cfg);
  if (cfg.publication && cfg.version > 0) {
    const pinned = documentUrl(cfg, new URL(cfg.publication.base, location.href));
    pinned.search = location.search; pinned.hash = location.hash;
    if (pinned.href !== location.href) history.replaceState(history.state, "", pinned.href);
  }
  const core = createCore(cfg, options.application);
  let registration: Promise<void> | undefined;
  const registerOffline = () => registration ??= registerServiceWorker(cfg, core);
  const tracker = installSensorWrappers();
  const identity = Object.freeze({ page: cfg.id, version: cfg.version, publication: cfg.publication?.id || null,
    base: new URL(cfg.base, location.href).href, managementUrl: new URL(cfg.base + "_tendril/manage", location.href).href });
  const observe = () => observeCapabilities(() => tracker.status().active, report => core.bus.emit("capabilities", report));
  let capabilityObserver: ReturnType<typeof observe> | null = observe();
  const sensorChanged = () => {
    const status = tracker.status();
    core.bus.emit("sensors", status);
    if (core.kind === "cloudflare") core.raw({ t: "sensor_usage", active: status.active });
    capabilityObserver?.refresh();
  };
  let offSensors: (() => void) | null = tracker.onChange(sensorChanged);
  core.bus.on("connect", sensorChanged);
  // BFCache restores the same JavaScript realm without running startRuntime again.
  // Suspend observation while away, then reattach and resynchronize the utility.
  window.addEventListener("pagehide", () => {
    capabilityObserver?.dispose(); capabilityObserver = null;
    offSensors?.(); offSensors = null;
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    offSensors ??= tracker.onChange(sensorChanged);
    capabilityObserver ??= observe();
    sensorChanged();
  });
  const shared: RuntimeServices = {
    host: core.host, application: core.application,
    signals: createSignalBinding(options.signals ?? (core.kind === "cloudflare" ? createHostedSignals(core) : undefined)),
    on: (type, listener) => core.bus.on(type, listener),
    ready: () => core.ready(),
    capabilities: () => describeCapabilities(tracker.status().active),
    get device() { return Object.freeze({ ...core.device }); },
    version: cfg.version,
    identity,
    publication: { async saveOffline() { await registerOffline(); return savePublicationOffline(cfg.base, cfg.publication); } },
    assetUrl(path) {
      if (!path || /[?#\\]/.test(path) || path.startsWith("/") || /^[a-z]+:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || decodeURIComponent(path) !== path)
        throw new TypeError("Runtime assets require an unencoded relative path");
      return runtimeAsset(cfg, path);
    },
    sensors: {
      status: () => tracker.status(),
      on: listener => core.bus.on("sensors", listener),
      stopAll() {
        const count = tracker.stopAll();
        core.bus.emit("sensors_stopped", { count });
        return count;
      },
    },
  };
  // Peer publication saving is explicit. There is no hosted data port, outbox,
  // fake connection status, notification service or throw-only compatibility API.
  if (core.kind === "peer") return Object.freeze({ ...shared, kind: "peer" });

  const hosted: HostedRuntimeApi = {
    ...shared, kind: "cloudflare",
    send: (data, options) => core.send(data, options),
    state: core.state, scopes: core.scopes, timers: core.timers,
    get service() { return core.service; },
    conversation: core.conversation, streams: core.streams, records: core.records,
    on<K extends keyof RuntimeEventMap & string>(type: K, listener: (payload: RuntimeEventMap[K]) => void) { return core.bus.on(type, listener); },
    upload: (blob, options) => core.upload(blob, options),
    uploadEvent: (blob, options) => core.uploadEvent(blob, options),
    captures: () => core.captures(), pendingWork: () => core.pendingWork(),
    retryCapture: id => core.retryCapture(id), discardCapture: id => core.discardCapture(id),
    setBlobRetention: (id, options) => core.setBlobRetention(id, options),
    ready: Object.assign(() => core.ready(), { manual: () => core.readyManual() }),
    get device() { return Object.freeze({ ...core.device }); },
    get connected() { return core.connected; },
    get presence() { return core.presence ? { ...core.presence } : null; },
    notifications: setupPush(core),
  };
  if (document.readyState === "complete") setTimeout(registerOffline, 0);
  else window.addEventListener("load", registerOffline, { once: true });
  return Object.freeze(hosted);
}
