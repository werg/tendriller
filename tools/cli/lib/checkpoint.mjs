// Workspace checkpoint: move one stopped agent workspace's private state as a single
// authenticated, encrypted file. Every device (the shared signer and each page store)
// travels as its own Chronolog device checkpoint; the outer file is a Chronolog
// checkpoint too, so this module holds no cryptography of its own.
//
//   export: fence the agent program, open every device, snapshot (no retirement),
//           durably write the file, mark the workspace retired, then retire each
//           device only if its history still matches the snapshot.
//   restore: authenticate the file, rebuild .tendriller/ and tendriller.json in a
//           staging folder, reopen every device with the restored signer, publish.
//
// Page source (pages/, shared/, package.json) is not private state: use
// `tendril handoff source` for it.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { openWorkspace, workspacePaths, WORKSPACE_FILE } from './workspace.mjs';

export const CHECKPOINT_FORMAT = 'tendriller-workspace-checkpoint-v1';
const MANIFEST_KEY = 'tendriller/workspace-checkpoint/v1';
const CONFIG_KEY = 'workspace/tendriller.json';
const CREDENTIAL_KEY = 'agent/credential.json';
const IDENTITY_KEY = 'agent/identity.clcp';
const MiB = 1024 * 1024;
// Each device is bounded on its own; the whole file is bounded again.
const DEVICE_LIMITS = Object.freeze({ maxEntries: 16384, maxBytes: 16 * MiB, maxValueBytes: 4 * MiB });
const WORKSPACE_LIMITS = Object.freeze({ maxEntries: 65536, maxBytes: 128 * MiB, maxValueBytes: 32 * MiB });
const MAX_FILE_BYTES = 192 * MiB, MAX_RECORD_BYTES = 1 * MiB, MAX_DATABASE_BYTES = 16 * MiB, MAX_PAGES = 256;
const PAGE_ID = /^[a-z2-7]{12}$/u, HEX64 = /^[a-f0-9]{64}$/u, RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SIDECAR = /-(?:wal|shm|journal)$/u;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');

/**
 * The outer file is a Chronolog checkpoint of an in-memory store. The pinned public session
 * exports no in-memory store, so this implements only the documented public `BytesStore`
 * contract (atomic replace, deterministic enumeration, empty-store initialization).
 */
