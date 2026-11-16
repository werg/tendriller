import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lineLimit, lineRecord, errorRecord, recordErrorReason } from './records.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const capabilities = Object.freeze({ mode: 'poll', replay: 'retained-file', checkpoint: true });

/** Reads complete UTF-8 lines; stores no uncommitted partial line in memory. */
export async function readFileBatch(source, checkpoint, maxRecords = 100, { open: openFile = open } = {}) {
  const maxLineBytes = lineLimit(source), readBytes = Math.max(128 * 1024, maxLineBytes + 1);
  const file = await openFile(source.path, 'r');
  try {
    const stat = await file.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    let offset = checkpoint?.identity === identity && checkpoint.offset <= stat.size ? checkpoint.offset : 0;
    let discarding = offset ? !!checkpoint?.discarding : false;
    // Read the old boundary and new payload together. A separate fingerprint
    // read could observe a replacement generation after the payload was read.
    let prefix = Math.min(offset, 64);
    let captured = Buffer.alloc(readBytes + prefix);
    let { bytesRead: capturedBytes } = await file.read(captured, 0, captured.length, offset - prefix);
    if (offset && (capturedBytes < prefix || checkpoint.anchor && digest(captured.subarray(0, prefix)) !== checkpoint.anchor)) {
      offset = 0; prefix = 0; discarding = false;
      captured = Buffer.alloc(readBytes);
      ({ bytesRead: capturedBytes } = await file.read(captured, 0, captured.length, 0));
    }
    const buffer = captured.subarray(prefix, capturedBytes), bytesRead = buffer.length;
    const records = [];
    let start = 0, consumed = 0;
    while (start < bytesRead && records.length < maxRecords) {
      const newline = buffer.indexOf(10, start);
      if (newline < 0 || newline >= bytesRead) {
        if (discarding || bytesRead - start > maxLineBytes) {
          if (!discarding) records.push(errorRecord(source, 'line_too_large', { offset: offset + start }));
          discarding = true; consumed = bytesRead;
        }
        break;
      }
      if (!discarding) {
        if (newline - start > maxLineBytes) records.push(errorRecord(source, 'line_too_large', { offset: offset + start }));
        else {
          const line = buffer.subarray(start, newline).toString('utf8').replace(/\r$/, '');
          if (line.trim()) {
            try { records.push(lineRecord(source, line)); }
            catch (error) { records.push(errorRecord(source, recordErrorReason(error), { offset: offset + start })); }
          }
        }
      }
      discarding = false;
      start = consumed = newline + 1;
    }
    const nextOffset = offset + consumed;
    const end = prefix + consumed;
    const anchor = digest(captured.subarray(Math.max(0, end - 64), end));
    return { records, checkpoint: { identity, offset: nextOffset, anchor, discarding } };
  } finally { await file.close(); }
}

/** Checkpoints are proposals only; the collector commits them with the corresponding records. */
export function createFileSource(source, { open: openFile = open } = {}) {
  return {
    source, capabilities,
    async read({ checkpoint, maxRecords = 100 }) {
      return { ...await readFileBatch(source, checkpoint, maxRecords, { open: openFile }), health: 'collecting' };
    },
    failure: error => error.code === 'spool_full' ? 'spool_full' : error.code === 'ENOENT' ? 'waiting_for_file' : 'source_error',
    close() {},
  };
}
