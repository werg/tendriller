import {
  evaluateBroadcastMatch,
  validateBroadcastKey,
  verifyBroadcastSignature,
  type BroadcastPublicJwk,
  type SignedBroadcast,
} from "../../contract/broadcasts.mjs";
import type { RuntimeBroadcastEntry, RuntimeBroadcasts } from "../../contract/index.mjs";
import type { TendrilConfig } from "./types";

const VISIBILITY_THROTTLE_MS = 5 * 60 * 1000;

interface PageBroadcastResponse {
  issuer: string;
  keys: BroadcastPublicJwk[];
  latest_seq: number;
  page?: {
    role?: "owner" | "guest" | "display";
    version?: number;
    runtime_id?: string | null;
    runtime_version?: string | null;
    published_at?: number | null;
    agent_count?: number | null;
  };
  broadcasts: SignedBroadcast[];
}

export function createBroadcastsStore(cfg: TendrilConfig, options: { autoFetch?: boolean } = {}) {
  const listeners = new Set<(entries: RuntimeBroadcastEntry[]) => void>();
  const storageKey = `tendril:broadcasts-dismissed:${cfg.base}`;
  let entries: RuntimeBroadcastEntry[] = [];
  let etag: string | null = null;
  let lastCheckedAt = options.autoFetch ? Date.now() : 0;
  let inflight: Promise<RuntimeBroadcastEntry[]> | null = null;
  let disposed = false;

  const readDismissed = (): Set<string> => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
    } catch {
      return new Set();
    }
  };
  let dismissed = readDismissed();

  const saveDismissed = () => {
    try { localStorage.setItem(storageKey, JSON.stringify([...dismissed].slice(-100))); } catch { /* storage blocked */ }
  };

  const emit = () => {
    const snap = entries.slice();
    for (const listener of listeners) {
      try { listener(snap); } catch { /* listener failure cannot break broadcast delivery */ }
    }
  };

  const refresh = async (): Promise<RuntimeBroadcastEntry[]> => {
    if (disposed || typeof fetch !== "function" || !cfg.base) return entries.slice();
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const headers: Record<string, string> = {};
        if (etag) headers["If-None-Match"] = etag;
        const response = await fetch(`${cfg.base}_tendril/broadcasts`, {
          credentials: "same-origin",
          cache: "no-cache",
          headers,
        });
        lastCheckedAt = Date.now();
        if (response.status === 304) return entries.slice();
        if (!response.ok) return entries.slice();
        etag = response.headers.get("ETag") ?? etag;
        const data = await response.json() as PageBroadcastResponse;
        if (!data || typeof data !== "object" || !Array.isArray(data.broadcasts)) return entries.slice();
        // Prefer host-injected Ed25519 keys when available; fall back to keys supplied with the response.
        const trustedKeys = (cfg.broadcastKeys?.length ? cfg.broadcastKeys : data.keys ?? []).filter(validateBroadcastKey);
        const role = data.page?.role ?? "guest";
        const audiences = role === "owner" ? (["page_owners", "page_all"] as const) : (["page_all"] as const);
        const runtimeId = data.page?.runtime_id ?? cfg.publication?.runtime.id ?? null;
        const runtimeVersion = data.page?.runtime_version ?? cfg.publication?.runtime.version ?? null;
        const publishedAt = typeof data.page?.published_at === "number" ? data.page.published_at : null;
        const activeAgents = typeof data.page?.agent_count === "number" ? data.page.agent_count : null;
        const next: RuntimeBroadcastEntry[] = [];
        for (const item of data.broadcasts) {
          const check = await verifyBroadcastSignature(item, trustedKeys, { issuer: data.issuer });
          if (!check.valid) continue;
          const match = evaluateBroadcastMatch(item.payload, {
            audiences,
            runtimeId,
            runtimeVersion,
            publishedAt,
            activeAgents,
          });
          if (!match.matched) continue;
          const isDismissed = item.payload.dismissible && dismissed.has(item.payload.id);
          next.push(Object.freeze({
            id: item.payload.id,
            seq: item.payload.seq,
            kind: item.payload.kind,
            severity: item.payload.severity,
            title: item.payload.title,
            summary: item.payload.summary,
            body: item.payload.body,
            docs_url: item.payload.docs_url,
            action: item.payload.action,
            dismissible: item.payload.dismissible,
            created_at: item.payload.created_at,
            expires_at: item.payload.expires_at,
            dismissed: isDismissed,
            verified: true,
            matchReasons: Object.freeze(match.reasons),
          }));
        }
        if (!disposed) {
          entries = next;
          emit();
        }
        return entries.slice();
      } catch {
        return entries.slice();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const onVisibility = () => {
    if (disposed || typeof document === "undefined" || document.hidden) return;
    if (Date.now() - lastCheckedAt >= VISIBILITY_THROTTLE_MS) void refresh();
  };

  if (options.autoFetch && typeof window !== "undefined" && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    // Avoid any eager host fetch on normal page loads when no system broadcasts are active.
    if (cfg.broadcastLatestSeq && cfg.broadcastLatestSeq > 0) void refresh();
  }

  const api: RuntimeBroadcasts = Object.freeze({
    list: () => entries.slice(),
    active: () => entries.filter(entry => !entry.dismissed),
    refresh,
    dismiss(id: string) {
      const target = entries.find(entry => entry.id === id);
      if (!target || !target.dismissible || target.dismissed) return;
      dismissed.add(id);
      saveDismissed();
      entries = entries.map(entry => entry.id === id ? Object.freeze({ ...entry, dismissed: true }) : entry);
      emit();
    },
    onChange(listener: (list: RuntimeBroadcastEntry[]) => void) {
      listeners.add(listener);
      if (entries.length) {
        try { listener(entries.slice()); } catch { /* ignore */ }
      }
      return () => { listeners.delete(listener); };
    },
  });

  return {
    api,
    dispose() {
      disposed = true;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      listeners.clear();
    },
  };
}
