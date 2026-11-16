/** Exact-byte retained log protocol. Portable to browsers, Workers and native JS. */
export const RECORD_LOG_FORMAT = "tendriller.record-log.v1";
export const RECORD_LOG_LIMITS = Object.freeze({
  recordBytes: 256 * 1024, readEntries: 128, readBytes: 1024 * 1024,
  totalBytes: 64 * 1024 * 1024, records: 100_000,
});
export class RecordLogError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = "RecordLogError"; this.code = code; this.status = status;
  }
}
const invalid = message => { throw new RecordLogError("bad_request", message); };
export function recordHistoryId(value) {
  if (typeof value !== "string" || !/^h_[0-9a-f]{32}$/.test(value)) invalid("Invalid record history identity");
  return value;
}
export function recordPosition(value, name = "position") {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a nonnegative safe integer`);
  return value;
}
function digest(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid("Invalid SHA-256 digest");
  return value;
}
export function recordBytes(value) {
  if (!(value instanceof Uint8Array)) invalid("Records must be Uint8Array bytes");
  if (!value.byteLength || value.byteLength > RECORD_LOG_LIMITS.recordBytes)
    throw new RecordLogError("record_too_large", `Records must contain 1 to ${RECORD_LOG_LIMITS.recordBytes} bytes`, 413);
  return value.slice();
}
export function encodeRecord(value) {
  const bytes = recordBytes(value);
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export function decodeRecord(value) {
  if (typeof value !== "string" || value.length > Math.ceil(RECORD_LOG_LIMITS.recordBytes / 3) * 4)
    throw new RecordLogError("record_too_large", "Encoded record exceeds the byte limit", 413);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid("Record must use canonical padded base64");
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (encodeRecord(bytes) !== value) invalid("Record must use canonical padded base64");
  return bytes;
}
export async function recordId(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", recordBytes(bytes));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
async function hashFields(fields) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields)));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
/** Hash UTF-8 JSON of the shown array, with no whitespace or trailing newline. */
export function recordGenesisRoot(historyId) {
  return hashFields([RECORD_LOG_FORMAT, "genesis", recordHistoryId(historyId)]);
}
export function recordEntryRoot(historyId, position, previousRoot, id) {
  if (recordPosition(position) === 0) invalid("Entry positions start at one");
  return hashFields([RECORD_LOG_FORMAT, "entry", recordHistoryId(historyId), position, digest(previousRoot), digest(id)]);
}
export function validateRecordHead(value, historyId) {
  if (!value || typeof value !== "object") invalid("Invalid record head");
  recordHistoryId(value.historyId); recordPosition(value.position); recordPosition(value.bytes, "bytes"); digest(value.root);
  if (historyId !== undefined && value.historyId !== recordHistoryId(historyId))
    throw new RecordLogError("history_mismatch", "The log belongs to another history", 409);
  return value;
}
/** Verify exact content and the entry's hash, optionally against a trusted previous head. */
export async function verifyRecordEntry(value, previous) {
  if (!value || typeof value !== "object") invalid("Invalid record entry");
  recordHistoryId(value.historyId); recordPosition(value.position); digest(value.recordId); digest(value.previousRoot); digest(value.root);
  const bytes = decodeRecord(value.record);
  if (previous) {
    validateRecordHead(previous, value.historyId);
    if (value.position !== previous.position + 1 || value.previousRoot !== previous.root)
      throw new RecordLogError("history_gap", "Entry does not extend the previous head", 409);
  }
  if (await recordId(bytes) !== value.recordId || await recordEntryRoot(value.historyId, value.position, value.previousRoot, value.recordId) !== value.root)
    throw new RecordLogError("integrity_error", "Entry bytes or hash chain do not match", 409);
  return bytes;
}
