import type {
  FacetDescriptor,
  FacetsManifest,
  MountFacetsOptions,
  MountedFacets,
  MountedSlot,
} from "../../contract/index.mjs";
import type { TendrilConfig } from "./types";
import type { SlotManager } from "./slots";
import { resolveDocumentUrl } from "./document";
import { validPublicationPath } from "./paths";

const FACET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_FACETS = 32;
const VALID_ROLES = new Set(["owner", "guest", "display"]);
const DEFAULT_FOR_KEY = /^(?:role:(?:owner|guest|display)|form:(?:phone|tablet|desktop)|role:(?:owner|guest|display)\+form:(?:phone|tablet|desktop)|participant:[A-Za-z0-9_.:@-]{1,128}|device:[A-Za-z0-9_.:-]{1,128})$/;

/** Validate an authored `facets.json` or inline facets manifest. */
export function parseFacetsManifest(raw: unknown): FacetsManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Facets manifest must be an object with { default, facets }");
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.default !== "string" || !FACET_ID.test(input.default)) {
    throw new TypeError("Facets manifest requires a valid lowercase default facet id");
  }
  if (!Array.isArray(input.facets) || input.facets.length === 0 || input.facets.length > MAX_FACETS) {
    throw new TypeError(`Facets manifest requires between 1 and ${MAX_FACETS} facets`);
  }
  const seen = new Set<string>();
  const facets: FacetDescriptor[] = [];
  for (const item of input.facets) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("Each facet must be an object");
    }
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || !FACET_ID.test(value.id)) {
      throw new TypeError(`Invalid facet id: ${String(value.id)}`);
    }
    if (seen.has(value.id)) {
      throw new TypeError(`Duplicate facet id: ${value.id}`);
    }
    seen.add(value.id);
    if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120) {
      throw new TypeError(`Facet "${value.id}" requires a bounded title`);
    }
    if (typeof value.module !== "string" || !validPublicationPath(value.module)) {
      throw new TypeError(`Facet "${value.id}" requires a valid relative module path`);
    }
    if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 300)) {
      throw new TypeError(`Facet "${value.id}" description must be a string up to 300 chars`);
    }
    let roles: Array<"owner" | "guest" | "display"> | undefined;
    if (value.roles !== undefined) {
      if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.some(r => typeof r !== "string" || !VALID_ROLES.has(r))) {
        throw new TypeError(`Facet "${value.id}" roles must be a non-empty array of owner, guest, or display`);
      }
      roles = [...new Set(value.roles as Array<"owner" | "guest" | "display">)];
    }
    facets.push(Object.freeze({
      id: value.id,
      title: value.title.trim(),
      module: value.module,
      ...(value.description !== undefined ? { description: value.description } : {}),
      ...(roles ? { roles: Object.freeze(roles) } : {}),
    }));
  }
  if (!seen.has(input.default)) {
    throw new TypeError(`Default facet "${input.default}" is not declared in facets`);
  }
  let defaultFor: Readonly<Record<string, string>> | undefined;
  if (input.defaultFor !== undefined) {
    if (!input.defaultFor || typeof input.defaultFor !== "object" || Array.isArray(input.defaultFor)) {
      throw new TypeError("Facets manifest defaultFor must be an object mapping selectors to facet ids");
    }
    const entries = Object.entries(input.defaultFor as Record<string, unknown>);
    if (entries.length > 64) throw new TypeError("Facets manifest defaultFor supports at most 64 rules");
    const validated: Record<string, string> = {};
    for (const [selector, facetId] of entries) {
      if (!DEFAULT_FOR_KEY.test(selector)) {
        throw new TypeError(`Invalid defaultFor selector: ${selector}`);
      }
      if (typeof facetId !== "string" || !seen.has(facetId)) {
        throw new TypeError(`defaultFor selector "${selector}" references unknown facet "${String(facetId)}"`);
      }
      validated[selector] = facetId;
    }
    defaultFor = Object.freeze(validated);
  }
  return Object.freeze({
    default: input.default,
    ...(defaultFor ? { defaultFor } : {}),
    facets: Object.freeze(facets),
  });
}

