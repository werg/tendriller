#!/usr/bin/env node
// Standalone, zero-dependency, single-file ESM bootstrapper (W6).
// Runs directly under Node 22.15+ / Node 24+ without npm registry access or GNU tar/bash.
// Outputs structured JSON on stdout, progress/diagnostics on stderr.
// Exit codes: 0=ready, 2=capability missing (with viable route), 3=integrity/verification failure, 4=lock conflict.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { freemem, platform, arch, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const EXIT = Object.freeze({ READY: 0, CAPABILITY_MISSING: 2, INTEGRITY_FAILURE: 3, LOCK_CONFLICT: 4 });
const PROFILES = new Set(['events-relay-only', 'events-full', 'sql-portable-relay-only', 'sql-full']);
const ALLOWED_REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const log = message => { process.stderr.write(`[tendriller-bootstrap] ${message}\n`); };
const fail = (exitCode, code, message, extra = {}) => Object.assign(new Error(message), { exitCode, code, ...extra });

function writeAtomic(targetPath, bytes) {
  const full = resolve(targetPath);
  mkdirSync(dirname(full), { recursive: true });
  const temp = `${full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temp, 'wx', 0o644);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, full); } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

function unpackTarGzSafe(compressedBytes, targetDir, { preserve = () => false } = {}) {
  const tar = new Uint8Array(gunzipSync(compressedBytes, { maxOutputLength: 128 * 1024 * 1024 }));
  const decoder = new TextDecoder();
  const root = resolve(targetDir);
  mkdirSync(root, { recursive: true });
  let offset = 0, paxPath = null;
  const written = [], preserved = [];
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    offset += 512;
    const rawSum = decoder.decode(header.subarray(148, 156)).replace(/\0.*$/u, '').trim();
    const recorded = parseInt(rawSum || '0', 8);
    let computed = 0;
    for (let i = 0; i < 512; i++) computed += i >= 148 && i < 156 ? 0x20 : header[i];
    if (computed !== recorded) throw fail(EXIT.INTEGRITY_FAILURE, 'archive_checksum_invalid', 'Tar header checksum failed.');
    const rawName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/u, '');
    const rawPrefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/u, '');
    const typeFlag = header[156];
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/u, '').trim() || '0', 8);
    const payload = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeFlag === 0x78) { const m = /\d+ path=([^\n]+)\n/u.exec(decoder.decode(payload)); if (m) paxPath = m[1]; continue; }
    if (typeFlag === 0x4c) { paxPath = decoder.decode(payload).replace(/\0.*$/u, ''); continue; }
    if (typeFlag === 0x67) continue;
    const combined = (paxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName)).replaceAll('\\', '/').replace(/^\.\//u, '');
    paxPath = null;
    if (typeFlag === 0x35 || combined.endsWith('/')) continue;
    if (typeFlag !== 0x30 && typeFlag !== 0x00) throw fail(EXIT.INTEGRITY_FAILURE, 'archive_entry_unsupported', `Non-regular archive entry: ${combined}`);
    if (!combined || combined.includes('\0') || combined.split('/').some(s => s === '..' || s === '.')) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'archive_path_unsafe', `Unsafe archive path: ${combined}`);
    }
    const destination = resolve(root, combined);
    if (!destination.startsWith(root + '/') && !destination.startsWith(root + '\\')) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'archive_path_escape', `Archive entry escapes destination: ${combined}`);
    }
    if (preserve(combined, destination)) { preserved.push(combined); continue; }
    writeAtomic(destination, payload);
    written.push(combined);
  }
  return { written, preserved };
}

async function fetchBounded(urlStr, { expectedHash, maxBytes = 64 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  const initial = new URL(urlStr);
  let url = initial, response;
  for (let i = 0; ; i++) {
    response = await fetch(url.href, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    if (i >= 3) throw fail(EXIT.INTEGRITY_FAILURE, 'redirect_limit', `Too many redirects for ${urlStr}`);
    const loc = response.headers.get('location');
    if (!loc) throw fail(EXIT.INTEGRITY_FAILURE, 'redirect_invalid', `Missing redirect location for ${urlStr}`);
    const next = new URL(loc, url);
    if (next.protocol !== 'https:' || !ALLOWED_REDIRECT_HOSTS.has(next.hostname)) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'redirect_forbidden', `Disallowed redirect host: ${next.hostname}`);
    }
    url = next;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw fail(EXIT.CAPABILITY_MISSING, 'asset_unavailable', `HTTP ${response.status} fetching ${urlStr}`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const piece = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    bytes += piece.byteLength;
    if (bytes > maxBytes) throw fail(EXIT.INTEGRITY_FAILURE, 'asset_size_limit', `Asset exceeds ${maxBytes} byte bound.`);
    chunks.push(piece);
  }
  const buf = Buffer.concat(chunks);
  const digest = sha256(buf);
  if (expectedHash && digest !== expectedHash) {
    throw fail(EXIT.INTEGRITY_FAILURE, 'sha256_mismatch', `Expected SHA-256 ${expectedHash}, got ${digest}`);
  }
  return { bytes: buf, sha256: digest };
}

async function run() {
  const { values } = parseArgs({
    options: {
      origin: { type: 'string' },
      release: { type: 'string' },
      profile: { type: 'string', default: 'events-relay-only' },
      project: { type: 'string', default: process.cwd() },
      'archive-file': { type: 'string' },
      'expected-sha256': { type: 'string' },
      'probe-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: true },
    },
  });

  if (!PROFILES.has(values.profile)) {
    throw fail(EXIT.CAPABILITY_MISSING, 'profile_unsupported', `Unsupported profile ${values.profile}. Choose one of: ${[...PROFILES].join(', ')}`);
  }

  const projectDir = resolve(values.project);
  const wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function';
  if (values.profile.startsWith('sql-') && !wasmOk) {
    throw fail(EXIT.CAPABILITY_MISSING, 'SQL_ENGINE_UNAVAILABLE', 'WebAssembly is unavailable in this runtime; SQL will not silently downgrade to events.', {
      viableRoutes: ['remote-https-mcp-connector', 'external-or-serverless-host'],
    });
  }

  let sqliteOk = false;
  try { await import('node:sqlite'); sqliteOk = true; } catch { sqliteOk = false; }

  const probe = {
    os: platform(),
    arch: arch(),
    node: process.versions.node,
    nodeSqlite: sqliteOk,
    wasm: wasmOk,
    totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
    freeMemoryMb: Math.round(freemem() / (1024 * 1024)),
    tmpWritable: existsSync(tmpdir()),
  };

  if (values['probe-only']) {
    process.stdout.write(JSON.stringify({ ok: true, readiness: 'probe_complete', profile: values.profile, probe }) + '\n');
    return;
  }

  if (!values.origin && !values['archive-file']) {
    throw fail(EXIT.CAPABILITY_MISSING, 'origin_required', 'Supply --origin https://YOUR_SERVICE_ORIGIN (or --archive-file for offline extraction).', {
      viableRoutes: ['supply-explicit-origin', 'remote-https-mcp-connector'],
    });
  }

  let serviceOrigin = null;
  let readinessState = 'project_prepared';
  if (values.origin) {
    const parsed = new URL(values.origin);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'invalid_origin', 'Service origin must use HTTPS (or loopback HTTP for local testing).');
    }
    serviceOrigin = parsed.origin;
    log(`Checking readiness at ${serviceOrigin}/api/readiness`);
    const res = await fetch(`${serviceOrigin}/api/readiness`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) {
      throw fail(EXIT.CAPABILITY_MISSING, 'readiness_unavailable', `Service readiness returned HTTP ${res.status}; stopping without switching origins.`);
    }
    const readiness = await res.json();
    if (readiness?.schemaVersion !== 1 || readiness?.serviceOrigin !== serviceOrigin || readiness?.mode !== 'open' || readiness?.creation?.available !== true) {
      throw fail(EXIT.CAPABILITY_MISSING, 'creation_not_open', readiness?.creation?.nextAction ?? `Service mode is ${readiness?.mode ?? 'unknown'}; creation is not open.`, {
        readiness,
        viableRoutes: ['wait-for-operator-open', 'use-existing-app-via-connector'],
      });
    }
  }

  // Nondestructive extraction: preserve .tendriller/, package-lock.json, and existing config files.
  const preservePrivate = (rel, abs) => {
    if (rel.startsWith('.tendriller/') || rel === '.env') return true;
    return existsSync(abs) && (rel === 'configuration.json' || rel.endsWith('/configuration.json'));
  };

  let extracted = null;
  if (values['archive-file']) {
    const bytes = readFileSync(resolve(values['archive-file']));
    const actualSha = sha256(bytes);
    if (values['expected-sha256']) {
      if (!SHA256_RE.test(values['expected-sha256']) || actualSha !== values['expected-sha256']) {
        throw fail(EXIT.INTEGRITY_FAILURE, 'sha256_mismatch', `Archive hash mismatch: expected ${values['expected-sha256']}, got ${actualSha}`);
      }
    }
    extracted = { ...unpackTarGzSafe(bytes, projectDir, { preserve: preservePrivate }), sha256: actualSha };
    log(`Verified and extracted local archive (${extracted.written.length} written, ${extracted.preserved.length} preserved)`);
  } else if (values.release) {
    if (!COMMIT_RE.test(values.release)) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'release_commit_invalid', '--release must be a 40-character lowercase commit SHA.');
    }
    const base = `https://github.com/werg/tendriller/releases/download/source-${values.release}`;
    log(`Fetching pinned release manifest from ${base}/manifest.json`);
    const manifestFetch = await fetchBounded(`${base}/manifest.json`, { maxBytes: 1024 * 1024 });
    const manifest = JSON.parse(manifestFetch.bytes.toString('utf8'));
    if (manifest.source_commit !== values.release || !manifest.first_app?.file) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'manifest_mismatch', 'Downloaded manifest does not match pinned --release commit.');
    }
    const firstApp = manifest.artifacts?.find(a => a.role === 'first-app' && a.file === manifest.first_app.file);
    if (!firstApp || !SHA256_RE.test(firstApp.sha256)) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'manifest_missing_first_app', 'Manifest is missing verified first-app artifact metadata.');
    }
    log(`Downloading verified ${firstApp.file} (${firstApp.size} bytes)`);
    const kit = await fetchBounded(`${base}/${firstApp.file}`, { expectedHash: firstApp.sha256, maxBytes: Math.max(firstApp.size, 1024) });
    extracted = { ...unpackTarGzSafe(kit.bytes, projectDir, { preserve: preservePrivate }), sha256: kit.sha256 };
  }

  const hasRetainedIdentity = existsSync(join(projectDir, '.tendriller', 'device.sqlite')) || existsSync(join(projectDir, '.tendriller', 'handle.json'));
  if (hasRetainedIdentity) readinessState = 'app_initialized';

  process.stdout.write(JSON.stringify({
    ok: true,
    readiness: readinessState,
    readinessStates: ['project_prepared', 'app_initialized', 'participant_reachable', 'command_applied'],
    profile: values.profile,
    serviceOrigin,
    projectDirectory: projectDir,
    retainedExistingIdentity: hasRetainedIdentity,
    probe,
    extracted,
  }, null, 2) + '\n');
}

run().catch(error => {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  process.exitCode = exitCode;
  process.stdout.write(JSON.stringify({
    ok: false,
    exitCode,
    error: {
      code: error?.code ?? 'bootstrap_failed',
      message: error?.message ?? String(error),
      ...(error?.viableRoutes ? { viableRoutes: error.viableRoutes } : {}),
    },
  }, null, 2) + '\n');
});
