import { createMembersClient } from "../../contract/members.mjs";
import { createPeersClient } from "../../contract/peers.mjs";
import type { HostServices } from "../../contract/index.mjs";
import type { TendrilConfig } from "./types";

/** Explicit page-host operations. Constructing this object performs no I/O. */
export function createPageHost(cfg: TendrilConfig, deviceHeaders: () => Record<string, string>): HostServices {
  const request: HostServices["request"] = async (path, options = {}) => {
    let decoded: string;
    try { decoded = decodeURIComponent(path.split("?", 1)[0]); } catch { throw new TypeError("Invalid service path"); }
    if (!decoded || path.includes("#") || /[?#\\]/.test(decoded) || decoded.startsWith("/") ||
        decoded.split("/").some(part => !part || part === "." || part === "..") || /^[a-z]+:/i.test(decoded))
      throw new TypeError("Service requests require a relative path");
    const response = await fetch(cfg.base + "_tendril/" + path, {
      method: options.method || "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
      headers: { ...deviceHeaders(), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error?.message || `Service operation failed (${response.status})`), {
      code: result.error?.code || "service_error", status: response.status,
    });
    return result;
  };
  return Object.freeze({
    request, deviceHeaders,
    members: createMembersClient({ base: cfg.base + "_tendril", headers: deviceHeaders }),
    peers: createPeersClient({ base: new URL(cfg.base + "_tendril", location.href).href, request, initialBootstrap: cfg.peerBootstrap }),
    blobUrl(id: string) {
      if (!/^b_[a-z2-7]{20}$/.test(id)) throw new TypeError("Invalid blob identifier");
      return new URL(`_tendril/blobs/${id}`, new URL(cfg.base, location.href)).href;
    },
  });
}
