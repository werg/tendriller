import { validateDocumentContext, resolveDocumentUrl } from "./document";
import { explicitlyPinned, watchPublicationUpdates } from "./updates";
// Importing this module mounts nothing and requests no device permissions.
// One application session owns data. A page owns all application UI.
import { createCore } from "./core";
import { describeCapabilities, observeCapabilities } from "./capabilities";
import { installSensorWrappers } from "./sensors";
import { runtimeAsset } from "./assets";
import { savePublicationOffline } from "./publication";
import { createInstallation } from "./installation";
import type { TendrilConfig } from "./types";
import type { RuntimeApi, RuntimeServices } from "../../contract/index.mjs";
import { createTransportBinding } from "./transport";
import { createErrorTracker } from "./errors";
import { createSignalBinding } from "../../contract/signals.mjs";

async function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !cfg.publication) return false;
  if ((window as any).__TENDRIL_NO_SW__) return false;
  try {
    const registration = await navigator.serviceWorker.register(cfg.base + "_tendril/sw.js", { scope: cfg.base });
    // Blocked or unavailable support must not leave callbacks holding no registration.
    if (!registration) return false;
    const announce = () => {
      // A worker can stop between selection and messaging. The explicit save
      // acknowledgement determines success; an advisory announcement must not
      // invalidate registration and cause duplicate listeners on a later retry.
      try { (registration.active || registration.waiting || registration.installing)?.postMessage({ t: "publication", page: cfg.id, publication: cfg.publication }); }
      catch { /* A later activation or explicit save can announce again. */ }
    };
    navigator.serviceWorker.addEventListener("controllerchange", announce);
    navigator.serviceWorker.addEventListener("message", event => { if (event.data?.t === "publication_request") announce(); });
    announce();
    return true;
  } catch (error) {
    console.info("[tendril] offline support unavailable:", error instanceof Error ? error.message : error);
    return false;
  }
}

export interface RuntimeOptions {
  application?: import("../../contract/application.mjs").ApplicationBackend;
  signals?: import("../../contract/signals.mjs").Signals;
  /** Open the page's publication watch and switch to a newly selected release at the next safe point (the hosted tendril.js entry does). */
  watchPublication?: boolean;
}
export function startRuntime(cfg: TendrilConfig, options: RuntimeOptions = {}): RuntimeApi {
  validateDocumentContext(cfg);
  // The address bar keeps the page's own URL so a reload or new tab opens the latest
  // selected release. Opening an immutable /_publications/ID/ URL pins explicitly.
  const updates = watchPublicationUpdates(cfg, { pinned: explicitlyPinned(cfg), watch: options.watchPublication === true });
  const core = createCore(cfg, options.application);
  let registration: Promise<void> | undefined;
  const registerOffline = () => registration ??= registerServiceWorker(cfg, core).then(registered => {
    if (!registered) throw Object.assign(new Error("Offline saving could not be prepared on this device. Check your connection and try again."), { code: "offline_unavailable" });
  }).catch(error => {
    registration = undefined;
    throw error;
  });
  const tracker = installSensorWrappers();
  const installation = createInstallation();
  const transport = createTransportBinding();
  const errors = createErrorTracker(cfg.id, entry => core.bus.emit("error", entry));
  const identity = Object.freeze({ page: cfg.id, version: cfg.version, publication: cfg.publication?.id || null, documentPath: cfg.documentPath,
    base: new URL(cfg.base, location.href).href, managementUrl: new URL(cfg.base + "_tendril/manage", location.href).href });
  const observe = () => observeCapabilities(() => tracker.status().active, report => core.bus.emit("capabilities", report));
  let capabilityObserver: ReturnType<typeof observe> | null = observe();
  const sensorChanged = () => {
    const status = tracker.status();
    core.bus.emit("sensors", status);
    capabilityObserver?.refresh();
  };
  let offSensors: (() => void) | null = tracker.onChange(sensorChanged);
  const stopSensors = () => {
    const count = tracker.stopAll();
    core.bus.emit("sensors_stopped", { count });
    return count;
  };
  // BFCache restores the same JavaScript realm without running startRuntime again.
  // Suspend observation while away, then reattach and resynchronize the utility.
  window.addEventListener("pagehide", () => {
    stopSensors();
    installation.suspend(); transport.suspend();
    capabilityObserver?.dispose(); capabilityObserver = null;
    offSensors?.(); offSensors = null;
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    installation.resume(); transport.resume();
    offSensors ??= tracker.onChange(sensorChanged);
    capabilityObserver ??= observe();
    sensorChanged();
  });
  const shared: RuntimeServices = {
    host: core.host, application: core.application, transport: transport.api, errors: errors.api,
    signals: createSignalBinding(options.signals),
    on: (type, listener) => core.bus.on(type, listener),
    ready: () => core.ready(),
    capabilities: filter => describeCapabilities(tracker.status().active, filter),
    version: cfg.version,
    identity,
    installation: installation.api,
    publication: { async saveOffline() { await registerOffline(); return savePublicationOffline(cfg.base, cfg.publication); },
      get pinned() { return updates.pinned; }, get updateAvailable() { return updates.updateAvailable; },
      onUpdate: listener => updates.onUpdate(listener), hold: () => updates.hold(), update: () => updates.update() },
    documentUrl(reference) { return resolveDocumentUrl(cfg, reference, updates.pinned); },
    assetUrl(path) {
      if (!path || /[?#\\]/.test(path) || path.startsWith("/") || /^[a-z]+:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || decodeURIComponent(path) !== path)
        throw new TypeError("Runtime assets require an unencoded relative path");
      return runtimeAsset(cfg, path);
    },
    sensors: {
      status: () => tracker.status(),
      on: listener => core.bus.on("sensors", listener),
      register: options => tracker.register(options),
      stopAll: stopSensors,
    },
  };
  return Object.freeze(shared);
}
