import type { Tendril } from "./tendril";
import { ACTIVITY_RETENTION } from "./limits";
import { HttpError, isPlainObject } from "./http";
import { addActivity } from "./activity";

export interface BlobRow {
  id: string; type: string | null; size: number; name: string | null; ts: number;
  device: string | null; source: "page" | "agent"; pinned: number;
}

/** Residency keeps the application; capture retention is an explicit, separate choice. */
export function blobInfo(t: Tendril, id: string) {
  const row = t.db.one<BlobRow>("SELECT id,type,size,name,ts,device,source,pinned FROM blobs WHERE id = ?", id);
  if (!row) throw new HttpError(404, "not_found", "No such capture");
  const reason = row.pinned ? "pinned" : row.id === t.db.get<string | null>("icon", null) ? "icon"
    : row.source === "agent" ? "agent_asset" : "page_default";
  return { ...row, pinned: !!row.pinned, url: `_tendril/blob/${row.id}`,
    retention: { keep: !!row.pinned, expires_at: reason === "page_default" ? row.ts + ACTIVITY_RETENTION : null, reason } };
}

export function blobReference(t: Tendril, id: string) {
  const { url, retention } = blobInfo(t, id);
  return { id, url, retention };
}

export function setBlobRetention(t: Tendril, id: string, input: unknown, by: string | null, device: string | null = null) {
  if (!isPlainObject(input) || typeof input.keep !== "boolean" || Object.keys(input).some((key) => key !== "keep"))
    throw new HttpError(400, "bad_request", "Retention must be {keep: true} or {keep: false}");
  const before = blobInfo(t, id);
  if (before.pinned !== input.keep) {
    t.db.run("UPDATE blobs SET pinned = ? WHERE id = ?", input.keep ? 1 : 0, id);
    // A retention audit entry is not the capture itself: deleting the entry must
    // not invoke activity's media-delete behavior.
    addActivity(t, { kind: "retention", summary: `${before.name || id}: ${input.keep ? "kept until explicitly removed" : "returned to its default retention period"}`, by, device });
  }
  return blobReference(t, id);
}
