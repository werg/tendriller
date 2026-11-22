// Automated source handoff (zero secrets) and encrypted device checkpoint export/restore (W9).
// Uses pure-JS tar.gz and Web Crypto AES-256-GCM; zero GNU tar subprocesses and zero Chronolog runtime dependency.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { packTarGz } from '@tendriller/core/archive';

const EXCLUDED_DIRS = new Set(['.tendriller', '.git', 'node_modules', 'dist', '.results', 'page', 'state', 'data', '.state', '.data']);
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.md', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2']);
const SOURCE_JSON = /^(?:package(?:-lock)?|tsconfig(?:\.[A-Za-z0-9_-]+)?)\.json$/u;
const EXCLUDED_FILES = new Set(['.env', '.env.local', 'provider-secrets.json', 'provider-local.mjs']);
const SECRET_PATTERNS = [
  /\b(?:privateKey|secretKey|clientSecret|accessToken|refreshToken|apiKey)\b["']?\s*[:=]\s*["'][^"']{16,}["']/u,
  /td_a_[a-f0-9]{64}/u,
  /td_n_[a-f0-9]{64}/u,
  /td_c_[a-f0-9-]{36}\.[a-f0-9]{64}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

const CHECKPOINT_MAGIC = new Uint8Array([0x43, 0x4c, 0x43, 0x50, 0x01]);
const CHECKPOINT_FORMAT = 'chronolog-device-checkpoint-v1';
const DEVICE_RETIRED_KEY = 'peer-session/checkpoint-retired/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walkSourceFiles(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      walkSourceFiles(root, join(current, entry.name), out);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.') || EXCLUDED_FILES.has(entry.name) ||
          (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !SOURCE_JSON.test(entry.name))) continue;
      const full = join(current, entry.name);
      const rel = relative(root, full).replaceAll('\\', '/');
      out.push({ path: rel, full });
    }
  }
  return out;
}

/**
 * Pack non-secret project source files into a deterministic tar.gz handoff archive.
 * Verifies zero private keys, device stores, or agent tokens enter the archive.
 */
export function exportSourceHandoff(projectDir, outputPath, { nextCommand = 'npm install && npm run init' } = {}) {
  const root = resolve(projectDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw fail('handoff_source_missing', `Project directory not found: ${root}`);
  const destination = resolve(outputPath);
  const files = walkSourceFiles(root).filter(file => resolve(file.full) !== destination);
  const entries = [];
  let totalBytes = 0;
  for (const file of files) {
    const size = statSync(file.full).size;
    if (size > 16 * 1024 * 1024 || (totalBytes += size) > 64 * 1024 * 1024)
      throw fail('handoff_size_limit', 'Source handoff exceeds the 16 MiB file or 64 MiB total bound.');
    const bytes = readFileSync(file.full);
    const text = bytes.toString('utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        throw fail('handoff_secret_detected', `Refusing to pack private credential material found in ${file.path}.`);
      }
    }
    entries.push({ path: file.path, bytes });
  }
  const manifest = {
    format: 'tendriller-source-handoff-v1',
    createdAt: new Date().toISOString(),
    fileCount: entries.length,
    nextCommand,
    privateStatePolicy: 'known runtime state and secret files excluded; recognized credentials rejected',
    sourceReviewRequired: true,
    inclusionPolicy: 'Code, documentation, static assets and package/TypeScript manifests only. Review authored source for embedded credentials before sharing.',
  };
  entries.push({ path: 'handoff-manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2) + '\n') });
  const archive = packTarGz(entries);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, archive, { mode: 0o600 });
  return { output: destination, sha256: sha256Hex(archive), size: archive.byteLength, manifest };
}

async function deriveCheckpointKey(secret, salt, usage) {
  if (typeof secret === 'string' && /^[a-f0-9]{64}$/iu.test(secret)) {
    const raw = Buffer.from(secret, 'hex');
    return { isRaw: true, key: await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usage) };
  }
  if (typeof secret !== 'string' || secret.length < 12) {
    throw fail('CHECKPOINT_KEY_INVALID', 'Supply a 64-hex key or passphrase of at least 12 characters.');
  }
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
  return { isRaw: false, key };
}

/**
 * Quiesce a NativeBytesStore SQLite file (PRAGMA wal_checkpoint(TRUNCATE)), export an
 * AES-256-GCM encrypted checkpoint compatible with @chronolog/peer-session, and optionally retire the source.
 */
