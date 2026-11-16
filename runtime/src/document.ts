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
