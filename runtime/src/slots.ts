import type {
  MountSlotOptions,
  MountedSlot,
  PublicationManifest,
  PublicationUpdate,
  SlotContext,
  SlotModule,
} from "../../contract/index.mjs";
import type { TendrilConfig } from "./types";
import { encodePublicationPath, validPublicationPath } from "./paths";

const SLOT_NAME = /^[a-z0-9][a-z0-9_:-]{0,63}$/;

export interface PublicationDiff {
  readonly runtimeChanged: boolean;
  readonly entryChanged: boolean;
  readonly changedPaths: readonly string[];
}

export interface PublicationClassification {
  readonly kind: "hot-swapped" | "reload";
  readonly changedPaths: readonly string[];
}

export interface PublicationChangeOutcome {
  readonly handled: boolean;
  readonly kind?: "hot-swapped" | "reload";
  readonly publication?: PublicationManifest | null;
  readonly changedPaths?: readonly string[];
}

export interface SlotManagerOptions {
  readonly latest: () => Promise<{ version: number; publication: PublicationManifest | null }>;
  readonly importModule?: (url: string) => Promise<unknown>;
  readonly href?: () => string;
}

export type PublicationSwapHook = (info: {
  readonly version: number;
  readonly publication: PublicationManifest;
  readonly changedPaths: readonly string[];
}) => void | Promise<void>;

export interface SlotManager {
  readonly current: PublicationManifest | null;
  readonly version: number;
  latest(): Promise<{ version: number; publication: PublicationManifest | null }>;
  assetUrl(path: string, publication?: PublicationManifest | null): string;
  mountSlot<T = Record<string, unknown>>(name: string, container: HTMLElement, options: MountSlotOptions<T>): Promise<MountedSlot>;
  registerOwned(paths: () => Iterable<string>, onHotSwap?: PublicationSwapHook): () => void;
  hasRegistrations(): boolean;
  handlePublicationChange(nextVersion: number): Promise<PublicationChangeOutcome>;
  close(): void;
}

/** Validate a relative publication asset path and resolve it against an immutable publication base. */
export function resolvePublicationAssetUrl(
  cfg: Pick<TendrilConfig, "base" | "publication">,
  path: string,
  publication: PublicationManifest | null = cfg.publication ?? null,
  href = typeof location !== "undefined" ? location.href : cfg.base,
): string {
  if (!validPublicationPath(path)) {
    throw new TypeError(`Invalid publication asset path: ${String(path)}`);
  }
  const pageBase = new URL(cfg.base, href);
  if (publication) {
    if (!Array.isArray(publication.assets) || !publication.assets.some(asset => asset.path === path)) {
      throw Object.assign(new Error(`Asset "${path}" is not declared in publication ${publication.id}`), { code: "asset_not_found" });
    }
    const pubBase = new URL(publication.base, pageBase);
    if (pubBase.origin !== pageBase.origin || !pubBase.pathname.startsWith(pageBase.pathname)) {
      throw new TypeError("Publication base escapes page origin");
    }
    const target = new URL(encodePublicationPath(path), pubBase);
    if (target.origin !== pageBase.origin || !target.pathname.startsWith(pubBase.pathname)) {
      throw new TypeError("Publication asset URL escapes publication base");
    }
    return target.href;
  }
  const target = new URL(encodePublicationPath(path), pageBase);
  if (target.origin !== pageBase.origin || !target.pathname.startsWith(pageBase.pathname)) {
    throw new TypeError("Publication asset URL escapes page base");
  }
  return target.href;
}

/** Exact asset hash diff between two atomic publications. */
export function diffPublications(previous: PublicationManifest, next: PublicationManifest): PublicationDiff {
  const prevRuntimeId = previous.runtime?.id ?? previous.runtime?.base;
  const nextRuntimeId = next.runtime?.id ?? next.runtime?.base;
  const runtimeChanged = prevRuntimeId !== nextRuntimeId || previous.runtime?.version !== next.runtime?.version;
  const entryChanged = previous.entry !== next.entry;
  const prevMap = new Map(previous.assets.map(asset => [asset.path, asset.sha256]));
  const nextMap = new Map(next.assets.map(asset => [asset.path, asset.sha256]));
  const changed = new Set<string>();
  for (const [path, hash] of nextMap) {
    if (prevMap.get(path) !== hash) changed.add(path);
  }
  for (const path of prevMap.keys()) {
    if (!nextMap.has(path)) changed.add(path);
  }
  return Object.freeze({
    runtimeChanged,
    entryChanged,
    changedPaths: Object.freeze([...changed].sort()),
  });
}

