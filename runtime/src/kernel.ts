import { validateDocumentContext, resolveDocumentUrl, guardLiveHistoryNavigation } from "./document";
import { explicitlyPinned, watchPublicationUpdates } from "./updates";
import { createSlotManager } from "./slots";
import { buildFacetUrl, mountFacets } from "./facets";
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
import { createWakeLockLease } from "./wake-lock";
import { createShareTarget } from "./share-target";
import { createNotifications } from "./notifications";
import { createAgentsStore } from "./agents";
import { createChatStore } from "./chat";
import { createBroadcastsStore } from "./broadcasts";

async function registerServiceWorker(cfg: TendrilConfig, core: ReturnType<typeof createCore>): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !cfg.publication) return null;
  if ((window as any).__TENDRIL_NO_SW__) return null;
  try {
    const registration = await navigator.serviceWorker.register(cfg.base + "_tendril/sw.js", { scope: cfg.base, updateViaCache: "all" });
    // Blocked or unavailable support must not leave callbacks holding no registration.
    if (!registration) return null;
    const announce = () => {
      // A worker can stop between selection and messaging. The explicit save
      // acknowledgement determines success; an advisory announcement must not
      // invalidate registration and cause duplicate listeners on a later retry.
      try { (registration.active || registration.waiting || registration.installing)?.postMessage({ t: "publication", page: cfg.id, publication: cfg.publication }); }
      catch { /* A later activation or explicit save can announce again. */ }
    };
    navigator.serviceWorker.addEventListener("controllerchange", announce);
    navigator.serviceWorker.addEventListener("message", event => {
      if (event.data?.t === "publication_request") announce();
    });
    announce();
    return registration;
  } catch (error) {
    console.info("[tendril] offline support unavailable:", error instanceof Error ? error.message : error);
    return null;
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
  const agents = createAgentsStore(cfg);
  const chat = createChatStore(cfg);
  agents.api.onChange(roster => {
    if (roster.people) chat.api.setPeople(roster.people);
  });
  const broadcasts = createBroadcastsStore(cfg, { autoFetch: options.watchPublication === true });
  const core = createCore(cfg, options.application);
  const pinned = explicitlyPinned(cfg);
  guardLiveHistoryNavigation(cfg, pinned);
  const fetchLatestPublication = async () => {
    const info = await core.host.request<{ version: number; publication?: import("../../contract/index.mjs").PublicationManifest | null }>("info");
    return {
      version: typeof info?.version === "number" ? info.version : 0,
      publication: info?.publication ?? null,
    };
  };
  const slotManager = createSlotManager(cfg, { latest: fetchLatestPublication });
  // If the user already opted into offline caching, mirror hot-swapped publications
  // into the existing Service Worker cache in the background (never registers a new SW).
  const syncHotSwappedOfflineCache = (publication: import("../../contract/index.mjs").PublicationManifest | null | undefined) => {
    if (!publication || typeof navigator === "undefined" || !("serviceWorker" in navigator) || (window as any).__TENDRIL_NO_SW__) return;
    const expectedScope = new URL(cfg.base, location.href).href;
    void navigator.serviceWorker.getRegistration(expectedScope).then(existing => {
      if (existing?.active && existing.scope === expectedScope) {
        return savePublicationOffline(cfg.base, publication);
      }
    }).catch(() => {});
  };
  // The address bar keeps the page's own URL so a reload or new tab opens the latest
  // selected release. Opening an immutable /_publications/ID/ URL pins explicitly.
  const updates = watchPublicationUpdates(cfg, {
    pinned,
    watch: options.watchPublication === true,
    onAgents: notice => agents.applyNotice(notice),
    onMcpSync: notice => core.bus.emit("mcp-sync", notice),
    hasHotSwappableSlots: () => slotManager.hasRegistrations(),
    onBeforeSwitch: async version => {
      const outcome = await slotManager.handlePublicationChange(version);
      if (outcome.handled && outcome.kind === "hot-swapped") syncHotSwappedOfflineCache(outcome.publication);
      return outcome;
    },
  });
  let registration: Promise<ServiceWorkerRegistration> | undefined;
  const registerOffline = () => registration ??= registerServiceWorker(cfg, core).then(registered => {
    if (!registered) throw Object.assign(new Error("Offline saving could not be prepared on this device. Check your connection and try again."), { code: "offline_unavailable" });
    return registered;
  }).catch(error => {
    registration = undefined;
    throw error;
  });
  // Auto-register the scoped Service Worker on idle or PWA install/standalone launch
  // so repeat visits serve immutable assets + SWR HTML instantaneously without requiring
  // a manual "Save offline" click. Honors `__TENDRIL_NO_SW__` for tests/isolation.
  if (options.watchPublication === true && cfg.publication && typeof navigator !== "undefined" && "serviceWorker" in navigator && !(window as any).__TENDRIL_NO_SW__) {
    const autoWarmSw = () => { void registerOffline().catch(() => {}); };
    const standalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
    if (standalone) {
      autoWarmSw();
    } else if (typeof (window as any).requestIdleCallback === "function") {
      (window as any).requestIdleCallback(autoWarmSw, { timeout: 3000 });
    } else {
      setTimeout(autoWarmSw, 1500);
    }
    window.addEventListener("appinstalled", autoWarmSw, { once: true });
  }
  const tracker = installSensorWrappers();
  const installation = createInstallation();
  const transport = createTransportBinding();
  const errors = createErrorTracker(cfg.id, entry => core.bus.emit("error", entry));
  const identity = Object.freeze({
    page: cfg.id,
    version: cfg.version,
    publication: cfg.publication?.id || null,
    documentPath: cfg.documentPath,
    base: new URL(cfg.base, location.href).href,
    managementUrl: new URL(cfg.base + "_tendril/manage", location.href).href,
    ...(cfg.viewerRole ? { role: cfg.viewerRole } : {}),
    ...(cfg.defaultView ? { defaultView: cfg.defaultView } : {}),
  });
  let mountedFacetsCatalog: readonly import("../../contract/index.mjs").FacetDescriptor[] = Object.freeze([]);
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
  window.addEventListener("pagehide", event => {
    stopSensors();
    installation.suspend(); transport.suspend();
    capabilityObserver?.dispose(); capabilityObserver = null;
    offSensors?.(); offSensors = null;
    if (!event.persisted) slotManager.close();
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    installation.resume(); transport.resume();
    offSensors ??= tracker.onChange(sensorChanged);
    capabilityObserver ??= observe();
    sensorChanged();
  });
  let p2pAssetProvider: ((req: { url: string; sha256?: string; type?: string; path?: string; publicationId?: string }) => Promise<{ bytes: Uint8Array; type?: string } | null>) | null = null;
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", event => {
      if (event.data?.t !== "p2p_asset_request") return;
      const port = event.ports?.[0];
      if (!port) return;
      const provider = p2pAssetProvider;
      if (!provider) { port.postMessage({ ok: false }); return; }
      void provider({
        url: String(event.data.url ?? ""),
        ...(typeof event.data.sha256 === "string" ? { sha256: event.data.sha256 } : {}),
        ...(typeof event.data.type === "string" ? { type: event.data.type } : {}),
        ...(typeof event.data.path === "string" ? { path: event.data.path } : {}),
        ...(typeof event.data.publicationId === "string" ? { publicationId: event.data.publicationId } : {}),
      }).then(res => {
        if (!res || !(res.bytes instanceof Uint8Array)) { port.postMessage({ ok: false }); return; }
        const copy = new Uint8Array(res.bytes.byteLength);
        copy.set(res.bytes);
        port.postMessage({ ok: true, bytes: copy.buffer, ...(res.type ? { type: res.type } : {}) }, [copy.buffer]);
      }).catch(() => { try { port.postMessage({ ok: false }); } catch {} });
    });
  }
  const shared: RuntimeServices = {
    host: core.host, application: core.application, agents: agents.api, chat: chat.api, transport: transport.api, errors: errors.api,
    signals: createSignalBinding(options.signals),
    on: (type, listener) => core.bus.on(type, listener),
    ready: () => core.ready(),
    capabilities: filter => describeCapabilities(tracker.status().active, filter),
    version: cfg.version,
    identity,
    installation: installation.api,
    publication: {
      async saveOffline() { await registerOffline(); return savePublicationOffline(cfg.base, slotManager.current ?? cfg.publication); },
      get current() { return slotManager.current; },
      get pinned() { return updates.pinned; },
      get policy() { return updates.policy; },
      get updateAvailable() { return updates.updateAvailable; },
      get facets() { return mountedFacetsCatalog; },
      latest: () => slotManager.latest(),
      assetUrl: (path, publication) => slotManager.assetUrl(path, publication),
      facetUrl: (id, opts) => buildFacetUrl(cfg, id, { ...opts, pinned: opts?.pinned ?? updates.pinned }),
      mountSlot: (name, container, opts) => slotManager.mountSlot(name, container, opts),
      mountFacets: (container, opts) => mountFacets(slotManager, cfg, container, {
        ...opts,
        pinned: updates.pinned,
        onCatalogChange: list => { mountedFacetsCatalog = Object.freeze([...list]); },
      }),
      onUpdate: listener => updates.onUpdate(listener),
      onBeforeReload: handler => updates.onBeforeReload(handler),
      hold: reason => updates.hold(reason),
      update: () => updates.update(),
      registerP2pAssetProvider(provider) {
        p2pAssetProvider = provider;
        return () => { if (p2pAssetProvider === provider) p2pAssetProvider = null; };
      },
    },
    documentUrl(reference) { return resolveDocumentUrl(cfg, reference, updates.pinned); },
    assetUrl(path) {
      if (!path || /[?#\\]/.test(path) || path.startsWith("/") || /^[a-z]+:/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || decodeURIComponent(path) !== path)
        throw new TypeError("Runtime assets require an unencoded relative path");
      return runtimeAsset(cfg, path);
    },
    loadVoice() {
      const url = runtimeAsset(cfg, "voice.mjs");
      return import(/* @vite-ignore */ url);
    },
    sensors: {
      status: () => tracker.status(),
      on: listener => core.bus.on("sensors", listener),
      register: options => tracker.register(options),
      wakeLock: options => createWakeLockLease(o => tracker.register(o), fn => core.bus.on("sensors_stopped", fn), options),
      stopAll: stopSensors,
    },
    shareTarget: createShareTarget(identity.base),
    notifications: createNotifications(identity.base, installation.api, () => registerOffline().catch(() => null)),
    broadcasts: broadcasts.api,
  };
  return Object.freeze(shared);
}
