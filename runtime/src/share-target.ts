// Local-only Web Share Target inbox reader (reads & deletes entries staged by the page service worker).
import type { RuntimeShareTarget, SharedPayload } from "../../contract/index.mjs";

export const SHARE_INBOX_PREFIX = "tendril-share-inbox:";

export function shareInboxCacheName(scope: string): string {
  return SHARE_INBOX_PREFIX + encodeURIComponent(scope);
}

function shareEntryUrl(scope: string, id: string, index?: number): string {
  const base = `${scope}_tendril/share-inbox/${encodeURIComponent(id)}`;
  return index === undefined ? `${base}/meta.json` : `${base}/file-${index}`;
}

export function createShareTarget(scope: string): RuntimeShareTarget {
  const listeners = new Set<(payload: SharedPayload) => void>();
  let consumed = false;
  let pending: Promise<SharedPayload | null> | null = null;
  let delivered: SharedPayload | null = null;

  const consume = async (): Promise<SharedPayload | null> => {
    if (consumed) return null;
    if (pending) return pending;
    pending = (async () => {
      try {
        const url = new URL(location.href);
        const id = url.searchParams.get("_shared");
        if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
        // Strip the transient query param from the address bar immediately.
        url.searchParams.delete("_shared");
        try { history.replaceState(history.state, "", url.href); } catch { /* ignore */ }
        if (typeof caches === "undefined") return null;
        const cache = await caches.open(shareInboxCacheName(scope));
        const metaKey = shareEntryUrl(scope, id);
        const metaRes = await cache.match(metaKey);
        if (!metaRes) return null;
        const meta = await metaRes.json() as {
          title?: string;
          text?: string;
          url?: string;
          expiresAt?: number;
          files?: Array<{ name: string; type: string; index: number }>;
        };
        await cache.delete(metaKey);
        const files: File[] = [];
        const fileList = Array.isArray(meta.files) ? meta.files : [];
        for (const f of fileList) {
          const fKey = shareEntryUrl(scope, id, f.index);
          const fRes = await cache.match(fKey);
          await cache.delete(fKey);
          if (!fRes) continue;
          const blob = await fRes.blob();
          files.push(new File([blob], f.name || "shared-file", { type: f.type || blob.type || "application/octet-stream" }));
        }
        if (typeof meta.expiresAt === "number" && meta.expiresAt < Date.now()) return null;
        const payload: SharedPayload = {
          ...(meta.title ? { title: String(meta.title) } : {}),
          ...(meta.text ? { text: String(meta.text) } : {}),
          ...(meta.url ? { url: String(meta.url) } : {}),
          files,
        };
        if (!payload.title && !payload.text && !payload.url && payload.files.length === 0) return null;
        consumed = true;
        delivered = payload;
        return payload;
      } catch {
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const onShare = (listener: (payload: SharedPayload) => void) => {
    listeners.add(listener);
    if (delivered) {
      const payload = delivered;
      delivered = null;
      queueMicrotask(() => { if (listeners.has(listener)) listener(payload); });
    } else if (!consumed && typeof location !== "undefined" && location.search.includes("_shared=")) {
      void consume().then(payload => {
        if (!payload) return;
        delivered = null;
        for (const fn of [...listeners]) fn(payload);
      });
    }
    return () => { listeners.delete(listener); };
  };

  return Object.freeze({ consume, onShare });
}
