// URL shapes (PROTOCOL section 2).
import type { Env } from "./env";
import { PAGE_KEY_RE, TENDRIL_ID_RE } from "./ids";

export function publicBase(env: Env): string {
  return env.PUBLIC_BASE.replace(/\/+$/, "");
}

function pageHostSuffix(env: Env): string | null {
  const suffix = env.PAGE_HOST_SUFFIX ?? "";
  // Keep previews under the existing one-level wildcard certificate. Do not let
  // a malformed setting introduce another DNS label or silently use staging.
  return suffix === "" || /^--p-[a-f0-9]{12}$/.test(suffix) ? suffix : null;
}

export function isBranchPreview(env: Env): boolean {
  const suffix = pageHostSuffix(env);
  return suffix !== null && suffix !== "";
}

/** Absolute page URL `P` for a page key. */
export function pageUrl(env: Env, id: string, key: string): string {
  const suffix = pageHostSuffix(env);
  if (suffix === null) throw new Error("Invalid PAGE_HOST_SUFFIX");
  return `https://${id}${suffix}.${env.PAGE_BASE_DOMAIN}/s/${key}/`;
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
}

/**
 * Recognises a page URL at <id><PAGE_HOST_SUFFIX>.<PAGE_BASE_DOMAIN>.
 * An isolated preview must not accept another preview's or staging's pages.
 */
export function parsePageRoute(url: URL, env: Env): PageRoute | null {
  const domain = (env.PAGE_BASE_DOMAIN || "").toLowerCase();
  const host = url.hostname.toLowerCase();
  const suffix = pageHostSuffix(env);
  if (suffix === null) return null;
  if (domain && host.endsWith("." + domain)) {
    const sub = host.slice(0, -(domain.length + 1));
    if (!sub.endsWith(suffix)) return null;
    const id = suffix ? sub.slice(0, -suffix.length) : sub;
    if (TENDRIL_ID_RE.test(id)) {
      const m = /^\/s\/([a-z2-7]{26})(\/.*)?$/.exec(url.pathname);
      if (m && PAGE_KEY_RE.test(m[1])) {
        return { id, key: m[1], base: `/s/${m[1]}/`, rest: m[2] === undefined ? null : decodeRest(m[2].slice(1)) };
      }
      return null;
    }
  }
  return null;
}

function decodeRest(s: string): string {
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