export async function exportSqliteCheckpoint({ devicePath, outputPath, secret, sqlPath = null, applicationId = null, deviceId = null, retireSource = true }) {
  const { DatabaseSync } = await import('node:sqlite');
  const resolvedDevice = resolve(devicePath);
  if (!existsSync(resolvedDevice)) throw fail('checkpoint_device_missing', `Device store not found: ${resolvedDevice}`);
  const db = new DatabaseSync(resolvedDevice);
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; PRAGMA wal_checkpoint(TRUNCATE)');
    const retired = db.prepare('SELECT value FROM stored_bytes WHERE key = ?').get(DEVICE_RETIRED_KEY);
    if (retired) throw fail('DEVICE_RETIRED_BY_CHECKPOINT', 'This device store was already retired by an earlier checkpoint export.');
    const rows = db.prepare('SELECT key, value FROM stored_bytes ORDER BY key ASC').all()
      .filter(r => r.key !== DEVICE_RETIRED_KEY)
      .map(r => ({ key: r.key, value: Uint8Array.from(r.value) }));

    let sqlBytes = null;
    if (sqlPath && existsSync(resolve(sqlPath))) {
      const sqlDb = new DatabaseSync(resolve(sqlPath));
      try { sqlDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { sqlDb.close(); }
      sqlBytes = new Uint8Array(readFileSync(resolve(sqlPath)));
    }
    const outbox = [];
    const manifestSha256 = sha256Hex(encoder.encode(JSON.stringify({
      entries: rows.map(e => [e.key, sha256Hex(e.value), e.value.byteLength]),
      sql: sqlBytes ? [sha256Hex(sqlBytes), sqlBytes.byteLength] : null,
      outbox,
    })));
    const createdAt = new Date().toISOString();
    const metadata = {
      format: CHECKPOINT_FORMAT,
      applicationId,
      deviceId,
      createdAt,
      entryCount: rows.length,
      hasSqlDatabase: sqlBytes !== null,
      outboxCount: outbox.length,
      manifestSha256,
    };
    const plaintext = encoder.encode(JSON.stringify({
      metadata,
      entries: rows.map(e => ({ key: e.key, value: Buffer.from(e.value).toString('base64') })),
      sqlDatabaseBase64: sqlBytes ? Buffer.from(sqlBytes).toString('base64') : null,
      outbox,
    }));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const { isRaw, key } = await deriveCheckpointKey(secret, salt, ['encrypt']);
    const effectiveSalt = isRaw ? new Uint8Array(16) : salt;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(CHECKPOINT_FORMAT) }, key, plaintext));
    const out = new Uint8Array(CHECKPOINT_MAGIC.length + 1 + 16 + 12 + ciphertext.byteLength);
    let offset = 0;
    out.set(CHECKPOINT_MAGIC, offset); offset += CHECKPOINT_MAGIC.length;
    out[offset++] = isRaw ? 1 : 0;
    out.set(effectiveSalt, offset); offset += 16;
    out.set(iv, offset); offset += 12;
    out.set(ciphertext, offset);

    const destination = resolve(outputPath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, out, { mode: 0o600 });

    if (retireSource) {
      db.prepare('INSERT INTO stored_bytes(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(DEVICE_RETIRED_KEY, encoder.encode(JSON.stringify({ retiredAt: createdAt, manifestSha256 })));
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    return { output: destination, size: out.byteLength, retiredSource: retireSource, metadata };
  } finally {
    db.close();
  }
}

/**
 * Decrypt, authenticate, and restore an encrypted checkpoint into a fresh SQLite device store.
 */
export async function restoreSqliteCheckpoint({ inputPath, devicePath, secret, sqlPath = null }) {
  const bytes = new Uint8Array(readFileSync(resolve(inputPath)));
  const headerLen = CHECKPOINT_MAGIC.length + 1 + 16 + 12;
  if (bytes.byteLength <= headerLen + 16) throw fail('CHECKPOINT_CORRUPT', 'Encrypted checkpoint is truncated.');
  for (let i = 0; i < CHECKPOINT_MAGIC.length; i++) {
    if (bytes[i] !== CHECKPOINT_MAGIC[i]) throw fail('CHECKPOINT_FORMAT_UNSUPPORTED', 'Invalid checkpoint header.');
  }
  const targetDevice = resolve(devicePath);
  if (existsSync(targetDevice)) throw fail('CHECKPOINT_TARGET_NOT_EMPTY', `Target device store already exists: ${targetDevice}`);
  let offset = CHECKPOINT_MAGIC.length;
  const flags = bytes[offset++];
  const expectRaw = (flags & 1) === 1;
  const salt = bytes.subarray(offset, offset + 16); offset += 16;
  const iv = bytes.subarray(offset, offset + 12); offset += 12;
  const ciphertext = bytes.subarray(offset);
  const { isRaw, key } = await deriveCheckpointKey(secret, salt, ['decrypt']);
  if (expectRaw !== isRaw) throw fail('CHECKPOINT_KEY_MISMATCH', 'Checkpoint key format does not match the encrypted header.');
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(CHECKPOINT_FORMAT) }, key, ciphertext);
  } catch {
    throw fail('CHECKPOINT_DECRYPT_FAILED', 'Checkpoint authentication failed (wrong key or tampered file).');
  }
  const decoded = JSON.parse(decoder.decode(new Uint8Array(plaintext)));
  const rows = decoded.entries.filter(e => e.key !== DEVICE_RETIRED_KEY).map(e => ({ key: e.key, value: new Uint8Array(Buffer.from(e.value, 'base64')) }));
  const sqlBytes = decoded.sqlDatabaseBase64 ? new Uint8Array(Buffer.from(decoded.sqlDatabaseBase64, 'base64')) : null;
  const actualSha = sha256Hex(encoder.encode(JSON.stringify({
    entries: rows.map(e => [e.key, sha256Hex(e.value), e.value.byteLength]),
    sql: sqlBytes ? [sha256Hex(sqlBytes), sqlBytes.byteLength] : null,
    outbox: decoded.outbox ?? [],
  })));
  if (actualSha !== decoded.metadata?.manifestSha256) throw fail('CHECKPOINT_INTEGRITY_MISMATCH', 'Checkpoint manifest hash mismatch.');

  mkdirSync(dirname(targetDevice), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(targetDevice);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS stored_bytes(key TEXT PRIMARY KEY, value BLOB NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO stored_bytes(key, value) VALUES(?, ?)');
    for (const row of rows) insert.run(row.key, row.value);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  if (sqlBytes && sqlPath) {
    mkdirSync(dirname(resolve(sqlPath)), { recursive: true });
    writeFileSync(resolve(sqlPath), sqlBytes, { mode: 0o600 });
  }
  return { devicePath: targetDevice, sqlRestored: Boolean(sqlBytes && sqlPath), restoredEntries: rows.length, metadata: decoded.metadata };
}
