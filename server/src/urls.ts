// URL shapes (PROTOCOL section 2).
import type { Env } from "./env";
import { PAGE_KEY_RE, TENDRIL_ID_RE } from "./ids";

export function publicBase(env: Env): string {
  return (env.PUBLIC_BASE || "http://localhost:8787").replace(/\/+$/, "");
}

/** Absolute page URL `P` for a page key, in the deployment's configured mode. */
export function pageUrl(env: Env, id: string, key: string): string {
  if (env.PAGE_HOST_MODE === "subdomain" && env.PAGE_BASE_DOMAIN) {
    return `https://${id}.${env.PAGE_BASE_DOMAIN}/s/${key}/`;
  }
  return `${publicBase(env)}/t/${id}/s/${key}/`;
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
 * Recognises both page URL shapes:
 *   path mode:      /t/<id>/s/<key>/<rest>
 *   subdomain mode: <id>.<PAGE_BASE_DOMAIN> + /s/<key>/<rest>
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
  const m = /^\/t\/([a-z2-7]{12})\/s\/([a-z2-7]{26})(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  return { id: m[1], key: m[2], base: `/t/${m[1]}/s/${m[2]}/`, rest: m[3] === undefined ? null : decodeRest(m[3].slice(1)) };
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
