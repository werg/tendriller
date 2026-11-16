// Opaque retained bytes. Application signatures, membership and finality live upstream.
import { RECORD_LOG_FORMAT, RECORD_LOG_LIMITS, RecordLogError, decodeRecord, encodeRecord,
  recordBytes, recordEntryRoot, recordGenesisRoot, recordHistoryId, recordId, recordPosition } from "../../contract/records.mjs";
import type { RecordLogEntry, RecordLogHead, RecordLogInfo, RecordLogPage } from "../../contract/records.mjs";
import type { Tendril } from "./tendril";
import { allows, authorizeSocket, pageAccessAllowed, type Principal } from "./access";
import { HttpError, isPlainObject, json, readJson } from "./http";

type Store = Pick<Tendril, "db" | "transaction">;
interface HeadRow { history_id: string; position: number; root: string; bytes: number }
interface EntryRow { position: number; record_id: string; previous_root: string; root: string; record: string; bytes: number }
export const RECORD_LOG_ROUTE = /^records(?:\/entries)?$/;
const head = (row: HeadRow): RecordLogHead => ({ historyId: row.history_id, position: row.position, root: row.root, bytes: row.bytes });
const entry = (historyId: string, row: EntryRow): RecordLogEntry => ({ historyId, position: row.position,
  recordId: row.record_id, previousRoot: row.previous_root, root: row.root, record: row.record });