/** True when a publication path is explicitly owned as a file or directory prefix. */
export function matchesOwnedPath(path: string, owned: ReadonlySet<string>): boolean {
  if (owned.has(path)) return true;
  for (const pattern of owned) {
    if (pattern.endsWith("/") && path.startsWith(pattern)) return true;
  }
  return false;
}

/** Decide whether a new atomic publication can be applied live via slot hot-swap or requires a full reload. */
export function classifyPublicationUpdate(
  previous: PublicationManifest | null,
  next: PublicationManifest | null,
  ownedPaths: ReadonlySet<string>,
): PublicationClassification {
  if (!previous || !next || ownedPaths.size === 0) {
    return Object.freeze({ kind: "reload", changedPaths: Object.freeze([]) });
  }
  const diff = diffPublications(previous, next);
  if (diff.runtimeChanged || diff.entryChanged) {
    return Object.freeze({ kind: "reload", changedPaths: diff.changedPaths });
  }
  if (diff.changedPaths.length === 0) {
    return Object.freeze({ kind: "hot-swapped", changedPaths: diff.changedPaths });
  }
  const allOwned = diff.changedPaths.every(path => matchesOwnedPath(path, ownedPaths));
  return Object.freeze({
    kind: allOwned ? "hot-swapped" : "reload",
    changedPaths: diff.changedPaths,
  });
}

function normalizeOwnedEntry(entry: string): string {
  if (typeof entry !== "string" || !entry) throw new TypeError("Owned slot path must be a non-empty relative path");
  if (entry.endsWith("/")) {
    const trimmed = entry.slice(0, -1);
    if (!validPublicationPath(trimmed)) throw new TypeError(`Invalid owned prefix: ${entry}`);
    return trimmed + "/";
  }
  if (!validPublicationPath(entry)) throw new TypeError(`Invalid owned path: ${entry}`);
  return entry;
}

const defaultImportModule = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

interface SlotEntry {
  readonly name: string;
  readonly container: HTMLElement;
  readonly isolation: "shadow" | "light";
  readonly owns: readonly string[];
  readonly context: Record<string, unknown>;
  readonly onSwap?: MountSlotOptions["onSwap"];
  readonly onError?: MountSlotOptions["onError"];
  path: string;
  version: number;
  publication: PublicationManifest | null;
  hash: string | null;
  controller: AbortController | null;
  cleanup: (() => void | Promise<void>) | null;
  mounted: boolean;
  disposed: boolean;
  queue: Promise<void>;
}

