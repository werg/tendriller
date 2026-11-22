#!/usr/bin/env node

// scripts/bootstrap/main.mjs
import { createHash as createHash2 } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { freemem, platform, arch, tmpdir, totalmem } from "node:os";
import { join as join2, resolve as resolve2 } from "node:path";
import { parseArgs } from "node:util";

// contract/release-verify.mjs
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, parse, basename } from "node:path";

// contract/archive.mjs
import { gunzipSync, gzipSync } from "node:zlib";
var BLOCK = 512;
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
function parseOctal(buf, offset, length) {
  const raw = decoder.decode(buf.subarray(offset, offset + length)).replace(/\0.*$/u, "").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/u.test(raw)) throw fail("ARCHIVE_CORRUPT", `Invalid octal header field: ${raw}`);
  const value = parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw fail("ARCHIVE_CORRUPT", `Invalid octal header field: ${raw}`);
  return value;
}
function normalizeEntryName(name) {
  const normalized = String(name).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || normalized.includes("\0") || normalized.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw fail("ARCHIVE_PATH_UNSAFE", `Unsafe archive entry path: ${name}`);
  }
  return normalized;
}
function unpackTarGz(compressedBytes, { maxTotalBytes = 128 * 1024 * 1024, maxEntries = 4096 } = {}) {
  const tar = new Uint8Array(gunzipSync(compressedBytes, { maxOutputLength: maxTotalBytes + BLOCK * maxEntries }));
  const files = /* @__PURE__ */ new Map();
  let offset = 0;
  let totalBytes = 0;
  let paxPath = null, headers = 0, ended = false;
  while (offset + BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (paxPath !== null || offset + BLOCK * 2 > tar.byteLength || !tar.subarray(offset).every((byte) => byte === 0))
        throw fail("ARCHIVE_CORRUPT", "Invalid tar end marker.");
      ended = true;
      break;
    }
    if (++headers > maxEntries) throw fail("ARCHIVE_ENTRY_LIMIT", "Archive exceeds maximum entry count.");
    offset += BLOCK;
    const recordedChecksum = parseOctal(header, 148, 8);
    let computed = 0;
    for (let i = 0; i < BLOCK; i++) computed += i >= 148 && i < 156 ? 32 : header[i];
    if (computed !== recordedChecksum) throw fail("ARCHIVE_CHECKSUM_INVALID", "Tar header checksum verification failed.");
    const rawName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/u, "");
    const rawPrefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/u, "");
    const typeFlag = header[156];
    const size = parseOctal(header, 124, 12);
    const dataEnd = offset + size;
    if (!Number.isSafeInteger(dataEnd) || offset + Math.ceil(size / BLOCK) * BLOCK > tar.byteLength) throw fail("ARCHIVE_CORRUPT", "Truncated tar entry payload.");
    const payload = tar.subarray(offset, dataEnd);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (typeFlag === 120) {
      let cursor = 0;
      while (cursor < payload.length) {
        const space = payload.indexOf(32, cursor);
        const lengthText = decoder.decode(payload.subarray(cursor, space));
        const length = Number(lengthText);
        if (space < cursor || !/^[1-9][0-9]*$/u.test(lengthText) || !Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > payload.length || payload[cursor + length - 1] !== 10)
          throw fail("ARCHIVE_CORRUPT", "Invalid PAX record length.");
        const record = decoder.decode(payload.subarray(space + 1, cursor + length - 1));
        const equal = record.indexOf("=");
        if (equal < 1) throw fail("ARCHIVE_CORRUPT", "Invalid PAX record.");
        const key = record.slice(0, equal), value = record.slice(equal + 1);
        if (key === "path") paxPath = value;
        if (key === "size" || key === "linkpath") throw fail("ARCHIVE_UNSUPPORTED_ENTRY", "PAX size/link overrides are unsupported.");
        cursor += length;
      }
      continue;
    }
    if (typeFlag === 76) {
      paxPath = decoder.decode(payload).replace(/\0.*$/u, "");
      continue;
    }
    if (typeFlag === 103) continue;
    const combined = paxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    paxPath = null;
    if (typeFlag === 53) {
      const directory = combined.replace(/\/+$/u, "");
      if (directory !== "." && directory !== "") normalizeEntryName(directory);
      continue;
    }
    if (typeFlag !== 48 && typeFlag !== 0) {
      throw fail("ARCHIVE_UNSUPPORTED_ENTRY", `Unsupported non-regular tar entry type ${typeFlag} for ${combined}`);
    }
    const cleanPath = normalizeEntryName(combined);
    if (files.size >= maxEntries) throw fail("ARCHIVE_ENTRY_LIMIT", "Archive exceeds maximum entry count.");
    totalBytes += size;
    if (totalBytes > maxTotalBytes) throw fail("ARCHIVE_SIZE_LIMIT", "Archive exceeds maximum uncompressed byte limit.");
    if (files.has(cleanPath)) throw fail("ARCHIVE_DUPLICATE_ENTRY", `Duplicate archive entry: ${cleanPath}`);
    files.set(cleanPath, payload.slice());
  }
  if (!ended) throw fail("ARCHIVE_CORRUPT", "Missing tar end marker.");
  return files;
}