/** Pure shareable URL builder for a named facet (`?view=<id>`), preserving live vs pinned publication context. */
export function buildFacetUrl(
  cfg: Pick<TendrilConfig, "base" | "publication" | "documentPath">,
  id: string,
  {
    param = "view",
    pinned = false,
    base,
    href = typeof location !== "undefined" ? location.href : cfg.base,
  }: { param?: string; pinned?: boolean; base?: string; href?: string } = {},
): string {
  if (typeof id !== "string" || !FACET_ID.test(id)) {
    throw new TypeError(`Invalid facet id: ${String(id)}`);
  }
  if (typeof param !== "string" || !PARAM_NAME.test(param)) {
    throw new TypeError(`Invalid facet query parameter: ${String(param)}`);
  }
  const current = new URL(href);
  const reference = base ?? (cfg.documentPath === null ? "" : cfg.documentPath);
  const resolved = new URL(resolveDocumentUrl(cfg as TendrilConfig, reference, pinned, href));
  const params = new URLSearchParams(current.search);
  params.set(param, id);
  resolved.search = params.toString();
  resolved.hash = current.hash;
  return resolved.href;
}

function ownedPrefixesForManifest(manifestPath: string | null, manifest: FacetsManifest, extraOwns: readonly string[]): string[] {
  const owned = new Set<string>(extraOwns);
  if (manifestPath) owned.add(manifestPath);
  for (const facet of manifest.facets) {
    owned.add(facet.module);
    const slash = facet.module.lastIndexOf("/");
    if (slash > 0) owned.add(facet.module.slice(0, slash + 1));
  }
  return [...owned];
}