/** Manages live, hot-swappable publication slots backed by atomic immutable publication trees. */
export function createSlotManager(cfg: TendrilConfig, options: SlotManagerOptions): SlotManager {
  const importModule = options.importModule ?? defaultImportModule;
  const href = options.href ?? (() => (typeof location !== "undefined" ? location.href : cfg.base));
  let activeVersion = cfg.version;
  let activePublication: PublicationManifest | null = cfg.publication ?? null;
  let closed = false;
  let swapSequence = 0;

  const slots = new Map<string, SlotEntry>();
  const hooks = new Set<{ paths: () => Iterable<string>; onHotSwap?: PublicationSwapHook }>();

  const assetHash = (publication: PublicationManifest | null, path: string): string | null =>
    publication?.assets.find(asset => asset.path === path)?.sha256 ?? null;

  const getMountRoot = (entry: SlotEntry): HTMLElement | ShadowRoot => {
    if (entry.isolation === "light") return entry.container;
    if (entry.container.shadowRoot) return entry.container.shadowRoot;
    if (typeof entry.container.attachShadow === "function") {
      return entry.container.attachShadow({ mode: "open" });
    }
    return entry.container;
  };

  const clearRoot = (root: HTMLElement | ShadowRoot) => {
    if (typeof root.replaceChildren === "function") root.replaceChildren();
    else root.textContent = "";
  };

  const enqueue = (entry: SlotEntry, task: () => Promise<void>): Promise<void> => {
    const next = entry.queue.then(task, task);
    entry.queue = next.catch(() => {});
    return next;
  };

  const unmountEntry = async (entry: SlotEntry) => {
    const controller = entry.controller;
    const cleanup = entry.cleanup;
    entry.controller = null;
    entry.cleanup = null;
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error("SLOT_UNMOUNTED"));
    }
    if (typeof cleanup === "function") {
      try { await cleanup(); }
      catch (error) {
        try { entry.onError?.(error, { name: entry.name, path: entry.path, version: entry.version, phase: "unmount" }); } catch {}
      }
    }
  };

  const applySlot = async (
    entry: SlotEntry,
    modulePath: string,
    publication: PublicationManifest | null,
    version: number,
    initial: boolean,
  ): Promise<void> => {
    if (closed || entry.disposed) return;
    let url: string;
    let mod: SlotModule;
    try {
      url = resolvePublicationAssetUrl(cfg, modulePath, publication, href());
      const loaded = await importModule(url) as Partial<SlotModule> | null | undefined;
      if (!loaded || typeof loaded.mount !== "function") {
        throw Object.assign(new TypeError(`Slot module "${modulePath}" must export a mount(root, ctx) function`), { code: "invalid_slot_module" });
      }
      mod = loaded as SlotModule;
    } catch (error) {
      // Import failed before teardown: preserve any already-mounted slot cleanly.
      try { entry.onError?.(error, { name: entry.name, path: modulePath, version, phase: "import" }); } catch {}
      if (initial) throw error;
      return;
    }

    if (closed || entry.disposed) return;
    await unmountEntry(entry);
    if (closed || entry.disposed) return;

    const root = getMountRoot(entry);
    clearRoot(root);
    const controller = new AbortController();
    entry.controller = controller;
    entry.path = modulePath;
    entry.publication = publication;
    entry.version = version;
    entry.hash = assetHash(publication, modulePath);

    const ctx: SlotContext = Object.freeze({
      name: entry.name,
      path: modulePath,
      version,
      publication,
      signal: controller.signal,
      app: entry.context,
    });

    try {
      const result = await mod.mount(root, ctx);
      if (closed || entry.disposed || entry.controller !== controller) {
        if (typeof result === "function") {
          try { await result(); } catch {}
        }
        return;
      }
      entry.cleanup = typeof result === "function" ? result : null;
      entry.mounted = true;
      try {
        entry.onSwap?.({
          name: entry.name,
          path: modulePath,
          version,
          publicationId: publication?.id ?? null,
          hash: entry.hash,
          initial,
        });
      } catch {}
    } catch (error) {
      controller.abort(error);
      if (entry.controller === controller) entry.controller = null;
      entry.cleanup = null;
      try { entry.onError?.(error, { name: entry.name, path: modulePath, version, phase: "mount" }); } catch {}
      if (initial) throw error;
    }
  };

  const allOwnedPaths = (): Set<string> => {
    const owned = new Set<string>();
    for (const entry of slots.values()) {
      if (entry.disposed) continue;
      owned.add(entry.path);
      for (const extra of entry.owns) owned.add(extra);
    }
    for (const hook of hooks) {
      for (const path of hook.paths()) owned.add(normalizeOwnedEntry(path));
    }
    return owned;
  };

  const slotChanged = (entry: SlotEntry, changedSet: ReadonlySet<string>, nextPublication: PublicationManifest): boolean => {
    if (changedSet.has(entry.path)) return true;
    const nextHash = assetHash(nextPublication, entry.path);
    if (nextHash !== entry.hash) return true;
    for (const prefix of entry.owns) {
      if (prefix.endsWith("/")) {
        for (const changed of changedSet) {
          if (changed.startsWith(prefix)) return true;
        }
      } else if (changedSet.has(prefix)) {
        return true;
      }
    }
    return false;
  };

  return Object.freeze({
    get current() { return activePublication; },
    get version() { return activeVersion; },
    latest: () => options.latest(),
    assetUrl(path: string, publication: PublicationManifest | null = activePublication): string {
      return resolvePublicationAssetUrl(cfg, path, publication, href());
    },
    async mountSlot<T = Record<string, unknown>>(name: string, container: HTMLElement, opts: MountSlotOptions<T>): Promise<MountedSlot> {
      if (closed) throw new Error("SLOT_MANAGER_CLOSED");
      if (typeof name !== "string" || !SLOT_NAME.test(name)) {
        throw new TypeError("Slot name must be lowercase alphanumeric/hyphen/underscore/colon (1-64 chars)");
      }
      if (!container || typeof container !== "object") {
        throw new TypeError("mountSlot requires a target HTMLElement container");
      }
      if (!opts || typeof opts.module !== "string" || !validPublicationPath(opts.module)) {
        throw new TypeError("mountSlot requires a valid relative module path");
      }
      if (slots.has(name)) {
        throw Object.assign(new Error(`Slot "${name}" is already mounted`), { code: "slot_already_mounted" });
      }
      const isolation = opts.isolation ?? "shadow";
      if (isolation !== "shadow" && isolation !== "light") {
        throw new TypeError('Slot isolation must be "shadow" or "light"');
      }
      const owns = Object.freeze((opts.owns ?? []).map(normalizeOwnedEntry));
      const entry: SlotEntry = {
        name,
        container,
        isolation,
        owns,
        context: (opts.context ?? {}) as Record<string, unknown>,
        onSwap: opts.onSwap,
        onError: opts.onError,
        path: opts.module,
        version: activeVersion,
        publication: activePublication,
        hash: null,
        controller: null,
        cleanup: null,
        mounted: false,
        disposed: false,
        queue: Promise.resolve(),
      };
      slots.set(name, entry);
      try {
        await enqueue(entry, () => applySlot(entry, opts.module, activePublication, activeVersion, true));
      } catch (error) {
        entry.disposed = true;
        slots.delete(name);
        throw error;
      }

      const handle: MountedSlot = Object.freeze({
        get name() { return entry.name; },
        get path() { return entry.path; },
        get version() { return entry.version; },
        get publicationId() { return entry.publication?.id ?? null; },
        async select(modulePath: string) {
          if (entry.disposed || closed) throw new Error("SLOT_DISPOSED");
          if (!validPublicationPath(modulePath)) throw new TypeError(`Invalid slot module path: ${modulePath}`);
          await enqueue(entry, () => applySlot(entry, modulePath, activePublication, activeVersion, false));
        },
        async reload() {
          if (entry.disposed || closed) throw new Error("SLOT_DISPOSED");
          await enqueue(entry, () => applySlot(entry, entry.path, activePublication, activeVersion, false));
        },
        async dispose() {
          if (entry.disposed) return;
          entry.disposed = true;
          slots.delete(name);
          await enqueue(entry, async () => {
            await unmountEntry(entry);
            clearRoot(getMountRoot(entry));
          });
        },
      });
      return handle;
    },
    registerOwned(paths: () => Iterable<string>, onHotSwap?: PublicationSwapHook) {
      const record = { paths, onHotSwap };
      hooks.add(record);
      return () => { hooks.delete(record); };
    },
    hasRegistrations() {
      return slots.size > 0 || hooks.size > 0;
    },
    async handlePublicationChange(nextVersion: number): Promise<PublicationChangeOutcome> {
      if (closed || (slots.size === 0 && hooks.size === 0)) {
        return { handled: false };
      }
      const seq = ++swapSequence;
      let latest: { version: number; publication: PublicationManifest | null };
      try {
        latest = await options.latest();
      } catch {
        return { handled: false, kind: "reload" };
      }
      if (closed || seq !== swapSequence) return { handled: true };
      if (!latest.publication || latest.version !== nextVersion) {
        return { handled: false, kind: "reload", publication: latest.publication };
      }
      const owned = allOwnedPaths();
      const classification = classifyPublicationUpdate(activePublication, latest.publication, owned);
      if (classification.kind !== "hot-swapped") {
        return {
          handled: false,
          kind: "reload",
          publication: latest.publication,
          changedPaths: classification.changedPaths,
        };
      }

      activeVersion = latest.version;
      activePublication = latest.publication;
      const changedSet = new Set(classification.changedPaths);

      // Run manifest/facet hooks first so a facet catalog update can re-point its slot cleanly.
      for (const hook of [...hooks]) {
        if (hook.onHotSwap) {
          try {
            await hook.onHotSwap({
              version: activeVersion,
              publication: activePublication,
              changedPaths: classification.changedPaths,
            });
          } catch {}
        }
      }

      // Hot-swap every mounted slot whose module or owned subtree changed.
      const swaps: Promise<void>[] = [];
      for (const entry of [...slots.values()]) {
        if (entry.disposed) continue;
        if (!slotChanged(entry, changedSet, activePublication)) continue;
        // Skip if a hook already swapped this slot to the new version.
        if (entry.version === activeVersion && entry.publication?.id === activePublication.id) continue;
        swaps.push(enqueue(entry, () => applySlot(entry, entry.path, activePublication, activeVersion, false)));
      }
      await Promise.allSettled(swaps);
      return {
        handled: true,
        kind: "hot-swapped",
        publication: activePublication,
        changedPaths: classification.changedPaths,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      hooks.clear();
      for (const entry of [...slots.values()]) {
        entry.disposed = true;
        slots.delete(entry.name);
        void enqueue(entry, () => unmountEntry(entry));
      }
    },
  });
}

export type { PublicationUpdate };
