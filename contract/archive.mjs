// Pure-JS POSIX ustar tar.gz encoder/decoder using built-in node:zlib.
// Eliminates GNU tar/unzip/bash subprocess dependencies across Windows, macOS, Linux, and minimal containers.
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function writeString(buf, offset, length, value) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw fail('ARCHIVE_FIELD_TOO_LONG', `Archive header field exceeds ${length} bytes: ${value}`);
  buf.set(bytes, offset);
}

function writeOctal(buf, offset, length, value) {
  const str = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  if (str.length >= length) throw fail('ARCHIVE_NUMBER_OVERFLOW', `Archive octal field overflow: ${value}`);
  writeString(buf, offset, length - 1, str);
  buf[offset + length - 1] = 0;
}

function parseOctal(buf, offset, length) {
  const raw = decoder.decode(buf.subarray(offset, offset + length)).replace(/\0.*$/u, '').trim();
  if (!raw) return 0;
  const value = parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw fail('ARCHIVE_CORRUPT', `Invalid octal header field: ${raw}`);
  return value;
}

function normalizeEntryName(name) {
  const normalized = String(name).replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+/u, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').some(seg => seg === '..' || seg === '.')) {
    throw fail('ARCHIVE_PATH_UNSAFE', `Unsafe archive entry path: ${name}`);
  }
  return normalized;
}

function splitUstarName(name) {
  const bytes = encoder.encode(name);
  if (bytes.length <= 100) return { name, prefix: '' };
  const slash = name.lastIndexOf('/');
  if (slash <= 0) throw fail('ARCHIVE_PATH_TOO_LONG', `Archive path cannot fit ustar header: ${name}`);
  const prefix = name.slice(0, slash);
  const base = name.slice(slash + 1);
  if (encoder.encode(prefix).length > 155 || encoder.encode(base).length > 100) {
    throw fail('ARCHIVE_PATH_TOO_LONG', `Archive path exceeds ustar limits: ${name}`);
  }
  return { name: base, prefix };
}

/**
 * Pack an array of `{ path, bytes, mode?, mtime? }` entries into a deterministic gzip-compressed ustar archive.
 */
export function packTarGz(entries, { mtime = 0 } = {}) {
  const sorted = [...entries]
    .map(entry => ({
      path: normalizeEntryName(entry.path),
      bytes: entry.bytes instanceof Uint8Array ? entry.bytes : encoder.encode(String(entry.bytes)),
      mode: entry.mode ?? 0o644,
      mtime: entry.mtime ?? mtime,
    }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const chunks = [];
  for (const entry of sorted) {
    const header = new Uint8Array(BLOCK);
    const { name, prefix } = splitUstarName(entry.path);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, entry.mtime);
    header.fill(0x20, 148, 156); // checksum placeholder
    header[156] = 0x30; // '0' regular file
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    if (prefix) writeString(header, 345, 155, prefix);

    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += header[i];
    const octal = checksum.toString(8).padStart(6, '0');
    writeString(header, 148, 6, octal);
    header[154] = 0;
    header[155] = 0x20;

    chunks.push(header);
    if (entry.bytes.byteLength > 0) {
      chunks.push(entry.bytes);
      const remainder = entry.bytes.byteLength % BLOCK;
      if (remainder !== 0) chunks.push(new Uint8Array(BLOCK - remainder));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2)); // EOF trailer

  const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) { tar.set(part, offset); offset += part.byteLength; }
  return new Uint8Array(gzipSync(tar, { level: 9, mtime: 0 }));
}

/**
 * Decode a gzip-compressed tar archive into a Map<normalizedPath, Uint8Array>.
 * Rejects path traversal, symlinks, hardlinks, device nodes, and oversized archives.
 */
export function unpackTarGz(compressedBytes, { maxTotalBytes = 128 * 1024 * 1024, maxEntries = 4096 } = {}) {
  const tar = new Uint8Array(gunzipSync(compressedBytes, { maxOutputLength: maxTotalBytes + BLOCK * maxEntries }));
  const files = new Map();
  let offset = 0;
  let totalBytes = 0;
  let paxPath = null;

  while (offset + BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    offset += BLOCK;

    const recordedChecksum = parseOctal(header, 148, 8);
    let computed = 0;
    for (let i = 0; i < BLOCK; i++) computed += i >= 148 && i < 156 ? 0x20 : header[i];
    if (computed !== recordedChecksum) throw fail('ARCHIVE_CHECKSUM_INVALID', 'Tar header checksum verification failed.');

    const rawName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/u, '');
    const rawPrefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/u, '');
    const typeFlag = header[156];
    const size = parseOctal(header, 124, 12);
    const dataEnd = offset + size;
    if (dataEnd > tar.byteLength) throw fail('ARCHIVE_CORRUPT', 'Truncated tar entry payload.');
    const payload = tar.subarray(offset, dataEnd);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    // PAX extended header ('x') or GNU LongLink ('L')
    if (typeFlag === 0x78) {
      const text = decoder.decode(payload);
      const match = /\d+ path=([^\n]+)\n/u.exec(text);
      if (match) paxPath = match[1];
      continue;
    }
    if (typeFlag === 0x4c) {
      paxPath = decoder.decode(payload).replace(/\0.*$/u, '');
      continue;
    }
    if (typeFlag === 0x67) continue; // global PAX header

    const combined = paxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    paxPath = null;

    // Directory ('5')
    if (typeFlag === 0x35 || combined.endsWith('/')) continue;
    // Regular file ('0' or '\0')
    if (typeFlag !== 0x30 && typeFlag !== 0x00) {
      throw fail('ARCHIVE_UNSUPPORTED_ENTRY', `Unsupported non-regular tar entry type ${typeFlag} for ${combined}`);
    }

    const cleanPath = normalizeEntryName(combined);
    if (files.size >= maxEntries) throw fail('ARCHIVE_ENTRY_LIMIT', 'Archive exceeds maximum entry count.');
    totalBytes += size;
    if (totalBytes > maxTotalBytes) throw fail('ARCHIVE_SIZE_LIMIT', 'Archive exceeds maximum uncompressed byte limit.');
    files.set(cleanPath, payload.slice());
  }
  return files;
}

export function listTarGz(compressedBytes, options) {
  return [...unpackTarGz(compressedBytes, options).keys()].sort();
}

export function readTarGzFile(compressedBytes, targetPath, options) {
  const files = unpackTarGz(compressedBytes, options);
  const normalized = normalizeEntryName(targetPath);
  const found = files.get(normalized);
  if (!found) throw fail('ARCHIVE_ENTRY_MISSING', `Archive entry not found: ${normalized}`);
  return found;
}
