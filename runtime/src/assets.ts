import type { TendrilConfig } from "./types";

// Uncomposed fixtures resolve siblings beside the actual executing runtime. A
// published page always supplies the immutable runtime base in its manifest.
const script = typeof document !== "undefined" ? document.currentScript as HTMLScriptElement | null : null;
const entry = script?.src;
export function runtimeBase(config: TendrilConfig): string {
  const page = new URL(config.base, location.href);
  return config.publication
    ? new URL(config.publication.runtime.base, page).href
    : new URL(".", entry || page).href;
}
export function runtimeAsset(config: TendrilConfig, path: string): string {
  return new URL(path, runtimeBase(config)).href;
}
