// URL shapes (PROTOCOL section 2).
import type { Env } from "./env";
import { PAGE_KEY_RE, TENDRIL_ID_RE } from "./ids";
import { isLoopbackOrigin } from "./accounts/local-auth";

export function publicBase(env: Env): string {
  return env.PUBLIC_BASE.replace(/\/+$/, "");
}

export function pageHostSuffix(env: Env): string | null {
  const suffix = env.PAGE_HOST_SUFFIX ?? "";
  // Keep previews under the existing one-level wildcard certificate. Do not let
  // a malformed setting introduce another DNS label or silently use staging.
  return suffix === "" || /^--p-[a-f0-9]{12}$/.test(suffix) ? suffix : null;
}

export function isBranchPreview(env: Env): boolean {
  const suffix = pageHostSuffix(env);
  return suffix !== null && suffix !== "";
}

/** Hostname (without port) for a page label (either a tendril ID or a custom subdomain). */
export function pageHostForLabel(env: Env, label: string): string {
  const suffix = pageHostSuffix(env);
  if (suffix === null) throw new Error("Invalid PAGE_HOST_SUFFIX");
  return `${label}${suffix}.${env.PAGE_BASE_DOMAIN}`.toLowerCase();
}

/** Origin (scheme + host + optional loopback port) for a page label (ID or custom subdomain). */
export function pageOriginForLabel(env: Env, label: string): string {
  const host = pageHostForLabel(env, label);
  const base = publicBase(env);
  if (base.startsWith("http://") && isLoopbackOrigin(base)) {
    const port = new URL(base).port;
    return `http://${host}${port ? `:${port}` : ""}`;
  }
  return `https://${host}`;
}

/** Origin for a verified page host (either a standard/named subdomain or custom domain). */
export function pageOriginForHost(env: Env, host: string): string {
  const cleanHost = host.toLowerCase();
  const base = publicBase(env);
  const pageBase = (env.PAGE_BASE_DOMAIN || "").toLowerCase();
  if (base.startsWith("http://") && isLoopbackOrigin(base) && pageBase && cleanHost.endsWith("." + pageBase)) {
    const port = new URL(base).port;
    return `http://${cleanHost}${port ? `:${port}` : ""}`;
  }
  return `https://${cleanHost}`;
}

/** Absolute page URL `P` for a page key (using named subdomain when supplied). */
export function pageUrl(env: Env, id: string, key: string, subdomain?: string | null): string {
  return `${pageOriginForLabel(env, subdomain || id)}/s/${key}/`;
}

/** Bare root URL (`https://<subdomain-or-id>.<PAGE_BASE_DOMAIN>/`) for public pages and signed-in owners. */
export function barePageUrl(env: Env, id: string, subdomain?: string | null): string {
  return `${pageOriginForLabel(env, subdomain || id)}/`;
}

/** The agent API base for one granted page. */
export function agentPageApi(env: Env, id: string): string {
  return `${publicBase(env)}/api/agent/pages/${id}`;
}

export interface PageRoute {
  id: string;
  key: string;
  /** Path of P (no origin), always ends with "/". */
  base: string;
  /** Remainder after P, without a leading slash; "" for P itself. null if the request was P without its trailing slash. */
  rest: string | null;
  /** True when accessed at bare domain root `/` (no `/s/<key>/` capability segment). */
  bare?: boolean;
}

/**
 * Extract the single-level subdomain label (with `PAGE_HOST_SUFFIX` stripped) from a hostname
 * under `PAGE_BASE_DOMAIN`. Fails closed on nested labels or foreign preview suffixes.
 */
export function parsePageHostLabel(url: URL, env: Env): string | null {
  const domain = (env.PAGE_BASE_DOMAIN || "").toLowerCase();
  const host = url.hostname.toLowerCase();
  const suffix = pageHostSuffix(env);
  if (suffix === null) return null;
  if (!domain || !host.endsWith("." + domain)) return null;
  const sub = host.slice(0, -(domain.length + 1));
  if (!sub || sub.includes(".")) return null;
  if (!sub.endsWith(suffix)) return null;
  const label = suffix ? sub.slice(0, -suffix.length) : sub;
  return label || null;
}

/** Parse a keyed `/s/<key>(/...)?` path into a PageRoute for a resolved tendril ID. */
export function parseKeyedPagePath(url: URL, id: string): PageRoute | null {
  const m = /^\/s\/([a-z2-7]{26})(\/.*)?$/.exec(url.pathname);
  if (!m || !PAGE_KEY_RE.test(m[1]!)) return null;
  return { id, key: m[1]!, base: `/s/${m[1]!}/`, rest: m[2] === undefined ? null : decodeRest(m[2].slice(1)), bare: false };
}

/** Parse a bare root path (`/...`) into a bare PageRoute for a resolved tendril ID. */
export function parseBarePagePath(url: URL, id: string): PageRoute {
  const rest = url.pathname.startsWith("/") ? decodeRest(url.pathname.slice(1)) : decodeRest(url.pathname);
  return { id, key: "", base: "/", rest, bare: true };
}

/**
 * Recognises a standard page URL at <id><PAGE_HOST_SUFFIX>.<PAGE_BASE_DOMAIN>/s/<key>/.
 * An isolated preview must not accept another preview's or staging's pages.
 */
export function parsePageRoute(url: URL, env: Env): PageRoute | null {
  const label = parsePageHostLabel(url, env);
  if (!label || !TENDRIL_ID_RE.test(label)) return null;
  const route = parseKeyedPagePath(url, label);
  if (!route) return null;
  return { id: route.id, key: route.key, base: route.base, rest: route.rest };
}

export function decodeRest(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalises and validates an agent-supplied file path. Returns null if invalid. */
export function normalizeFilePath(raw: string): string | null {
  let p = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.length > 512 || p.endsWith("/")) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || /[\x00-\x1f]/.test(s))) return null;
  if (parts[0] === "_tendril" || parts[0] === "_publications") return null;
  return parts.join("/");
}