function readFacetParam(param: string, href = typeof location !== "undefined" ? location.href : ""): string | null {
  try {
    const raw = new URL(href).searchParams.get(param);
    return raw && FACET_ID.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function detectFormFactor(): "phone" | "tablet" | "desktop" {
  if (typeof window === "undefined" || typeof window.innerWidth !== "number" || window.innerWidth <= 0) return "desktop";
  if (window.innerWidth < 640) return "phone";
  if (window.innerWidth < 1024) return "tablet";
  return "desktop";
}

export interface MountFacetsRuntimeOptions<T = Record<string, unknown>> extends MountFacetsOptions<T> {
  readonly pinned?: boolean;
  readonly fetch?: typeof fetch;
  readonly href?: () => string;
  readonly pushUrl?: (url: string, replace: boolean) => void;
  readonly onPopState?: (listener: () => void) => () => void;
  readonly onCatalogChange?: (facets: readonly FacetDescriptor[]) => void;
}

/**
 * Mount URL-addressable, hot-swappable facets over the same page and Chronolog state.
 * - Reads `?view=<id>` (configurable via `param`) and falls back to `manifest.default`.
 * - Switching facets updates the URL with `history.pushState` and swaps the slot live (zero reload).
 * - Publishing a new `facets.json` or `facets/*.mjs` updates the facet catalog and active facet live.
 */
export async function mountFacets<T = Record<string, unknown>>(
  manager: SlotManager,
  cfg: TendrilConfig,
  container: HTMLElement,
  options: MountFacetsRuntimeOptions<T> = {},
): Promise<MountedFacets> {
  const param = options.param ?? "view";
  if (!PARAM_NAME.test(param)) throw new TypeError(`Invalid facet query parameter: ${param}`);
  const pinned = options.pinned ?? false;
  const fetcher = options.fetch ?? globalThis.fetch;
  const getHref = options.href ?? (() => location.href);
  const pushUrl = options.pushUrl ?? ((url: string, replace: boolean) => {
    if (typeof history !== "undefined") {
      if (replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    }
  });
  const subscribePopState = options.onPopState ?? ((listener: () => void) => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  });

  const manifestInput = options.manifest ?? "facets.json";
  const manifestPath = typeof manifestInput === "string" ? manifestInput : null;
  const loadManifest = async (publication = manager.current): Promise<FacetsManifest> => {
    if (manifestPath === null) return parseFacetsManifest(manifestInput);
    const url = manager.assetUrl(manifestPath, publication);
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) {
      throw Object.assign(new Error(`Could not load facets manifest "${manifestPath}" (${response.status})`), { code: "facets_manifest_unavailable" });
    }
    return parseFacetsManifest(await response.json());
  };

  let manifest = await loadManifest();
  const viewerRole = options.role ?? cfg.viewerRole;
  const formFactor = options.formFactor ?? detectFormFactor();
  const devicePrefKey = `tendril:facet-pref:${cfg.id}:${param}`;

  const readRemembered = (): string | null => {
    if (!options.rememberDevice) return null;
    try {
      const saved = localStorage.getItem(devicePrefKey);
      return saved && FACET_ID.test(saved) ? saved : null;
    } catch { return null; }
  };
  const saveRemembered = (id: string) => {
    if (!options.rememberDevice) return;
    try { localStorage.setItem(devicePrefKey, id); } catch { /* ignore */ }
  };

  const facetById = (id: string | null | undefined): FacetDescriptor | null => {
    if (!id) return null;
    return manifest.facets.find(item => item.id === id) ?? null;
  };

  const resolveDefaultFor = (): FacetDescriptor | null => {
    const rules = manifest.defaultFor;
    if (!rules) return null;
    const keys: string[] = [];
    if (options.deviceId) keys.push(`device:${options.deviceId}`);
    if (options.participantId) keys.push(`participant:${options.participantId}`);
    if (viewerRole) keys.push(`role:${viewerRole}+form:${formFactor}`);
    if (viewerRole) keys.push(`role:${viewerRole}`);
    keys.push(`form:${formFactor}`);
    for (const key of keys) {
      const hit = facetById(rules[key]);
      if (hit) return hit;
    }
    return null;
  };

  const resolveFacet = (requested: string | null): FacetDescriptor => {
    // 1. Explicit URL parameter (?view=<id>) always wins for deep links
    const fromUrl = facetById(requested);
    if (fromUrl) return fromUrl;
    // 2. Live per-device / per-participant / per-role Chronolog binding
    const fromBinding = facetById(options.bindings?.resolve?.());
    if (fromBinding) return fromBinding;
    // 3. Invite-link target view
    const fromInvite = facetById(cfg.defaultView);
    if (fromInvite) return fromInvite;
    // 4. Device-remembered manual choice
    const fromRemembered = facetById(readRemembered());
    if (fromRemembered) return fromRemembered;
    // 5. Declarative manifest.defaultFor (device -> participant -> role+form -> role -> form)
    const fromRules = resolveDefaultFor();
    if (fromRules) return fromRules;
    // 6. Explicit options.defaultFacet
    const fromOption = facetById(options.defaultFacet);
    if (fromOption) return fromOption;
    // 7. Manifest default
    return facetById(manifest.default) ?? manifest.facets[0]!;
  };

  const visibleFacets = (): readonly FacetDescriptor[] => {
    if (!viewerRole) return manifest.facets;
    const matching = manifest.facets.filter(f => !f.roles || f.roles.includes(viewerRole));
    return matching.length > 0 ? Object.freeze(matching) : manifest.facets;
  };

  let active = resolveFacet(readFacetParam(param, getHref()));
  options.onCatalogChange?.(manifest.facets);
  let disposed = false;
  const changeListeners = new Set<(state: { current: FacetDescriptor; facets: readonly FacetDescriptor[] }) => void>();
  const notifyChange = () => {
    options.onCatalogChange?.(manifest.facets);
    const snapshot = Object.freeze({ current: active, facets: manifest.facets });
    for (const listener of changeListeners) {
      try { listener(snapshot); } catch {}
    }
    try { options.onChange?.(snapshot); } catch {}
  };

  const extraOwns = options.owns ?? [];
  const slotName = `facet:${param}`;

  // Mutable holder so mounted facet modules always read the current facet + controller handle.
  const facetAppContext: Record<string, unknown> = {
    ...(options.context && typeof options.context === "object" ? (options.context as Record<string, unknown>) : {}),
  };

  let slot: MountedSlot | null = null;
  const select = async (id: string, selectOptions: { replace?: boolean; updateUrl?: boolean; remember?: boolean } = {}): Promise<void> => {
    if (disposed) throw new Error("FACETS_DISPOSED");
    const target = manifest.facets.find(item => item.id === id);
    if (!target) throw Object.assign(new Error(`Unknown facet "${id}"`), { code: "facet_not_found" });
    const previous = active;
    active = target;
    facetAppContext.facet = active;
    if (selectOptions.remember !== false) saveRemembered(target.id);
    if (selectOptions.updateUrl !== false) {
      const nextUrl = buildFacetUrl(cfg, target.id, { param, pinned, href: getHref() });
      if (nextUrl !== getHref()) pushUrl(nextUrl, selectOptions.replace === true);
    }
    if (slot) {
      await slot.select(target.module);
    }
    if (previous.id !== target.id || previous.module !== target.module) notifyChange();
  };

  const offBindings = options.bindings?.onChange?.(() => {
    if (disposed) return;
    // Only auto-switch on binding updates when no explicit ?view= URL override is active
    if (readFacetParam(param, getHref())) return;
    const next = resolveFacet(null);
    if (next.id !== active.id) {
      void select(next.id, { updateUrl: false, remember: false }).catch(() => {});
    }
  }) ?? (() => {});

  const api: MountedFacets = Object.freeze({
    get current() { return active; },
    list: () => manifest.facets,
    visible: visibleFacets,
    select: (id: string, selectOptions?: { replace?: boolean }) => select(id, selectOptions),
    url: (id: string, urlOptions?: { pinned?: boolean }) =>
      buildFacetUrl(cfg, id, { param, pinned: urlOptions?.pinned ?? pinned, href: getHref() }),
    onChange(listener: (state: { readonly current: FacetDescriptor; readonly facets: readonly FacetDescriptor[] }) => void) {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unregisterOwned();
      offPopState();
      offBindings();
      changeListeners.clear();
      options.onCatalogChange?.([]);
      await slot?.dispose();
      slot = null;
    },
  });

  facetAppContext.facet = active;
  facetAppContext.facets = api;

  const unregisterOwned = manager.registerOwned(
    () => ownedPrefixesForManifest(manifestPath, manifest, extraOwns),
    async ({ publication, changedPaths }) => {
      if (disposed || manifestPath === null || !changedPaths.includes(manifestPath)) return;
      const nextManifest = await loadManifest(publication);
      manifest = nextManifest;
      const nextActive = resolveFacet(active.id);
      const moduleChanged = nextActive.module !== active.module || nextActive.id !== active.id;
      active = nextActive;
      facetAppContext.facet = active;
      notifyChange();
      if (moduleChanged && slot) {
        await slot.select(active.module);
      }
    },
  );

  const offPopState = subscribePopState(() => {
    if (disposed) return;
    const requested = resolveFacet(readFacetParam(param, getHref()));
    if (requested.id !== active.id) {
      void select(requested.id, { updateUrl: false }).catch(() => {});
    }
  });

  try {
    slot = await manager.mountSlot(slotName, container, {
      module: active.module,
      owns: ownedPrefixesForManifest(manifestPath, manifest, extraOwns),
      context: facetAppContext,
      isolation: options.isolation ?? "shadow",
      onSwap: options.onSwap,
      onError: options.onError,
    });
  } catch (error) {
    disposed = true;
    unregisterOwned();
    offPopState();
    offBindings();
    options.onCatalogChange?.([]);
    throw error;
  }

  return api;
}
