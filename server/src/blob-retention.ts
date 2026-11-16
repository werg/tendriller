import type { Tendril } from "./tendril";
import { ACTIVITY_RETENTION } from "./limits";
import { HttpError } from "./http";

export interface BlobRow {
  id: string; sha256: string; type: string | null; size: number; name: string | null; ts: number;
  device: string | null; source: "page" | "agent"; pinned: number;
}

/** Explicit references keep immutable content alive; application JSON is not a retention root. */
export function blobInfo(t: Tendril, id: string) {
  const row = t.db.one<BlobRow>("SELECT id,sha256,type,size,name,ts,device,source,pinned FROM blobs WHERE id=?", id);
  if (!row) throw new HttpError(404, "not_found", "No such blob");
  const reasons: string[] = [];
  if (row.pinned) reasons.push("pinned");
  if (row.id === t.db.get<string | null>("icon", null)) reasons.push("icon");
  if (t.db.one("SELECT 1 AS present FROM file_refs WHERE blob_id=? LIMIT 1", id)) reasons.push("shared_file");
  if (t.db.one("SELECT 1 AS present FROM file_ref_changes WHERE blob_id=? LIMIT 1", id)) reasons.push("file_history");
  if (t.db.one("SELECT 1 AS present FROM publication_blobs WHERE blob_id=? LIMIT 1", id)) reasons.push("publication");
  if (row.source === "agent") reasons.push("agent_asset");
  if (!reasons.length) reasons.push("page_default");
  return { ...row, pinned: !!row.pinned,
    retention: { expires_at: reasons.length === 1 && reasons[0] === "page_default" ? row.ts + ACTIVITY_RETENTION : null, reasons } };
}

/** One metadata shape is used by upload receipts, captures, named files and downloads. */
export function blobReference(t: Tendril, id: string) {
  const info = blobInfo(t, id);
  return { id: info.id, sha256: info.sha256, size: info.size, type: info.type || "application/octet-stream",
    ...(info.name === null ? {} : { name: info.name }), url: `_tendril/blobs/${id}`, created_at: info.ts, retention: info.retention };
}
