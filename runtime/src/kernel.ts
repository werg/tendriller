import { documentUrl, validateDocumentContext } from "./document";
// Importing this module mounts nothing and requests no device permissions.
// One application session owns data. A page owns all application UI.
import { createCore } from "./core";
import { describeCapabilities, observeCapabilities } from "./capabilities";
import { installSensorWrappers } from "./sensors";
import { runtimeAsset } from "./assets";
import { savePublicationOffline } from "./publication";
import type { TendrilConfig } from "./types";
import type { RuntimeApi, RuntimeServices } from "../../contract/index.mjs";
import { createSignalBinding } from "../../contract/signals.mjs";

async function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>): Promise<void> {
  if (!("serviceWorker" in navigator) || !cfg.publication) return;
  if ((window as any).__TENDRIL_NO_SW__) return;
  try {
    const registration = await navigator.serviceWorker.register(cfg.base + "_tendril/sw.js", { scope: cfg.base });
    // Blocked or unavailable support must not leave callbacks holding no registration.
    if (!registration) return;
    const announce = () => (registration.active || registration.waiting || registration.installing)?.postMessage({ t: "publication", page: cfg.id, publication: cfg.publication });
    navigator.serviceWorker.addEventListener("controllerchange", announce);
    navigator.serviceWorker.addEventListener("message", event => { if (event.data?.t === "publication_request") announce(); });
    announce();
  } catch (error) { console.info("[tendril] offline support unavailable:", error instanceof Error ? error.message : error); }
}

export interface RuntimeOptions {
  application?: import("../../contract/application.mjs").ApplicationBackend;
  signals?: import("../../contract/signals.mjs").Signals;
}
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
    capabilityObserver?.refresh();
  };
  let offSensors: (() => void) | null = tracker.onChange(sensorChanged);
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
    signals: createSignalBinding(options.signals),
    on: (type, listener) => core.bus.on(type, listener),
    ready: () => core.ready(),
    capabilities: () => describeCapabilities(tracker.status().active),
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
  return Object.freeze(shared);
}
