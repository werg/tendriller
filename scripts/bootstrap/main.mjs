#!/usr/bin/env node
// Standalone, zero-dependency, single-file ESM bootstrapper (W6).
// Runs directly under Node 22.15+ / Node 24+ without npm registry access or GNU tar/bash.
// Outputs structured JSON on stdout, progress/diagnostics on stderr.
// Exit codes: 0=ready, 2=capability missing (with viable route), 3=integrity/verification failure, 4=lock conflict.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { freemem, platform, arch, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extractVerifiedTarGz, createReleaseDownloader } from '../../contract/release-verify.mjs';

const EXIT = Object.freeze({ READY: 0, CAPABILITY_MISSING: 2, INTEGRITY_FAILURE: 3, LOCK_CONFLICT: 4 });
const PROFILES = new Set(['events-relay-only', 'events-full', 'sql-portable-relay-only', 'sql-full']);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const log = message => { process.stderr.write(`[tendriller-bootstrap] ${message}\n`); };
const fail = (exitCode, code, message, extra = {}) => Object.assign(new Error(message), { exitCode, code, ...extra });

async function run() {
  const { values } = parseArgs({
    options: {
      origin: { type: 'string' },
      release: { type: 'string' },
      profile: { type: 'string', default: 'events-full' },
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
    process.stdout.write(JSON.stringify({ ok: true, readiness: 'probe_complete', requestedProfile: values.profile, profile: null, profileConfigured: false, probe }) + '\n');
    return;
  }

  if (!values['archive-file'] && (!values.origin || !values.release)) {
    throw fail(EXIT.CAPABILITY_MISSING, 'origin_required', 'Supply both --origin and --release, or --archive-file for offline extraction.', {
      viableRoutes: ['supply-explicit-origin', 'remote-https-mcp-connector'],
    });
  }

  let serviceOrigin = null;
  let readinessState = 'project_prepared';
  if (values.origin) {
    const parsed = new URL(values.origin);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
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

  // Preserve private storage and existing authored configuration.
  const preservePrivate = (rel, abs) => {
    if (rel.startsWith('.tendriller/') || rel === '.env') return true;
    return existsSync(abs) && (rel === 'configuration.json' || rel.endsWith('/configuration.json'));
  };

  let extracted = null;
  if (values['archive-file']) {
    const archivePath = resolve(values['archive-file']);
    if (statSync(archivePath).size > 64 * 1024 * 1024) throw fail(EXIT.INTEGRITY_FAILURE, 'archive_size_limit', 'Compressed archive exceeds 64 MiB.');
    const bytes = readFileSync(archivePath);
    const actualSha = sha256(bytes);
    if (values['expected-sha256']) {
      if (!SHA256_RE.test(values['expected-sha256']) || actualSha !== values['expected-sha256']) {
        throw fail(EXIT.INTEGRITY_FAILURE, 'sha256_mismatch', `Archive hash mismatch: expected ${values['expected-sha256']}, got ${actualSha}`);
      }
    }
    extracted = { ...extractVerifiedTarGz(bytes, projectDir, { preserveExisting: preservePrivate }), sha256: actualSha };
    log(`Verified and extracted local archive (${extracted.written.length} written, ${extracted.preserved.length} preserved)`);
  } else if (values.release) {
    if (!COMMIT_RE.test(values.release)) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'release_commit_invalid', '--release must be a 40-character lowercase commit SHA.');
    }
    const base = `https://github.com/werg/tendriller/releases/download/source-${values.release}`;
    log(`Fetching pinned release manifest from ${base}/manifest.json`);
    const downloader = createReleaseDownloader(base);
    const manifestBytes = await downloader.download('manifest.json', undefined, undefined, true);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.source_commit !== values.release || !manifest.first_app?.file) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'manifest_mismatch', 'Downloaded manifest does not match pinned --release commit.');
    }
    const firstApp = manifest.artifacts?.find(a => a.role === 'first-app' && a.file === manifest.first_app.file);
    if (!firstApp || !SHA256_RE.test(firstApp.sha256) || !Number.isSafeInteger(firstApp.size) || firstApp.size < 0) {
      throw fail(EXIT.INTEGRITY_FAILURE, 'manifest_missing_first_app', 'Manifest is missing verified first-app artifact metadata.');
    }
    log(`Downloading verified ${firstApp.file} (${firstApp.size} bytes)`);
    const kit = await downloader.download(firstApp.file, firstApp.sha256, firstApp.size, true);
    extracted = extractVerifiedTarGz(kit, projectDir, {expectedSha256: firstApp.sha256, preserveExisting: preservePrivate});
  }

  const hasRetainedIdentity = existsSync(join(projectDir, '.tendriller', 'device.sqlite')) || existsSync(join(projectDir, '.tendriller', 'handle.json'));
  // Retained files are not proof of a verified app, reachable participant or applied command.

  process.stdout.write(JSON.stringify({
    ok: true,
    readiness: readinessState,
    readinessStates: ['project_prepared'],
    requestedProfile: values.profile,
    profile: null,
    profileConfigured: false,
    nextAction: 'Install the verified kit packages and configure the requested profile before starting and verifying the participant.',
    serviceOrigin,
    projectDirectory: projectDir,
    retainedExistingIdentity: hasRetainedIdentity,
    probe,
    extracted,
  }, null, 2) + '\n');
}

run().catch(error => {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : /^(ARCHIVE_|release_)/u.test(error?.code ?? '') ? EXIT.INTEGRITY_FAILURE : 1;
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
