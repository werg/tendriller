// A handled checkpoint is deliberately separate from the read cursor.
// Reading application input never acknowledges it; only explicit ack does.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validate } from "@tendriller/core/contract";
import { ApiError, client } from "../../cli/lib/api.mjs";

const base = cfg => String(cfg.api || "").replace(/\/+$/, "");
const cursor = value => Number.isSafeInteger(value) && value >= 0;
function error(code, message) { return Object.assign(new Error(message), { code, ...(code === "invalid_argument" ? { exit: 64 } : {}) }); }

export function readCheckpoint(file, cfg, initialCursor = 0) {
  if (!base(cfg) || !cursor(initialCursor)) throw error("invalid_checkpoint", "The page API and initial cursor must be valid");
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return { version: 1, api: base(cfg), handled_cursor: initialCursor, delivered_cursor: initialCursor };
    throw e;
  }
  let saved;
  try { saved = JSON.parse(text); } catch { throw error("invalid_checkpoint", "The event checkpoint is not valid JSON; it was not reset"); }
  if (saved?.version !== 1 || !cursor(saved.handled_cursor) || !cursor(saved.delivered_cursor) || saved.delivered_cursor < saved.handled_cursor)
    throw error("invalid_checkpoint", "The event checkpoint has invalid cursors; it was not reset");
  if (saved.api !== base(cfg)) throw error("checkpoint_mismatch", "The event checkpoint belongs to another page API; use a separate --checkpoint-file");
  return saved;
}

function writeCheckpoint(file, saved) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(saved) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

async function withCheckpoint(file, cfg, initialCursor, action) {
  file = resolve(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (e) {
    if (e.code === "EEXIST") throw error("checkpoint_busy", `Another event command owns ${lock}. If that process stopped, remove its stale lock before retrying.`);
    throw e;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd); fd = undefined;
    const saved = readCheckpoint(file, cfg, initialCursor);
    const { state, result } = await action(saved);
    writeCheckpoint(file, state);
    return { ...result, checkpoint_file: file };
  } finally {
    if (fd !== undefined) closeSync(fd);
    unlinkSync(lock);
  }
}

function checkedBatch(batch, after, limit) {
  if (validate("eventBatch", batch).length || !cursor(batch?.cursor) || batch.events.length > limit)
    throw error("invalid_response", "The service returned an invalid event batch; the checkpoint was not advanced");
  let sequence = after;
  for (const event of batch.events) {
    if (!cursor(event.seq) || event.seq <= sequence)
      throw error("invalid_response", "Event sequences must increase after the handled cursor; the checkpoint was not advanced");
    sequence = event.seq;
  }
  if (batch.cursor !== sequence)
    throw error("invalid_response", "The response cursor does not match the returned events; the checkpoint was not advanced");
  return batch;
}

function isProbe(event) {
  return event.type === "event" && event.by === "agent_probe" && event.role === null && event.device === null
    && event.data?.kind === "delivery_probe" && /^[a-z2-7]{20}$/.test(event.data.nonce);
}

/** Read one bounded batch, handle server diagnostics, retain application input. */
export async function pendingEvents(cfg, file, { limit = 100, initialCursor = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw error("invalid_argument", "--limit must be an integer from 1 to 500");
  return withCheckpoint(file, cfg, initialCursor, async saved => {
    const api = client(cfg);
    const after = saved.handled_cursor;
    const batch = checkedBatch(await api.get(`/events?after=${after}&wait=0&limit=${limit}`, {
      signal: AbortSignal.timeout(40000),
    }), after, limit);
    const events = [], probes = [];
    let handled = after;
    for (const event of batch.events) {
      if (!isProbe(event)) { events.push(event); continue; }
      const nonce = event.data.nonce;
      try {
        // Derive this relative route ourselves; page data never chooses a URL.
        const receipt = await api.post(`/wake/probe/${nonce}/ack`, undefined, { signal: AbortSignal.timeout(40000) });
        if (receipt?.nonce !== nonce || receipt.seq !== event.seq || !cursor(receipt.ack_at))
          throw error("invalid_response", "The service returned an invalid probe receipt; the checkpoint was not advanced");
        probes.push({ seq: event.seq, nonce, status: "acknowledged", ack_at: receipt.ack_at });
      } catch (e) {
        // Only the latest probe is retained for ten minutes. An obsolete probe
        // is handled by observing expiry, never reported as a successful test.
        if (!(e instanceof ApiError && e.status === 404 && e.body?.error?.code === "not_found")) throw e;
        probes.push({ seq: event.seq, nonce, status: "expired" });
      }
      if (events.length === 0) handled = event.seq;
    }
    return {
      state: { ...saved, handled_cursor: handled, delivered_cursor: Math.max(saved.delivered_cursor, batch.cursor) },
      result: { ...(() => { const { agent_reminder, ...rest } = batch; return rest; })(), events, after, handled_cursor: handled, probes, has_more: batch.events.length === limit },
    };
  });
}

/** Explicit acknowledgement only after all application work through seq succeeds. */
export async function acknowledgeEvents(cfg, file, through, { initialCursor = 0 } = {}) {
  if (!cursor(through)) throw error("invalid_argument", "ack requires a nonnegative safe integer sequence");
  return withCheckpoint(file, cfg, initialCursor, async saved => {
    if (through < saved.handled_cursor) throw error("checkpoint_regression", "The handled cursor cannot move backwards");
    if (through > saved.delivered_cursor) throw error("unseen_cursor", "Run pending and handle the returned events before acknowledging this sequence");
    return { state: { ...saved, handled_cursor: through }, result: { acknowledged: through, handled_cursor: through } };
  });
}
