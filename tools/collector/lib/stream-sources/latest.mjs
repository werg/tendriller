import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lineLimit, lineRecord, recordFor, errorRecord, recordErrorReason } from './records.mjs';

// Reads a complete atomically replaced current-value file, not an append-only log.
// The digest checkpoint is committed with the corresponding durable record in the spool.
const capabilities = Object.freeze({mode:'poll',replay:'retained-file',checkpoint:true});
const digest = value => createHash('sha256').update(value).digest('hex');

export async function readLatestFile(source, checkpoint, { open: openFile = open } = {}) {
  const file = await openFile(source.path,'r');
  try {
    const stat = await file.stat();
    const max = lineLimit(source);
    // Never allocate an unbounded input from a host-controlled path.
    let bytes;
    if (stat.size > max) {
      const key = digest('too_large:'+stat.size+':'+stat.mtimeMs);
      if (key === checkpoint?.digest) return {records:[],checkpoint};
      return {records:[errorRecord(source,'line_too_large')],checkpoint:{digest:key}};
    }
    // A bounded read also protects against concurrent growth after stat().
    const buffer = Buffer.alloc(max+1);
    let filled=0;
    while (filled < buffer.length) {
      const {bytesRead}=await file.read(buffer,filled,buffer.length-filled,filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    bytes=buffer.subarray(0,filled);
    if (bytes.length > max) {
      const key = digest('too_large:'+bytes.length+':'+stat.mtimeMs);
      if (key === checkpoint?.digest) return {records:[],checkpoint};
      return {records:[errorRecord(source,'line_too_large')],checkpoint:{digest:key}};
    }
    const key = digest(Buffer.concat([Buffer.from(String(source.run ?? '')), Buffer.from([0]), bytes]));
    if (key === checkpoint?.digest) return {records:[],checkpoint};
    let record;
    if (bytes.length && bytes.toString('utf8').trim()) {
      try {
        const decoder = new TextDecoder('utf-8',{fatal:true});
        const content = decoder.decode(bytes);
        if (source.format === 'text') record = recordFor(source,'snapshot',{value:content});
        else record = lineRecord({...source,type:'jsonl'},content);
      } catch (error) {
        record = errorRecord(source,recordErrorReason(error) === 'record_too_large' && error.code !== 'record_too_large'
          ? 'invalid_utf8' : recordErrorReason(error));
      }
    }
    return {records:record?[record]:[],checkpoint:{digest:key}};
  } finally {await file.close();}
}

export function createLatestSource(source, options = {}) {
  return {
    source,capabilities,
    async read({checkpoint}) {
      return {...await readLatestFile(source,checkpoint,options),health:'collecting'};
    },
    failure: error => error.code === 'spool_full' ? 'spool_full' : error.code === 'ENOENT' ? 'waiting_for_file' : 'source_error',
    close() {},
  };
}