// contract/release-verify.mjs
var RELEASE_DOWNLOAD_LIMITS = Object.freeze({
  metadataBytes: 1024 * 1024,
  artifactBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  artifacts: 32,
  redirects: 3,
  timeoutMs: 3e5
});
var SHA256_RE = /^[a-f0-9]{64}$/u;
var ALLOWED_REDIRECT_HOSTS = /* @__PURE__ */ new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
var fail2 = (code, message) => Object.assign(new Error(message), { code });
var sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
function validateRedirectTarget(location, previous, initial, allowedHosts = ALLOWED_REDIRECT_HOSTS) {
  let target;
  try {
    target = new URL(location, previous);
  } catch {
    throw fail2("release_redirect_invalid", "The public release returned an invalid asset redirect.");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.port || target.hash || !allowedHosts.has(target.hostname) || target.hostname === "github.com" && (target.pathname !== initial.pathname || target.search)) {
    throw fail2("release_redirect_forbidden", `The public release redirected outside permitted HTTPS locations: ${target.hostname}`);
  }
  return target;
}
function createReleaseDownloader(baseUrl, {
  fetcher = globalThis.fetch,
  limits = RELEASE_DOWNLOAD_LIMITS,
  allowedHosts = ALLOWED_REDIRECT_HOSTS,
  signal,
  onVerified
} = {}) {
  const base = String(baseUrl).replace(/\/+$/u, "");
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password || parsedBase.port || parsedBase.search || parsedBase.hash || !allowedHosts.has(parsedBase.hostname))
    throw fail2("release_expectation_invalid", "Require an allowed public HTTPS release base URL.");
  const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]) : AbortSignal.timeout(limits.timeoutMs);
  let totalBytes = 0, artifacts = 0;
  async function download(file, expectedHash, expectedSize, retain = false) {
    if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file) || expectedHash !== void 0 && !SHA256_RE.test(expectedHash) || expectedSize !== void 0 && (!Number.isSafeInteger(expectedSize) || expectedSize < 0))
      throw fail2("release_expectation_invalid", "Require a release asset filename and valid hash/size expectations.");
    if (++artifacts > limits.artifacts) throw fail2("release_size_limit", "Release asset count exceeds its bound.");
    const initial = new URL(`${base}/${file}`);
    const maximum = file.endsWith(".json") ? limits.metadataBytes : limits.artifactBytes;
    let url = initial;
    let response;
    for (let redirect = 0; ; redirect++) {
      try {
        response = await fetcher(url.href, {
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: lifetime
        });
      } catch {
        throw fail2("release_download_failed", `Could not read public release asset ${file}.`);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirect >= limits.redirects) throw fail2("release_redirect_limit", `Too many redirects for ${file}.`);
      const location = response.headers.get("location");
      if (!location) throw fail2("release_redirect_invalid", `Missing redirect location for ${file}.`);
      url = validateRedirectTarget(location, url, initial, allowedHosts);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw fail2("release_unavailable", `Public release asset ${file} returned HTTP ${response.status}.`);
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
      await response.body?.cancel();
      throw fail2("release_size_limit", `Public release asset ${file} exceeds its download bound.`);
    }
    const digest = createHash("sha256");
    const chunks = [];
    let bytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          const piece = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          bytes += piece.byteLength;
          totalBytes += piece.byteLength;
          if (bytes > maximum || expectedSize !== void 0 && bytes > expectedSize || totalBytes > limits.totalBytes) {
            throw fail2("release_size_limit", `Public release asset ${file} exceeds its expected size or total download bound.`);
          }
          digest.update(piece);
          if (retain || onVerified) chunks.push(piece);
        }
      }
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("release_")) throw error;
      throw fail2("release_download_failed", `Public release asset ${file} could not be read completely.`);
    }
    const actualHash = digest.digest("hex");
    if (expectedSize !== void 0 && bytes !== expectedSize || expectedHash !== void 0 && actualHash !== expectedHash) {
      throw fail2("release_bytes_mismatch", `Public release asset ${file} failed SHA-256 or byte-length verification.`);
    }
    const content = retain || onVerified ? Buffer.concat(chunks) : void 0;
    if (onVerified) await onVerified(file, content);
    return retain ? content : void 0;
  }
  return Object.freeze({
    download,
    get downloadedBytes() {
      return totalBytes;
    }
  });
}
function ensureSafeDirectory(path) {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const segment of full.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail2("ARCHIVE_PATH_UNSAFE", "Extraction requires real directories, without symbolic links.");
  }
}
function writeVerifiedFileAtomic(targetPath, bytes) {
  const full = resolve(targetPath);
  ensureSafeDirectory(dirname(full));
  try {
    if (lstatSync(full).isSymbolicLink()) throw fail2("ARCHIVE_PATH_UNSAFE", "Refusing a symbolic link destination.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = `${full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temp, "wx", 420);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, full);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
    }
    throw error;
  }
}
function extractVerifiedTarGz(archiveBytes, targetDirectory, {
  expectedSha256,
  stripPrefix = "",
  preserveExisting = () => false,
  maxTotalBytes
} = {}) {
  const bytes = archiveBytes instanceof Uint8Array ? archiveBytes : new Uint8Array(archiveBytes);
  if (expectedSha256 !== void 0) {
    if (!SHA256_RE.test(expectedSha256)) throw fail2("release_expectation_invalid", "Invalid expected SHA-256 digest.");
    if (sha256Hex(bytes) !== expectedSha256) throw fail2("release_bytes_mismatch", "Archive SHA-256 digest mismatch.");
  }
  const files = unpackTarGz(bytes, { ...maxTotalBytes === void 0 ? {} : { maxTotalBytes } });
  const requestedRoot = resolve(targetDirectory);
  mkdirSync(dirname(requestedRoot), { recursive: true });
  const destinationRoot = join(realpathSync(dirname(requestedRoot)), basename(requestedRoot));
  ensureSafeDirectory(destinationRoot);
  const written = [];
  const preserved = [];
  for (const [entryPath, content] of files) {
    const relativePath = stripPrefix && entryPath.startsWith(stripPrefix) ? entryPath.slice(stripPrefix.length) : entryPath;
    if (!relativePath) continue;
    const outputPath = resolve(destinationRoot, relativePath);
    if (!outputPath.startsWith(destinationRoot + "/") && !outputPath.startsWith(destinationRoot + "\\") && outputPath !== destinationRoot) {
      throw fail2("ARCHIVE_PATH_UNSAFE", `Archive entry escapes target directory: ${entryPath}`);
    }
    if (preserveExisting(relativePath, outputPath)) {
      preserved.push(relativePath);
      continue;
    }
    writeVerifiedFileAtomic(outputPath, content);
    written.push(relativePath);
  }
  return Object.freeze({ written, preserved, sha256: sha256Hex(bytes) });
}