class ContainerStore {
  #values = new Map();
  async get(key) { return this.#values.get(key)?.slice() ?? null; }
  async put(key, bytes) { this.#values.set(key, bytes.slice()); }
  async putMany(entries) { for (const { key, value } of entries) this.#values.set(key, value.slice()); }
  async delete(key) { this.#values.delete(key); }
  async entries() { return [...this.#values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => ({ key, value: value.slice() })); }
  async *iterateEntries() { yield* await this.entries(); }
  async putAllIfEmpty(entries) { if (this.#values.size) return false; await this.putMany(entries); return true; }
  async putStreamIfEmpty(entries) {
    if (this.#values.size) return false;
    const staged = [];
    for await (const entry of entries) staged.push(entry);
    await this.putMany(staged); return true;
  }
}

async function chronolog() {
  const [kernel, native] = await Promise.all([import('@chronolog/peer-session'), import('@chronolog/peer-session/native')]);
  if (typeof kernel.exportDeviceCheckpoint !== 'function' || typeof kernel.restoreDeviceCheckpoint !== 'function' ||
      typeof native.NativeBytesStore?.open !== 'function')
    throw fail('CHECKPOINT_LIBRARY_UNSUPPORTED', 'Install the matching Chronolog session with device checkpoints.');
  return { kernel, native };
}
const secretValue = (kernel, secret) => {
  if (typeof secret !== 'string' || !secret) throw fail('CHECKPOINT_SECRET_REQUIRED', 'Supply the checkpoint secret (64-hex key or a passphrase of at least 12 characters).', { exit: 64 });
  return /^[a-f0-9]{64}$/iu.test(secret) ? kernel.decodeCheckpointKeyHex(secret) : secret;
};
const inUse = error => error?.code === 'BYTES_STORE_IN_USE' || error?.message === 'BYTES_STORE_IN_USE' || /locked|busy/iu.test(error?.message ?? '')
  ? fail('BYTES_STORE_IN_USE', 'A workspace device is open in another process. Stop every process using this workspace (tendril agent run, page init scripts), then export again. Nothing was exported or retired.', { cause: error })
  : error;

function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === 'win32' && ['EACCES', 'EPERM', 'EISDIR', 'EINVAL'].includes(error.code))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Create one new private file and make it durable; never replaces an existing path. */
function writeNewPrivate(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  catch (error) { closeSync(fd); rmSync(path, { force: true }); throw error; }
  closeSync(fd);
  syncDirectory(dirname(path));
}

// Run every cleanup; keep the operational failure and the first distinct cleanup error.
async function cleanup(failure, callbacks) {
  for (const callback of callbacks) {
    try { await callback(); }
    catch (error) {
      if (!failure) failure = error;
      else if (error !== failure) {
        if (!(failure instanceof Error) || !Object.isExtensible(failure)) failure = new Error('Checkpoint action failed', { cause: failure });
        failure.cleanupError ??= error;
      }
    }
  }
  return failure;
}

/** Hold the same owner lock and fence `tendril agent run` takes, so it cannot run during export. */
async function fenceAgentProgram(paths) {
  const { acquireAtomicLock, ensurePrivateDirectory } = await import('@tendriller/core/ipc');
  const running = cause => fail('AGENT_PROGRAM_RUNNING',
    'tendril agent run is running for this workspace. Stop it (Ctrl-C or SIGTERM), then export again. Nothing was exported or retired.', { cause, exit: 75 });
  await ensurePrivateDirectory(paths.owner, true);
  let lock, database;
  try { lock = await acquireAtomicLock(paths.owner); }
  catch (error) { throw ['OWNER_BUSY', 'INSTANCE_UNRESPONSIVE'].includes(error?.code) ? running(error) : error; }
  try {
    const fence = join(paths.owner, 'owner.sqlite');
    if (existsSync(fence)) {
      const { DatabaseSync } = await import('node:sqlite');
      try {
        database = new DatabaseSync(fence);
        database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_fence(id INTEGER PRIMARY KEY)');
      } catch (error) {
        try { database?.close(); } catch {}
        throw /locked|busy/iu.test(error?.message ?? '') ? running(error) : error;
      }
    }
  } catch (error) { await lock.release(); throw error; }
  return async () => { try { database?.close(); } finally { await lock.release(); } };
}

/** A consistent snapshot of a non-device SQLite file (for example an effect journal). */
async function snapshotDatabase(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const scratch = mkdtempSync(join(tmpdir(), 'tendril-checkpoint-'));
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA busy_timeout=0');
    const copy = join(scratch, 'snapshot.sqlite');
    database.prepare('VACUUM INTO ?').run(copy);
    const bytes = readFileSync(copy);
    if (bytes.byteLength > MAX_DATABASE_BYTES) throw fail('CHECKPOINT_LIMIT_EXCEEDED', `${path} exceeds the ${MAX_DATABASE_BYTES / MiB} MiB database bound; nothing was exported or retired.`);
    return bytes;
  } catch (error) { throw inUse(error); }
  finally { try { database?.close(); } finally { rmSync(scratch, { recursive: true, force: true }); } }
}

/** Classify one page folder: its device store, private records and other SQLite files. */
function scanPage(directory) {
  const page = { device: false, records: [], databases: [] };
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const where = join(directory, entry.name);
    if (!entry.isFile() || !RECORD_NAME.test(entry.name))
      throw fail('CHECKPOINT_UNSUPPORTED_ENTRY', `${where} is not a plain private file. Move it out of .tendriller/pages/, then export again. Nothing was exported or retired.`);
    if (entry.name === 'device.sqlite') { page.device = true; continue; }
    if (SIDECAR.test(entry.name)) continue; // committed through its own database connection
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const fd = openSync(where, 'r');
    try { header.fill(0); readSync(fd, header); } finally { closeSync(fd); }
    if (header.equals(SQLITE_MAGIC)) page.databases.push(entry.name);
    else {
      if (statSync(where).size > MAX_RECORD_BYTES) throw fail('CHECKPOINT_LIMIT_EXCEEDED', `${where} exceeds the 1 MiB private record bound; nothing was exported or retired.`);
      page.records.push(entry.name);
    }
  }
  return page;
}
/**
 * Move this workspace's private state into one encrypted file. Requires the agent
 * program and every other device user to be stopped. After the file is durable the
 * source workspace is retired: its signer and page devices no longer open here.
 */
export async function exportWorkspaceCheckpoint({ root, outputPath, secret }) {
  const workspace = await openWorkspace({ root });
  const { paths, config } = workspace;
  const destination = resolve(outputPath ?? '');
  if (!outputPath) throw fail('CHECKPOINT_OUTPUT_REQUIRED', 'Name the checkpoint file to create.', { exit: 64 });
  if (!relative(paths.secret, destination).startsWith('..')) throw fail('CHECKPOINT_PATH_CONFLICT', 'Write the checkpoint outside .tendriller/.', { exit: 64 });
  if (existsSync(destination)) throw fail('CHECKPOINT_OUTPUT_EXISTS', 'Refusing to replace an existing checkpoint.', { exit: 64 });
  const { kernel, native } = await chronolog();
  const userSecret = secretValue(kernel, secret);
  const credential = await workspace.credential();
  if (!HEX64.test(credential.publicKey ?? '')) throw fail('workspace_state_invalid', 'The agent credential lacks its registered public key.');
  const pageIds = existsSync(paths.pages) ? readdirSync(paths.pages, { withFileTypes: true }).map(entry => {
    if (!entry.isDirectory() || !PAGE_ID.test(entry.name))
      throw fail('CHECKPOINT_UNSUPPORTED_ENTRY', `${join(paths.pages, entry.name)} is not a page folder. Move it out of .tendriller/pages/, then export again.`);
    return entry.name;
  }).sort() : [];
  if (pageIds.length > MAX_PAGES) throw fail('CHECKPOINT_LIMIT_EXCEEDED', `A workspace checkpoint holds at most ${MAX_PAGES} pages.`);
  for (const { id } of Object.values(config.pages ?? {}))
    if (!pageIds.includes(id)) throw fail('page_state_missing', `.tendriller/pages/${id}/ is missing; restore it before moving this workspace.`);

  const release = await fenceAgentProgram(paths);
  const devices = []; // { label, device, applicationId, exported } per open page device
  let identity, receipt, failure;
  try {
    try { identity = await native.openNativeDevice({ path: paths.identity }); }
    catch (error) { throw inUse(error); }
    if (identity.identity.publicKey !== credential.publicKey)
      throw fail('agent_signer_mismatch', 'identity.sqlite does not hold the registered agent key; nothing was exported.');
    const signer = identity.identity;
    const innerKey = kernel.generateCheckpointKey();
    const snapshot = async (label, device, applicationId) => {
      if (device.store.usageBytes() > DEVICE_LIMITS.maxBytes)
        throw fail('CHECKPOINT_LIMIT_EXCEEDED', `${label} exceeds the ${DEVICE_LIMITS.maxBytes / MiB} MiB device bound; nothing was exported or retired.`);
      // Snapshot only: nothing is retired before the whole workspace file is durable.
      const exported = await kernel.exportDeviceCheckpoint(device.store, { secret: innerKey, limits: DEVICE_LIMITS,
        applicationId, deviceId: signer.publicKey, retireSource: false });
      return { label, device, applicationId, exported };
    };
    const entries = [{ key: CONFIG_KEY, value: readFileSync(paths.config) }, { key: CREDENTIAL_KEY, value: readFileSync(paths.credential) }];
    const agentSnapshot = await snapshot('the agent signer', identity, null);
    entries.push({ key: IDENTITY_KEY, value: agentSnapshot.exported.bytes });
    const pages = [];
    for (const id of pageIds) {
      const directory = join(paths.pages, id), scanned = scanPage(directory);
      const record = existsSync(join(directory, 'page.json')) ? JSON.parse(readFileSync(join(directory, 'page.json'), 'utf8')) : null;
      const applicationId = HEX64.test(record?.application?.id ?? '') ? record.application.id : null;
      let device = null;
      if (scanned.device) {
        let opened;
        try { opened = await native.openNativeDevice({ path: join(directory, 'device.sqlite'), managedSigner: signer }); }
        catch (error) { throw inUse(error); }
        devices.push({ label: `page ${id}`, device: opened });
        const taken = await snapshot(`page ${id}`, opened, applicationId);
        devices[devices.length - 1] = taken;
        entries.push({ key: `pages/${id}/device.clcp`, value: taken.exported.bytes });
        device = { manifestSha256: taken.exported.metadata.manifestSha256, entryCount: taken.exported.metadata.entryCount };
      }
      for (const name of scanned.records) entries.push({ key: `pages/${id}/records/${name}`, value: readFileSync(join(directory, name)) });
      for (const name of scanned.databases) entries.push({ key: `pages/${id}/databases/${name}`, value: await snapshotDatabase(join(directory, name)) });
      pages.push({ id, applicationId, device, records: scanned.records, databases: scanned.databases });
    }
    const manifest = { format: CHECKPOINT_FORMAT, createdAt: new Date().toISOString(), service: config.service,
      agent: config.agent, publicKey: signer.publicKey, innerKey: kernel.encodeCheckpointKeyHex(innerKey),
      identity: { manifestSha256: agentSnapshot.exported.metadata.manifestSha256 }, pages };
    entries.push({ key: MANIFEST_KEY, value: json(manifest) });
    const container = new ContainerStore();
    await container.putMany(entries);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const sealed = await kernel.exportDeviceCheckpoint(container, { secret: userSecret, limits: WORKSPACE_LIMITS,
      applicationId: null, deviceId: signer.publicKey, retireSource: false });
    if (sealed.bytes.byteLength > MAX_FILE_BYTES) throw fail('CHECKPOINT_LIMIT_EXCEEDED', 'The workspace checkpoint exceeds its 192 MiB bound; nothing was exported or retired.');
    writeNewPrivate(destination, sealed.bytes);
    const summary = { output: destination, size: sealed.bytes.byteLength, sha256: sha256Hex(sealed.bytes),
      agent: config.agent, publicKey: signer.publicKey,
      pages: pages.map(page => ({ id: page.id, slug: Object.entries(config.pages ?? {}).find(([, value]) => value.id === page.id)?.[0] ?? null,
        device: Boolean(page.device), records: page.records.length, databases: page.databases })) };
    // From here the file is the workspace. Retire the source before anything else can fail.
    receipt = { ...summary, retiredSource: false, retired: [] };
    writeNewPrivate(paths.retired, json({ retiredAt: new Date().toISOString(), checkpointSha256: summary.sha256,
      next: 'This workspace was moved to a checkpoint. Restore that file with tendril checkpoint restore in an empty folder.' }));
    for (const entry of [...devices, { ...agentSnapshot, label: 'the agent signer' }]) {
      await kernel.exportDeviceCheckpoint(entry.device.store, { secret: innerKey, limits: DEVICE_LIMITS,
        applicationId: entry.applicationId, deviceId: signer.publicKey, retireSource: true,
        persist: ({ metadata }) => {
          if (metadata.manifestSha256 !== entry.exported.metadata.manifestSha256)
            throw fail('CHECKPOINT_SOURCE_CHANGED', `${entry.label} changed after its snapshot; it was not retired.`);
        } });
      receipt.retired.push(entry.label);
    }
    receipt.retiredSource = true;
  } catch (error) {
    failure = error;
  } finally {
    failure = await cleanup(failure, [
      ...devices.map(entry => () => entry.device.close()),
      () => identity?.close(),
      release,
    ]);
  }
  if (failure) {
    if (receipt) {
      if (!(failure instanceof Error) || !Object.isExtensible(failure)) failure = new Error('Checkpoint export failed', { cause: failure });
      failure.checkpoint = { ...receipt,
        nextAction: 'The checkpoint file is complete and is now the workspace. Restore it in an empty folder; do not resume this copy, even where retirement did not finish.' };
    }
    throw failure;
  }
  return { ...receipt,
    next: 'Copy the file and its secret to the new place, then run tendril checkpoint restore FILE in an empty folder there. Move page source separately with tendril handoff source. This workspace is retired and no longer opens.' };
}

function parseJson(bytes, what) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw fail('CHECKPOINT_CORRUPT', `The checkpoint's ${what} is not valid JSON.`); }
}

/** Authenticate the file and check that its parts describe one consistent workspace. */
function readContainer(values) {
  const manifest = parseJson(values.get(MANIFEST_KEY) ?? new Uint8Array(), 'manifest');
  if (manifest?.format !== CHECKPOINT_FORMAT) throw fail('CHECKPOINT_FORMAT_UNSUPPORTED', 'This file is not a Tendriller workspace checkpoint.');
  if (!HEX64.test(manifest.publicKey ?? '') || !HEX64.test(manifest.innerKey ?? '') || !HEX64.test(manifest.identity?.manifestSha256 ?? '') ||
      typeof manifest.service !== 'string' || typeof manifest.agent?.id !== 'string' || !Array.isArray(manifest.pages) || manifest.pages.length > MAX_PAGES)
    throw fail('CHECKPOINT_CORRUPT', 'The checkpoint manifest is malformed.');
  const expected = new Set([MANIFEST_KEY, CONFIG_KEY, CREDENTIAL_KEY, IDENTITY_KEY]), seen = new Set();
  for (const page of manifest.pages) {
    if (!PAGE_ID.test(page?.id ?? '') || seen.has(page.id) || !Array.isArray(page.records) || !Array.isArray(page.databases) ||
        [...page.records, ...page.databases].some(name => typeof name !== 'string' || !RECORD_NAME.test(name) || name === 'device.sqlite') ||
        new Set([...page.records, ...page.databases]).size !== page.records.length + page.databases.length ||
        (page.device !== null && !HEX64.test(page.device?.manifestSha256 ?? '')) || (page.applicationId !== null && !HEX64.test(page.applicationId ?? '')))
      throw fail('CHECKPOINT_CORRUPT', 'The checkpoint manifest names an invalid page.');
    seen.add(page.id);
    if (page.device) expected.add(`pages/${page.id}/device.clcp`);
    for (const name of page.records) expected.add(`pages/${page.id}/records/${name}`);
    for (const name of page.databases) expected.add(`pages/${page.id}/databases/${name}`);
  }
  if (values.size !== expected.size || [...values.keys()].some(key => !expected.has(key)))
    throw fail('CHECKPOINT_CORRUPT', 'The checkpoint contents do not match its manifest.');
  const config = parseJson(values.get(CONFIG_KEY), WORKSPACE_FILE), credential = parseJson(values.get(CREDENTIAL_KEY), 'agent credential');
  if (config?.schemaVersion !== 1 || config.service !== manifest.service || config.agent?.id !== manifest.agent.id ||
      Object.values(config.pages ?? {}).some(entry => !seen.has(entry?.id)))
    throw fail('CHECKPOINT_CORRUPT', `The checkpoint's ${WORKSPACE_FILE} does not match its manifest.`);
  if (credential?.service !== config.service || credential.agent?.id !== config.agent.id || credential.publicKey !== manifest.publicKey ||
      !/^ta_[a-z2-7]{32}$/u.test(credential.token ?? ''))
    throw fail('agent_signer_mismatch', 'The checkpoint credential does not belong to its agent key.');
  return { manifest, config };
}

/**
 * Recreate a workspace's private state from a checkpoint in an empty folder.
 * Nothing becomes visible until every device opens with the restored signer.
 */
export async function restoreWorkspaceCheckpoint({ root, inputPath, secret }) {
  const target = resolve(root), input = resolve(inputPath ?? '');
  if (!inputPath) throw fail('CHECKPOINT_INPUT_REQUIRED', 'Name the checkpoint file to restore.', { exit: 64 });
  // The folder may hold the checkpoint file itself; nothing else is ever replaced.
  const occupants = () => existsSync(target) ? readdirSync(target).filter(name => join(target, name) !== input) : [];
  if (existsSync(target) && !lstatSync(target).isDirectory()) throw fail('CHECKPOINT_TARGET_NOT_EMPTY', `${target} is not a folder.`, { exit: 64 });
  if (occupants().length) throw fail('CHECKPOINT_TARGET_NOT_EMPTY', `Restore into an empty folder; ${target} already holds files. Nothing was replaced.`, { exit: 64 });
  const size = statSync(input).size;
  if (size > MAX_FILE_BYTES) throw fail('CHECKPOINT_LIMIT_EXCEEDED', 'The checkpoint exceeds its 192 MiB bound.');
  const { kernel, native } = await chronolog();
  const container = new ContainerStore();
  const sealed = await kernel.restoreDeviceCheckpoint(container, new Uint8Array(readFileSync(input)), { secret: secretValue(kernel, secret), limits: WORKSPACE_LIMITS });
  const values = new Map((await container.entries()).map(entry => [entry.key, entry.value]));
  const { manifest, config } = readContainer(values);
  if (sealed.metadata.deviceId !== manifest.publicKey) throw fail('CHECKPOINT_IDENTITY_MISMATCH', 'The checkpoint was not sealed for its agent key.');
  const innerKey = kernel.decodeCheckpointKeyHex(manifest.innerKey);

  const createdTarget = !existsSync(target);
  mkdirSync(target, { recursive: true });
  const staging = mkdtempSync(join(target, '.checkpoint-restore-'));
  const staged = workspacePaths(staging);
  const open = [];
  let result, failure, published = false;
  const restoreDevice = async (path, bytes, expected) => {
    const store = await native.NativeBytesStore.open(path);
    open.push(store);
    const restored = await kernel.restoreDeviceCheckpoint(store, bytes, { secret: innerKey, limits: DEVICE_LIMITS });
    if (restored.metadata.manifestSha256 !== expected || restored.metadata.deviceId !== manifest.publicKey ||
        restored.outbox.length || restored.sqlDatabaseBytes !== null)
      throw fail('CHECKPOINT_CORRUPT', `${basename(dirname(path))}/${basename(path)} does not match the checkpoint manifest.`);
    await store.checkpointWal(); await store.close(); open.splice(open.indexOf(store), 1);
    return restored;
  };
  const verify = async options => {
    const device = await native.openNativeDevice(options);
    try {
      if (device.identity.publicKey !== manifest.publicKey) throw fail('agent_signer_mismatch', 'A restored device does not use the registered agent key.');
      return device.identity;
    } finally { await device.close(); }
  };
  try {
    mkdirSync(staged.agent, { recursive: true, mode: 0o700 });
    mkdirSync(staged.pages, { recursive: true, mode: 0o700 });
    await restoreDevice(staged.identity, values.get(IDENTITY_KEY), manifest.identity.manifestSha256);
    const signer = await verify({ path: staged.identity });
    writeNewPrivate(staged.credential, values.get(CREDENTIAL_KEY));
    const pages = [];
    for (const page of manifest.pages) {
      const directory = join(staged.pages, page.id);
      mkdirSync(directory, { mode: 0o700 });
      for (const name of page.records) writeNewPrivate(join(directory, name), values.get(`pages/${page.id}/records/${name}`));
      for (const name of page.databases) writeNewPrivate(join(directory, name), values.get(`pages/${page.id}/databases/${name}`));
      if (page.device) {
        const path = join(directory, 'device.sqlite');
        await restoreDevice(path, values.get(`pages/${page.id}/device.clcp`), page.device.manifestSha256);
        await verify({ path, managedSigner: signer });
      }
      syncDirectory(directory);
      pages.push({ id: page.id, slug: Object.entries(config.pages ?? {}).find(([, value]) => value.id === page.id)?.[0] ?? null,
        device: Boolean(page.device), records: page.records.length, databases: page.databases });
    }
    writeNewPrivate(join(staging, WORKSPACE_FILE), values.get(CONFIG_KEY));
    for (const path of [staged.agent, staged.pages, staged.secret]) syncDirectory(path);
    if (occupants().filter(name => name !== basename(staging)).length)
      throw fail('CHECKPOINT_TARGET_NOT_EMPTY', 'Files appeared in the target during restore; nothing was replaced.');
    renameSync(staged.secret, join(target, '.tendriller'));
    // tendriller.json last: the folder becomes a workspace only once its private state is in place.
    renameSync(join(staging, WORKSPACE_FILE), join(target, WORKSPACE_FILE));
    published = true;
    rmSync(staging, { recursive: true, force: true });
    try { writeFileSync(join(target, '.gitignore'), '.tendriller/\n', { flag: 'wx' }); } catch {}
    syncDirectory(target);
    result = { workspace: target, service: config.service, agent: config.agent, publicKey: signer.publicKey, pages,
      materialization: 'rebuild-on-open',
      next: 'Private state only: restore page source here (unpack the tendril handoff source archive, or copy pages/, shared/ and package.json), run npm ci, then tendril agent run. Run only this copy of the workspace.' };
  } catch (error) {
    failure = error;
  } finally {
    failure = await cleanup(failure, [
      ...open.map(store => () => store.close()),
      () => { if (!published) rmSync(staging, { recursive: true, force: true }); },
      () => { if (!published && createdTarget && !readdirSync(target).length) rmSync(target, { recursive: true }); },
    ]);
  }
  if (failure) throw failure;
  return result;
}
