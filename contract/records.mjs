/** Exact-byte retained log protocol. Portable to browsers, Workers and native JS. */
export const RECORD_LOG_FORMAT = "record-log/v1";
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
export async function recordGenesisRoot(historyId) {
  return hashFields([RECORD_LOG_FORMAT, "genesis", recordHistoryId(historyId)]);
}
export async function recordEntryRoot(historyId, position, previousRoot, id) {
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
/** Snapshot a generic conditional-append predecessor before asynchronous work. */
export function recordAppendCondition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "position,root") invalid("Expected head requires only position and root");
  return { position: recordPosition(value.position), root: digest(value.root) };
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

/** A shared native/browser client. Callers own durable pending bytes and applied cursors. */
export function createRecordLogClient({ base, headers = () => ({}), fetch: fetcher = globalThis.fetch, subscribeHints }) {
  const prefix = base.replace(/\/+$/, "");
  async function request(path, options = {}) {
    const response = await fetcher(prefix + "/records" + path, {
      method: options.body === undefined ? "GET" : "POST", cache: "no-store", signal: options.signal,
      headers: { ...headers(), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let value;
    try { value = await response.json(); }
    catch { throw new RecordLogError("invalid_response", "Record log returned invalid JSON", response.status); }
    if (!response.ok) throw new RecordLogError(value?.error?.code || "http_error", value?.error?.message || `HTTP ${response.status}`, response.status);
    return value;
  }
  async function checkedInfo(value, expected) {
    validateRecordHead(value?.head, expected);
    if (value?.descriptor?.historyId !== value.head.historyId || value.descriptor.format !== RECORD_LOG_FORMAT
      || Object.keys(RECORD_LOG_LIMITS).some(key => value.descriptor.limits?.[key] !== RECORD_LOG_LIMITS[key]))
      throw new RecordLogError("invalid_response", "Record log descriptor does not match this protocol", 502);
    if (value.head.position === 0 && (value.head.bytes !== 0 || value.head.root !== await recordGenesisRoot(value.head.historyId)))
      throw new RecordLogError("integrity_error", "Empty history has an invalid root", 502);
    return value;
  }
  const client = {
    async provision({ signal } = {}) { return checkedInfo(await request("", { body: {}, signal })); },
    async info({ historyId, signal } = {}) {
      if (historyId !== undefined) recordHistoryId(historyId);
      return checkedInfo(await request(historyId === undefined ? "" : `?historyId=${historyId}`, { signal }), historyId);
    },
    async append(value, { historyId, signal, expectedHead }) {
      recordHistoryId(historyId);
      const condition = expectedHead === undefined ? undefined : recordAppendCondition(expectedHead);
      const bytes = recordBytes(value), record = encodeRecord(bytes);
      const result = await request("/entries", { body: { historyId, record, ...(condition === undefined ? {} : { expectedHead: condition }) }, signal });
      if (result?.historyId !== historyId || result.record !== record)
        throw new RecordLogError("invalid_response", "Append response does not identify the submitted bytes and history", 502);
      await verifyRecordEntry(result);
      return result;
    },
    async read({ historyId, after, limit = RECORD_LOG_LIMITS.readEntries, previous, signal }) {
      recordHistoryId(historyId); recordPosition(after, "after");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_LOG_LIMITS.readEntries) invalid("Invalid record read limit");
      if (previous) {
        validateRecordHead(previous, historyId);
        if (previous.position !== after) invalid("Previous head must identify the requested after position");
      }
      const page = await request(`/entries?historyId=${historyId}&after=${after}&limit=${limit}`, { signal });
      validateRecordHead(page?.head, historyId);
      if (page.historyId !== historyId || page.after !== after || !Array.isArray(page.entries) || page.entries.length > limit
        || page.head.position < after || page.cursor !== after + page.entries.length || page.cursor > page.head.position
        || !page.entries.length && page.cursor < page.head.position)
        throw new RecordLogError("invalid_response", "Read response is not the requested contiguous range", 502);
      let prior = previous || (after === 0 ? { historyId, position: 0, bytes: 0, root: await recordGenesisRoot(historyId) } : undefined);
      let wireBytes = 0;
      for (const [index, item] of page.entries.entries()) {
        if (item?.historyId !== historyId || item.position !== after + index + 1)
          throw new RecordLogError("history_gap", "Read response has an invalid history or position", 502);
        wireBytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
        if (wireBytes > RECORD_LOG_LIMITS.readBytes) throw new RecordLogError("invalid_response", "Read response exceeds the byte bound", 502);
        const bytes = await verifyRecordEntry(item, prior);
        prior = { historyId, position: item.position, root: item.root, bytes: (prior?.bytes || 0) + bytes.length };
      }
      if (prior && page.cursor === page.head.position && (prior.root !== page.head.root || (previous || after === 0) && prior.bytes !== page.head.bytes))
        throw new RecordLogError("integrity_error", "Read response does not reach its stated head", 502);
      return page;
    },
    watch({ historyId, after, signal, pollIntervalMs = subscribeHints ? 30_000 : 1000, onError }, listener) {
      recordHistoryId(historyId); recordPosition(after, "after");
      if (typeof listener !== "function" || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) invalid("Invalid record watch options");
      let active = true, observed = after, observedRoot, timer, running = false, again = false;
      const controller = new AbortController();
      const report = error => { if (active) { try { onError?.(error); } catch { /* Observer isolation. */ } } };
      const observe = value => {
        validateRecordHead(value, historyId);
        if (value.position < observed || value.position === observed && observedRoot !== undefined && observedRoot !== value.root)
          throw new RecordLogError("history_conflict", "Observed history moved backwards or changed a committed position", 409);
        if (value.position === observed) { observedRoot = value.root; return; }
        observed = value.position; observedRoot = value.root;
        try { listener(structuredClone(value)); } catch (error) { report(error); }
      };
      const check = async () => {
        if (!active) return;
        if (running) { again = true; return; }
        running = true;
        try {
          // A hint arriving during this read schedules a fresh observation afterward.
          const info = await client.info({ historyId, signal: controller.signal });
          if (active) observe(info.head);
        } catch (error) { report(error); }
        finally {
          running = false;
          if (active) {
            clearTimeout(timer);
            if (again) { again = false; void check(); }
            else timer = setTimeout(check, pollIntervalMs);
          }
        }
      };
      const stopHints = subscribeHints?.(() => { void check(); });
      const stop = () => {
        if (!active) return;
        active = false; clearTimeout(timer); controller.abort(); stopHints?.(); signal?.removeEventListener("abort", stop);
      };
      if (signal?.aborted) stop();
      else { signal?.addEventListener("abort", stop, { once: true }); void check(); }
      return stop;
    },
  };
  return client;
}