// scripts/bootstrap/main.mjs
var EXIT = Object.freeze({ READY: 0, CAPABILITY_MISSING: 2, INTEGRITY_FAILURE: 3, LOCK_CONFLICT: 4 });
var PROFILES = /* @__PURE__ */ new Set(["events-relay-only", "events-full", "sql-portable-relay-only", "sql-full"]);
var SHA256_RE2 = /^[a-f0-9]{64}$/u;
var COMMIT_RE = /^[a-f0-9]{40}$/u;
var sha256 = (bytes) => createHash2("sha256").update(bytes).digest("hex");
var log = (message) => {
  process.stderr.write(`[tendriller-bootstrap] ${message}
`);
};
var fail3 = (exitCode, code, message, extra = {}) => Object.assign(new Error(message), { exitCode, code, ...extra });
async function run() {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      release: { type: "string" },
      profile: { type: "string", default: "events-full" },
      project: { type: "string", default: process.cwd() },
      "archive-file": { type: "string" },
      "expected-sha256": { type: "string" },
      "probe-only": { type: "boolean", default: false },
      json: { type: "boolean", default: true }
    }
  });
  if (!PROFILES.has(values.profile)) {
    throw fail3(EXIT.CAPABILITY_MISSING, "profile_unsupported", `Unsupported profile ${values.profile}. Choose one of: ${[...PROFILES].join(", ")}`);
  }
  const projectDir = resolve2(values.project);
  const wasmOk = typeof WebAssembly === "object" && typeof WebAssembly.compile === "function";
  if (values.profile.startsWith("sql-") && !wasmOk) {
    throw fail3(EXIT.CAPABILITY_MISSING, "SQL_ENGINE_UNAVAILABLE", "WebAssembly is unavailable in this runtime; SQL will not silently downgrade to events.", {
      viableRoutes: ["remote-https-mcp-connector", "external-or-serverless-host"]
    });
  }
  let sqliteOk = false;
  try {
    await import("node:sqlite");
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  const probe = {
    os: platform(),
    arch: arch(),
    node: process.versions.node,
    nodeSqlite: sqliteOk,
    wasm: wasmOk,
    totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
    freeMemoryMb: Math.round(freemem() / (1024 * 1024)),
    tmpWritable: existsSync(tmpdir())
  };
  if (values["probe-only"]) {
    process.stdout.write(JSON.stringify({ ok: true, readiness: "probe_complete", requestedProfile: values.profile, profile: null, profileConfigured: false, probe }) + "\n");
    return;
  }
  if (!values["archive-file"] && (!values.origin || !values.release)) {
    throw fail3(EXIT.CAPABILITY_MISSING, "origin_required", "Supply both --origin and --release, or --archive-file for offline extraction.", {
      viableRoutes: ["supply-explicit-origin", "remote-https-mcp-connector"]
    });
  }
  let serviceOrigin = null;
  let readinessState = "project_prepared";
  if (values.origin) {
    const parsed = new URL(values.origin);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      throw fail3(EXIT.INTEGRITY_FAILURE, "invalid_origin", "Service origin must use HTTPS (or loopback HTTP for local testing).");
    }
    serviceOrigin = parsed.origin;
    log(`Checking readiness at ${serviceOrigin}/api/readiness`);
    const res = await fetch(`${serviceOrigin}/api/readiness`, { redirect: "manual", signal: AbortSignal.timeout(1e4) });
    if (res.status !== 200) {
      throw fail3(EXIT.CAPABILITY_MISSING, "readiness_unavailable", `Service readiness returned HTTP ${res.status}; stopping without switching origins.`);
    }
    const readiness = await res.json();
    if (readiness?.schemaVersion !== 1 || readiness?.serviceOrigin !== serviceOrigin || readiness?.mode !== "open" || readiness?.creation?.available !== true) {
      throw fail3(EXIT.CAPABILITY_MISSING, "creation_not_open", readiness?.creation?.nextAction ?? `Service mode is ${readiness?.mode ?? "unknown"}; creation is not open.`, {
        readiness,
        viableRoutes: ["wait-for-operator-open", "use-existing-app-via-connector"]
      });
    }
  }
  const preservePrivate = (rel, abs) => {
    if (rel.startsWith(".tendriller/") || rel === ".env") return true;
    return existsSync(abs) && (rel === "configuration.json" || rel.endsWith("/configuration.json"));
  };
  let extracted = null;
  if (values["archive-file"]) {
    const archivePath = resolve2(values["archive-file"]);
    if (statSync(archivePath).size > 64 * 1024 * 1024) throw fail3(EXIT.INTEGRITY_FAILURE, "archive_size_limit", "Compressed archive exceeds 64 MiB.");
    const bytes = readFileSync(archivePath);
    const actualSha = sha256(bytes);
    if (values["expected-sha256"]) {
      if (!SHA256_RE2.test(values["expected-sha256"]) || actualSha !== values["expected-sha256"]) {
        throw fail3(EXIT.INTEGRITY_FAILURE, "sha256_mismatch", `Archive hash mismatch: expected ${values["expected-sha256"]}, got ${actualSha}`);
      }
    }
    extracted = { ...extractVerifiedTarGz(bytes, projectDir, { preserveExisting: preservePrivate }), sha256: actualSha };
    log(`Verified and extracted local archive (${extracted.written.length} written, ${extracted.preserved.length} preserved)`);
  } else if (values.release) {
    if (!COMMIT_RE.test(values.release)) {
      throw fail3(EXIT.INTEGRITY_FAILURE, "release_commit_invalid", "--release must be a 40-character lowercase commit SHA.");
    }
    const base = `https://github.com/werg/tendriller/releases/download/source-${values.release}`;
    log(`Fetching pinned release manifest from ${base}/manifest.json`);
    const downloader = createReleaseDownloader(base);
    const manifestBytes = await downloader.download("manifest.json", void 0, void 0, true);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.source_commit !== values.release || !manifest.first_app?.file) {
      throw fail3(EXIT.INTEGRITY_FAILURE, "manifest_mismatch", "Downloaded manifest does not match pinned --release commit.");
    }
    const firstApp = manifest.artifacts?.find((a) => a.role === "first-app" && a.file === manifest.first_app.file);
    if (!firstApp || !SHA256_RE2.test(firstApp.sha256) || !Number.isSafeInteger(firstApp.size) || firstApp.size < 0) {
      throw fail3(EXIT.INTEGRITY_FAILURE, "manifest_missing_first_app", "Manifest is missing verified first-app artifact metadata.");
    }
    log(`Downloading verified ${firstApp.file} (${firstApp.size} bytes)`);
    const kit = await downloader.download(firstApp.file, firstApp.sha256, firstApp.size, true);
    extracted = extractVerifiedTarGz(kit, projectDir, { expectedSha256: firstApp.sha256, preserveExisting: preservePrivate });
  }
  const hasRetainedIdentity = existsSync(join2(projectDir, ".tendriller", "device.sqlite")) || existsSync(join2(projectDir, ".tendriller", "handle.json"));
  process.stdout.write(JSON.stringify({
    ok: true,
    readiness: readinessState,
    readinessStates: ["project_prepared"],
    requestedProfile: values.profile,
    profile: null,
    profileConfigured: false,
    nextAction: "Install the verified kit packages and configure the requested profile before starting and verifying the participant.",
    serviceOrigin,
    projectDirectory: projectDir,
    retainedExistingIdentity: hasRetainedIdentity,
    probe,
    extracted
  }, null, 2) + "\n");
}
run().catch((error) => {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : /^(ARCHIVE_|release_)/u.test(error?.code ?? "") ? EXIT.INTEGRITY_FAILURE : 1;
  process.exitCode = exitCode;
  process.stdout.write(JSON.stringify({
    ok: false,
    exitCode,
    error: {
      code: error?.code ?? "bootstrap_failed",
      message: error?.message ?? String(error),
      ...error?.viableRoutes ? { viableRoutes: error.viableRoutes } : {}
    }
  }, null, 2) + "\n");
});
