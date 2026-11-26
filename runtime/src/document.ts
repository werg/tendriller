import type { RuntimeConfiguration } from "../../contract/index.mjs";
import { encodePublicationPath, validPublicationPath } from "./paths";

/** A publication is shared by its documents; each runtime has one explicit document context. */
export function validateDocumentContext(cfg: RuntimeConfiguration): void {
  if (!cfg.publication) {
    if (cfg.documentPath !== null) throw new TypeError("A page without a publication requires documentPath: null");
    return;
  }
  const publication = cfg.publication;
  const declaredHtml = (path: unknown) => validPublicationPath(path) && publication.assets.some(asset =>
    asset.path === path && /^text\/html(?:;|$)/i.test(asset.type));
  if (!declaredHtml(publication.entry)) throw new TypeError("The publication requires its canonical declared HTML entry");
  if (!declaredHtml(cfg.documentPath)) throw new TypeError("documentPath must identify a declared HTML document in the publication");
}

/** Preserve the current document while changing between a pinned and a live publication base. */
export function documentUrl(cfg: RuntimeConfiguration, base: URL): URL {
  return cfg.documentPath === null ? base : new URL(encodePublicationPath(cfg.documentPath), base);
}

/** Pure authored navigation: retain the live/pinned context without changing asset bases. */
export function resolveDocumentUrl(cfg: RuntimeConfiguration, reference: string, pinned: boolean, href = location.href): string {
  if (typeof reference !== "string") throw new TypeError("Document navigation requires a URL reference");
  const page = new URL(cfg.base, href), scope = pinned && cfg.publication ? new URL(cfg.publication.base, page) : page;
  const current = new URL(href);
  const from = current.origin === scope.origin && current.pathname.startsWith(scope.pathname) ? current : documentUrl(cfg, scope);
  const target = new URL(reference, from);
  if (target.origin !== scope.origin || !target.pathname.startsWith(scope.pathname) || target.username || target.password)
    throw new TypeError("Document navigation must stay within this page's live or pinned context");
  return target.href;
}

const HISTORY_GUARD = Symbol("tendril.liveHistoryGuard");

/**
 * Prevent fragment-only (`#tab`) or query-only (`?tab=1`) history.pushState/replaceState calls
 * on a canonical live page from silently resolving against the injected immutable publication `<base>`
 * and pinning the user to an old version on reload. Explicit `/_publications/` URLs and pinned pages
 * are preserved unchanged.
 */
export function guardLiveHistoryNavigation(cfg: RuntimeConfiguration, pinned: boolean): () => void {
  if (pinned || !cfg.publication || typeof history === "undefined" || typeof location === "undefined") return () => {};
  const hist = history as History & { [HISTORY_GUARD]?: boolean };
  if (hist[HISTORY_GUARD] || typeof hist.pushState !== "function" || typeof hist.replaceState !== "function") return () => {};
  const origPush = hist.pushState.bind(hist);
  const origReplace = hist.replaceState.bind(hist);
  const rewrite = (url: string | URL | null | undefined): string | URL | null | undefined => {
    if (typeof url !== "string" || (!url.startsWith("#") && !url.startsWith("?"))) return url;
    try {
      const current = new URL(location.href);
      const page = new URL(cfg.base, current);
      const pubBase = new URL(cfg.publication!.base, page);
      // Only rewrite while currently on the canonical live URL (never alter an explicit pin).
      if (current.origin === pubBase.origin && current.pathname.startsWith(pubBase.pathname)) return url;
      return resolveDocumentUrl(cfg, url, false, current.href);
    } catch {
      return url;
    }
  };
  hist[HISTORY_GUARD] = true;
  hist.pushState = (data: unknown, unused: string, url?: string | URL | null) => origPush(data, unused, rewrite(url));
  hist.replaceState = (data: unknown, unused: string, url?: string | URL | null) => origReplace(data, unused, rewrite(url));
  return () => {
    if (!hist[HISTORY_GUARD]) return;
    delete hist[HISTORY_GUARD];
    hist.pushState = origPush;
    hist.replaceState = origReplace;
  };
}
