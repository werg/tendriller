// Source handoff uses the public archive helper; device moves delegate to the app's matching Chronolog checkpoint API.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { packTarGz } from '@tendriller/core/archive';

const encoder = new TextEncoder();

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

/** Resolve the app's matching public session package, never a private kernel import. */
export async function loadCheckpointLibrary(projectDir) {
  const require = createRequire(join(resolve(projectDir), 'package.json'));
  const packageRoot = require.resolve.paths('@chronolog/peer-session')
    .map(base => join(base, '@chronolog/peer-session')).find(path => existsSync(join(path, 'package.json')));
  if (!packageRoot) throw fail('CHECKPOINT_LIBRARY_UNAVAILABLE', 'Install the matching public Chronolog session in the selected project.');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const entry = name => {
    const selected = pkg.exports?.[name], value = typeof selected === 'string' ? selected : selected?.import;
    if (pkg.name !== '@chronolog/peer-session' || typeof value !== 'string' || !value.startsWith('./'))
      throw fail('CHECKPOINT_LIBRARY_UNSUPPORTED', 'The installed package lacks its required public ESM exports.');
    const target = resolve(packageRoot, value);
    if (relative(packageRoot, target).startsWith('..')) throw fail('CHECKPOINT_LIBRARY_UNSUPPORTED', 'Invalid public package export.');
    return pathToFileURL(target).href;
  };
  const [kernel, native] = await Promise.all([import(entry('.')), import(entry('./native'))]);
  if (typeof native.NativeBytesStore?.prototype.putAllIfEmpty !== 'function' ||
      typeof kernel.exportDeviceCheckpoint !== 'function' || typeof kernel.restoreDeviceCheckpoint !== 'function')
    throw fail('CHECKPOINT_LIBRARY_UNSUPPORTED', 'Install the matching qualified Chronolog package with durable checkpoint persistence and atomic restore.');
  return { kernel, native };
}
function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === 'win32' && ['EACCES', 'EPERM', 'EISDIR', 'EINVAL'].includes(error.code))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function writeNewPrivate(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
const secretValue = (kernel, secret) => typeof secret === 'string' && /^[a-f0-9]{64}$/iu.test(secret)
  ? kernel.decodeCheckpointKeyHex(secret) : secret;
const nonConflicting = paths => {
  const values = paths.filter(Boolean).map(path => resolve(path));
  if (new Set(values).size !== values.length) throw fail('CHECKPOINT_PATH_CONFLICT', 'Checkpoint, device and SQL files must use distinct paths.');
};

/** Transfer a stopped retained device using the canonical checkpoint codec. */
export async function exportNativeCheckpoint({ devicePath, outputPath, secret,
  applicationId = null, deviceId = null, retireSource = true, projectDir = process.cwd() }) {
  if (retireSource !== true) throw fail('CHECKPOINT_MOVE_REQUIRED', 'The CLI moves one retained device; enroll a different device for another active participant.');
  nonConflicting([devicePath, outputPath]);
  const source = resolve(devicePath), destination = resolve(outputPath);
  if (!existsSync(source)) throw fail('checkpoint_device_missing', `Device store not found: ${source}`);
  if (existsSync(destination)) throw fail('CHECKPOINT_OUTPUT_EXISTS', 'Refusing to replace an existing checkpoint.');
  const { DatabaseSync } = await import('node:sqlite');
  let probe;
  try {
    probe = new DatabaseSync(source, { readOnly: true });
    const usage = probe.prepare('SELECT count(*) AS entries, coalesce(sum(length(key)+length(value)),0) AS bytes FROM stored_bytes').get();
    if (usage.entries > 4096 || usage.bytes > 16 * 1024 * 1024)
      throw fail('CHECKPOINT_LIMIT_EXCEEDED', 'Device history exceeds the bounded checkpoint limit; the original store was preserved.');
    if (!probe.prepare('SELECT 1 FROM stored_bytes WHERE key=?').get('peer-session/device/v1'))
      throw fail('CHECKPOINT_IDENTITY_MISSING', 'The selected file contains no retained Chronolog signing identity.');
  } catch (error) {
    if (/locked|busy/iu.test(error.message)) throw fail('BYTES_STORE_IN_USE', 'Stop the original participant before moving its retained device.');
    throw error;
  } finally { probe?.close(); }
  const { kernel, native } = await loadCheckpointLibrary(projectDir);
  // The public native device verifies its key/binding and holds the same
  // cross-process SQLite writer fence as the application participant.
  const device = await native.openNativeDevice({ path: source });
  try {
    if (deviceId !== null && deviceId !== device.identity.publicKey)
      throw fail('CHECKPOINT_IDENTITY_MISMATCH', 'Requested device identity does not match the retained signer.');
    if (device.store.usageBytes() > 16 * 1024 * 1024)
      throw fail('CHECKPOINT_LIMIT_EXCEEDED', 'Device history exceeds the bounded checkpoint limit; the original store was preserved.');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const checkpoint = await kernel.exportDeviceCheckpoint(device.store, {
      secret: secretValue(kernel, secret), applicationId, deviceId: device.identity.publicKey,
      retireSource: true,
      persist: ({ bytes }) => writeNewPrivate(destination, bytes),
    });
    device.store.checkpointWal();
    return { output: destination, size: checkpoint.bytes.byteLength,
      retiredSource: checkpoint.retiredSource, metadata: checkpoint.metadata };
  } finally { await device.close(); }
}

/** Publish a fully verified handoff as one fresh private directory. */
export async function restoreNativeCheckpoint({ inputPath, devicePath, secret, projectDir = process.cwd() }) {
  nonConflicting([inputPath, devicePath]);
  const input = resolve(inputPath), destination = resolve(devicePath), target = dirname(destination);
  if (existsSync(target)) throw fail('CHECKPOINT_TARGET_NOT_EMPTY', 'Restore into a fresh private directory; existing project state is never replaced.');
  if (statSync(input).size > 32 * 1024 * 1024) throw fail('CHECKPOINT_LIMIT_EXCEEDED', 'Encrypted checkpoint exceeds its 32 MiB limit.');
  const { kernel, native } = await loadCheckpointLibrary(projectDir);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(target), '.checkpoint-restore-'));
  const stagedDevice = join(staging, basename(destination));
  let store, verification, published = false;
  try {
    store = new native.NativeBytesStore(stagedDevice);
    const restored = await kernel.restoreDeviceCheckpoint(store, new Uint8Array(readFileSync(input)), { secret: secretValue(kernel, secret) });
    if (restored.outbox.length) throw fail('CHECKPOINT_EXTERNAL_OUTBOX', 'Restore the application-owned outbox through its own verified host adapter.');
    if (restored.sqlDatabaseBytes !== null)
      throw fail('CHECKPOINT_APP_RESTORE_REQUIRED', 'This checkpoint includes external SQL bytes. Use its application-owned restore adapter; the CLI restores canonical device history and rebuilds derived materialization.');
    store.checkpointWal(); store.close(); store = undefined;
    verification = await native.openNativeDevice({ path: stagedDevice });
    if (restored.metadata.deviceId !== null && verification.identity.publicKey !== restored.metadata.deviceId)
      throw fail('CHECKPOINT_IDENTITY_MISMATCH', 'Restored signing identity does not match the authenticated checkpoint metadata.');
    await verification.close(); verification = undefined;
    syncDirectory(staging);
    if (existsSync(target)) throw fail('CHECKPOINT_TARGET_NOT_EMPTY', 'The target appeared during restore; no existing state was replaced.');
    renameSync(staging, target); published = true; syncDirectory(dirname(target));
    return { devicePath: destination, materialization: 'rebuild-on-open',
      restoredEntries: restored.restoredEntries, metadata: restored.metadata };
  } finally {
    try { await verification?.close(); } finally {
      store?.close();
      if (!published) rmSync(staging, { recursive: true, force: true });
    }
  }
}