function requireResident(t: Store): void {
  if (!t.db.get("owner_account", null) || t.db.get<string>("lifetime", "ad_hoc") !== "resident")
    throw new HttpError(409, "resident_required", "A retained record log requires an owned resident Tendril");
}
function row(t: Store, historyId?: string): HeadRow {
  const current = t.db.one<HeadRow>("SELECT history_id,position,root,bytes FROM record_log WHERE id=1");
  if (!current) throw new HttpError(404, "record_log_missing", "Provision this Tendril's retained record log first");
  if (historyId !== undefined && current.history_id !== recordHistoryId(historyId))
    throw new HttpError(409, "history_mismatch", "The Tendril contains a different record history");
  return current;
}
export function getRecordLog(t: Store, historyId?: string): RecordLogInfo {
  const current = row(t, historyId);
  return { descriptor: { historyId: current.history_id, format: RECORD_LOG_FORMAT, limits: { ...RECORD_LOG_LIMITS } }, head: head(current) };
}
/** Idempotent provisioning chooses identity on the server, independent of page versions. */
export async function provisionRecordLog(t: Store): Promise<RecordLogInfo> {
  requireResident(t);
  if (t.db.one("SELECT id FROM record_log WHERE id=1")) return getRecordLog(t);
  const historyId = "h_" + crypto.randomUUID().replaceAll("-", "");
  const root = await recordGenesisRoot(historyId);
  return t.transaction(() => {
    requireResident(t);
    if (!t.db.one("SELECT id FROM record_log WHERE id=1"))
      t.db.run("INSERT INTO record_log(id,history_id,position,root,bytes) VALUES(1,?,0,?,0)", historyId, root);
    return getRecordLog(t);
  });
}
/** Hash asynchronously, then compare the captured head within one synchronous commit. */
export async function appendRecord(t: Store, historyId: string, value: Uint8Array): Promise<{ entry: RecordLogEntry; fresh: boolean }> {
  recordHistoryId(historyId);
  const bytes = recordBytes(value), encoded = encodeRecord(bytes), id = await recordId(bytes);
  for (let attempt = 0; attempt < 64; attempt++) {
    requireResident(t);
    const before = row(t, historyId);
    const previous = t.db.one<EntryRow>("SELECT * FROM record_log_entries WHERE record_id=?", id);
    if (previous) {
      if (previous.record !== encoded) throw new HttpError(409, "record_id_conflict", "Content digest already names different bytes");
      return { entry: entry(historyId, previous), fresh: false };
    }
    const position = before.position + 1;
    if (position > RECORD_LOG_LIMITS.records || before.bytes + bytes.length > RECORD_LOG_LIMITS.totalBytes)
      throw new HttpError(413, "record_log_full", "Retained record log quota exhausted; no entries were removed", { limits: RECORD_LOG_LIMITS });
    const root = await recordEntryRoot(historyId, position, before.root, id);
    const committed = t.transaction(() => {
      requireResident(t);
      const current = row(t, historyId);
      // Another append may have committed while WebCrypto was running.
      if (current.position !== before.position || current.root !== before.root) return null;
      t.db.run("INSERT INTO record_log_entries(position,record_id,previous_root,root,record,bytes) VALUES(?,?,?,?,?,?)",
        position, id, before.root, root, encoded, bytes.length);
      t.db.run("UPDATE record_log SET position=?,root=?,bytes=? WHERE id=1", position, root, before.bytes + bytes.length);
      return { entry: { historyId, position, recordId: id, previousRoot: before.root, root, record: encoded }, fresh: true };
    });
    if (committed) return committed;
  }
  throw new HttpError(503, "record_log_busy", "Concurrent appends prevented progress; retry the same bytes");
}
/** A missing retained range is corruption, never an invitation to skip forward. */
export function readRecordLog(t: Store, historyId: string, after: number, limit = RECORD_LOG_LIMITS.readEntries): RecordLogPage {
  recordPosition(after, "after");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_LOG_LIMITS.readEntries)
    throw new HttpError(400, "bad_request", `limit must be an integer from 1 to ${RECORD_LOG_LIMITS.readEntries}`);
  const current = row(t, historyId);
  if (after > current.position) throw new HttpError(409, "cursor_ahead", "Cursor is beyond this history; verify the history identity and restore lineage");
  const rows = t.db.all<EntryRow>("SELECT * FROM record_log_entries WHERE position>? ORDER BY position LIMIT ?", after, limit);
  const entries: RecordLogEntry[] = [];
  let used = 0, cursor = after, limited = false;
  for (const stored of rows) {
    if (stored.position !== cursor + 1) throw new HttpError(409, "history_gap", "A required retained record is missing");
    const next = entry(historyId, stored), size = new TextEncoder().encode(JSON.stringify(next)).length;
    if (entries.length && used + size > RECORD_LOG_LIMITS.readBytes) { limited = true; break; }
    entries.push(next); used += size; cursor = stored.position;
  }
  if (!limited && cursor < Math.min(current.position, after + limit))
    throw new HttpError(409, "history_gap", "A required retained record is missing");
  return { historyId: current.history_id, after, cursor, entries, head: head(current) };
}
async function notifyRecordHead(t: Tendril, value: RecordLogHead): Promise<void> {
  if (!await pageAccessAllowed(t)) return;
  for (const { ws } of t.connectedSockets()) {
    const principal = await authorizeSocket(t, ws, { fresh: true });
    if (principal && allows(principal, "page.owner")) t.send(ws, { t: "record_log_head", head: value });
  }
  for (const ws of t.agentSockets()) t.send(ws, { t: "record_log_head", head: value });
}
export async function handleRecordLog(t: Tendril, req: Request, url: URL, path: string, principal: Principal): Promise<Response> {
  if (!allows(principal, "agent.manage") && !allows(principal, "page.owner"))
    throw new HttpError(403, "forbidden", "Only the owner and authorized agents can access retained records");
  try {
    if (path === "records") {
      if (req.method === "GET" || req.method === "HEAD") return json(getRecordLog(t, url.searchParams.get("historyId") ?? undefined));
      if (req.method === "POST") {
        const body = await readJson(req, 1024);
        if (!isPlainObject(body) || Object.keys(body).length) throw new HttpError(400, "bad_request", "Provisioning takes an empty object");
        return json(await provisionRecordLog(t));
      }
    }
    if (path === "records/entries") {
      if (req.method === "POST") {
        const body = await readJson(req, Math.ceil(RECORD_LOG_LIMITS.recordBytes / 3) * 4 + 1024);
        if (!isPlainObject(body) || Object.keys(body).sort().join(",") !== "historyId,record")
          throw new HttpError(400, "bad_request", "Append requires only historyId and record");
        const accepted = await appendRecord(t, body.historyId, decodeRecord(body.record));
        if (accepted.fresh) {
          const current = getRecordLog(t).head;
          t.afterCommit(() => notifyRecordHead(t, current));
        }
        return json(accepted.entry);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const historyId = recordHistoryId(url.searchParams.get("historyId"));
        const rawAfter = url.searchParams.get("after"), rawLimit = url.searchParams.get("limit");
        if (rawAfter === null || !/^(?:0|[1-9]\d*)$/.test(rawAfter) || rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit))
          throw new HttpError(400, "bad_request", "Read requires an explicit integer after and optional positive limit");
        return json(readRecordLog(t, historyId, Number(rawAfter), rawLimit === null ? undefined : Number(rawLimit)));
      }
    }
    throw new HttpError(405, "method_not_allowed");
  } catch (error) {
    if (error instanceof RecordLogError) throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
}
