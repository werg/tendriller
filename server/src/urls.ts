// URL shapes (PROTOCOL section 2).
import type { Env } from "./env";
import { PAGE_KEY_RE, TENDRIL_ID_RE } from "./ids";

export function publicBase(env: Env): string {
  return env.PUBLIC_BASE.replace(/\/+$/, "");
}

/** Absolute page URL `P` for a page key. */
export function pageUrl(env: Env, id: string, key: string): string {
  return `https://${id}.${env.PAGE_BASE_DOMAIN}/s/${key}/`;
}

export function apiUrl(env: Env, id: string): string {
  return `${publicBase(env)}/api/t/${id}`;
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
 * Recognises a page URL at <id>.<PAGE_BASE_DOMAIN>.
 */
export function parsePageRoute(url: URL, env: Env): PageRoute | null {
  const domain = (env.PAGE_BASE_DOMAIN || "").toLowerCase();
  const host = url.hostname.toLowerCase();
  if (domain && host.endsWith("." + domain)) {
    const sub = host.slice(0, -(domain.length + 1));
    if (TENDRIL_ID_RE.test(sub)) {
      const m = /^\/s\/([a-z2-7]{26})(\/.*)?$/.exec(url.pathname);
      if (m && PAGE_KEY_RE.test(m[1])) {
        return { id: sub, key: m[1], base: `/s/${m[1]}/`, rest: m[2] === undefined ? null : decodeRest(m[2].slice(1)) };
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
  if (parts[0] === "_tendril") return null;
  return parts.join("/");
}
