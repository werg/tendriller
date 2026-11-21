// Shared pure-Node release downloader and SHA-256 integrity verifier used by
// tendriller, tendriller-contrib, and the standalone single-file bootstrapper.
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { unpackTarGz } from './archive.mjs';

export const RELEASE_DOWNLOAD_LIMITS = Object.freeze({
  metadataBytes: 1024 * 1024,
  artifactBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  artifacts: 32,
  redirects: 3,
  timeoutMs: 300_000,
});

const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const ALLOWED_REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

const fail = (code, message) => Object.assign(new Error(message), { code });
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateRedirectTarget(location, previous, initial, allowedHosts = ALLOWED_REDIRECT_HOSTS) {
  let target;
  try { target = new URL(location, previous); }
  catch { throw fail('release_redirect_invalid', 'The public release returned an invalid asset redirect.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash ||
      !allowedHosts.has(target.hostname) ||
      (target.hostname === 'github.com' && (target.pathname !== initial.pathname || target.search))) {
    throw fail('release_redirect_forbidden', `The public release redirected outside permitted HTTPS locations: ${target.hostname}`);
  }
  return target;
}

/**
 * Create a bounded, redirect-validated, SHA-256-verifying downloader for a pinned release base URL.
 */
export function createReleaseDownloader(baseUrl, {
  fetcher = globalThis.fetch,
  limits = RELEASE_DOWNLOAD_LIMITS,
  allowedHosts = ALLOWED_REDIRECT_HOSTS,
  signal,
  onVerified,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/u, '');
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== 'https:' || parsedBase.username || parsedBase.password || parsedBase.port || parsedBase.search || parsedBase.hash || !allowedHosts.has(parsedBase.hostname))
    throw fail('release_expectation_invalid', 'Require an allowed public HTTPS release base URL.');
  const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]) : AbortSignal.timeout(limits.timeoutMs);
  let totalBytes = 0, artifacts = 0;

  async function download(file, expectedHash, expectedSize, retain = false) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file) ||
        expectedHash !== undefined && !SHA256_RE.test(expectedHash) ||
        expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0))
      throw fail('release_expectation_invalid', 'Require a release asset filename and valid hash/size expectations.');
    if (++artifacts > limits.artifacts) throw fail('release_size_limit', 'Release asset count exceeds its bound.');
    const initial = new URL(`${base}/${file}`);
    const maximum = file.endsWith('.json') ? limits.metadataBytes : limits.artifactBytes;
    let url = initial;
    let response;
    for (let redirect = 0; ; redirect++) {
      try {
        response = await fetcher(url.href, {
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: lifetime,
        });
      } catch {
        throw fail('release_download_failed', `Could not read public release asset ${file}.`);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirect >= limits.redirects) throw fail('release_redirect_limit', `Too many redirects for ${file}.`);
      const location = response.headers.get('location');
      if (!location) throw fail('release_redirect_invalid', `Missing redirect location for ${file}.`);
      url = validateRedirectTarget(location, url, initial, allowedHosts);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw fail('release_unavailable', `Public release asset ${file} returned HTTP ${response.status}.`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
      await response.body?.cancel();
      throw fail('release_size_limit', `Public release asset ${file} exceeds its download bound.`);
    }
    const digest = createHash('sha256');
    const chunks = [];
    let bytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          const piece = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          bytes += piece.byteLength;
          totalBytes += piece.byteLength;
          if (bytes > maximum || (expectedSize !== undefined && bytes > expectedSize) || totalBytes > limits.totalBytes) {
            throw fail('release_size_limit', `Public release asset ${file} exceeds its expected size or total download bound.`);
          }
          digest.update(piece);
          if (retain || onVerified) chunks.push(piece);
        }
      }
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('release_')) throw error;
      throw fail('release_download_failed', `Public release asset ${file} could not be read completely.`);
    }
    const actualHash = digest.digest('hex');
    if ((expectedSize !== undefined && bytes !== expectedSize) || (expectedHash !== undefined && actualHash !== expectedHash)) {
      throw fail('release_bytes_mismatch', `Public release asset ${file} failed SHA-256 or byte-length verification.`);
    }
    const content = retain || onVerified ? Buffer.concat(chunks) : undefined;
    if (onVerified) await onVerified(file, content);
    return retain ? content : undefined;
  }

  return Object.freeze({
    download,
    get downloadedBytes() { return totalBytes; },
  });
}

export async function readPublishedManifest(sourceCommit, options = {}) {
  if (!COMMIT_RE.test(sourceCommit)) {
    throw fail('release_expectation_invalid', 'Require an exact 40-character source commit SHA before acquiring a release manifest.');
  }
  const repository = options.repository ?? 'werg/tendriller';
  const downloader = createReleaseDownloader(`https://github.com/${repository}/releases/download/source-${sourceCommit}`, options);
  return downloader.download('manifest.json', undefined, undefined, true);
}

/**
 * Atomically write verified bytes to a target file with fsync + rename (no partial files on crash).
 */
function ensureSafeDirectory(path) {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const segment of full.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try { mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('ARCHIVE_PATH_UNSAFE', 'Extraction requires real directories, without symbolic links.');
  }
}

export function writeVerifiedFileAtomic(targetPath, bytes) {
  const full = resolve(targetPath);
  ensureSafeDirectory(dirname(full));
  try {
    if (lstatSync(full).isSymbolicLink()) throw fail('ARCHIVE_PATH_UNSAFE', 'Refusing a symbolic link destination.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temp, 'wx', 0o644);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, full);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

/**
 * Verify a tar.gz buffer's SHA-256 hash and extract it cleanly using pure Node (no GNU tar binary).
 * Preserves existing files when `preserveExisting` matches a path (nondestructive restart).
 */
export function extractVerifiedTarGz(archiveBytes, targetDirectory, {
  expectedSha256,
  stripPrefix = '',
  preserveExisting = () => false,
  maxTotalBytes,
} = {}) {
  const bytes = archiveBytes instanceof Uint8Array ? archiveBytes : new Uint8Array(archiveBytes);
  if (expectedSha256 !== undefined) {
    if (!SHA256_RE.test(expectedSha256)) throw fail('release_expectation_invalid', 'Invalid expected SHA-256 digest.');
    if (sha256Hex(bytes) !== expectedSha256) throw fail('release_bytes_mismatch', 'Archive SHA-256 digest mismatch.');
  }
  const files = unpackTarGz(bytes, { ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }) });
  const destinationRoot = resolve(targetDirectory);
  ensureSafeDirectory(destinationRoot);
  const written = [];
  const preserved = [];
  for (const [entryPath, content] of files) {
    const relativePath = stripPrefix && entryPath.startsWith(stripPrefix) ? entryPath.slice(stripPrefix.length) : entryPath;
    if (!relativePath) continue;
    const outputPath = resolve(destinationRoot, relativePath);
    if (!outputPath.startsWith(destinationRoot + '/') && !outputPath.startsWith(destinationRoot + '\\') && outputPath !== destinationRoot) {
      throw fail('ARCHIVE_PATH_UNSAFE', `Archive entry escapes target directory: ${entryPath}`);
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
