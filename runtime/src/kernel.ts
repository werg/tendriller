import { documentUrl, validateDocumentContext } from "./document";
// Importing this module mounts nothing and requests no device permissions.
// startRuntime creates one page connection. A page owns all application UI.
import { createCore } from "./core";
import { setupPush } from "./push";
import { describeCapabilities, observeCapabilities } from "./capabilities";
import { installSensorWrappers } from "./sensors";
import { runtimeAsset } from "./assets";
import { savePublicationOffline } from "./publication";
import type { TendrilConfig } from "./types";
import type { RuntimeApi } from "../../contract/index.mjs";

function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>): void {
  if (!("serviceWorker" in navigator) || !cfg.publication) return;
  const register = async () => {
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
  };
  if (document.readyState === "complete") setTimeout(register, 0);
  else window.addEventListener("load", register, { once: true });
}

export function startRuntime(cfg: TendrilConfig): RuntimeApi {
  validateDocumentContext(cfg);
  if (cfg.publication && cfg.version > 0) {
    const pinned = documentUrl(cfg, new URL(cfg.publication.base, location.href));
    pinned.search = location.search; pinned.hash = location.hash;
    if (pinned.href !== location.href) history.replaceState(history.state, "", pinned.href);
  }
  const core = createCore(cfg);
  const tracker = installSensorWrappers();
  const notifications = setupPush(core);
  const identity = Object.freeze({ page: cfg.id, version: cfg.version, publication: cfg.publication?.id || null,
    base: new URL(cfg.base, location.href).href, managementUrl: new URL(cfg.base + "_tendril/manage", location.href).href });
  const observe = () => observeCapabilities(() => tracker.active(), report => core.bus.emit("capabilities", report));
  let capabilityObserver: ReturnType<typeof observe> | null = observe();
  const sensorChanged = () => {
    const active = tracker.active();
    core.bus.emit("sensors", active);
    core.raw({ t: "sensor_usage", active });
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
  const api: RuntimeApi = {
    send: (data, options) => core.send(data, options),
    request: (path, options) => core.request(path, options),
    state: core.state, scopes: core.scopes,
    get service() { return core.service; },
    conversation: core.conversation, streams: core.streams, records: core.records,
    on: (type, listener) => core.bus.on(type, listener),
    blobUrl: id => core.blobUrl(id),
    upload: (blob, options) => core.upload(blob, options),
    uploadEvent: (blob, options) => core.uploadEvent(blob, options),
    captures: () => core.captures(), pendingWork: () => core.pendingWork(),
    retryCapture: id => core.retryCapture(id), discardCapture: id => core.discardCapture(id),
    setBlobRetention: (id, options) => core.setBlobRetention(id, options),
    ready: Object.assign(() => core.ready(), { manual: () => core.readyManual() }),
    capabilities: () => describeCapabilities(tracker.active()),
    deviceHeaders: () => core.deviceHeaders(),
    get device() { return Object.freeze({ ...core.device }); },
    version: cfg.version,
    get connected() { return core.connected; },
    get presence() { return core.presence ? { ...core.presence } : null; },
    identity,
    publication: { saveOffline: () => savePublicationOffline(cfg.base, cfg.publication) },
    assetUrl(path) {
      if (!path || /[?#\\]/.test(path) || path.startsWith("/") || /^[a-z]+:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || decodeURIComponent(path) !== path)
        throw new TypeError("Runtime assets require an unencoded relative path");
      return runtimeAsset(cfg, path);
    },
    sensors: {
      active: () => tracker.active(),
      on: listener => core.bus.on("sensors", listener),
      stopAll() {
        const count = tracker.stopAll();
        core.bus.emit("sensors_stopped", { count });
        return count;
      },
    },
    notifications,
  };
  registerServiceWorker(cfg, core);
  return Object.freeze(api);
}
