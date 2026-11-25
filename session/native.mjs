import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { serialize } from 'node:v8';
import { MessageChannel } from 'node:worker_threads';
import { canonicalJson, identifier, PUBLICATION_LIMITS } from '@chronolog/peer-session';
import { createNativeFrames as frames } from './native-transport.mjs';
import { transportCauseSummary } from './transport-causes.mjs';
import { acquireAtomicLock, connectLocalIpc, ensurePrivateDirectory, isWindows, listenLocalIpc, readPrivateJson, writePrivateJsonAtomic } from './ipc.mjs';

const PROTOCOL = 'tendriller.native-owner.v1';
const KEY = /^td_n_[a-f0-9]{64}$/u;
const PUBLICATION_SLICE = 512 * 1024;
const PUBLICATION_STAGE_BYTES = 12_000_000;
const CONTROL_TIMEOUT_MS = 30_000;
const publicationAsset = (hash, bytes) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash) &&
  typeof bytes === 'string' && bytes.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(bytes);
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const digest = token => createHash('sha256').update(token).digest('hex');
const bounded = (value, fallback, maximum) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw failure('SUPERVISOR_LIMIT_INVALID');
  return result;
};
const identity = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) throw failure('SUPERVISOR_ID_INVALID');
  return value;
};
export const createNativeAttachmentKey = () => 'td_n_' + randomBytes(32).toString('hex');

async function privatePath(path, kind, mode) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : kind === 'socket' ? !stat.isSocket() : !stat.isFile()) ||
      (!isWindows() && (process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode)))
    throw failure('SUPERVISOR_PRIVATE_PATH_REQUIRED', `Use an owned ${kind} with mode ${mode.toString(8)}: ${path}`);
  return stat;
}
async function directory(path, create = false) {
  return ensurePrivateDirectory(path, create);
}
async function retainedJSON(root, name, maximum = 131072) {
  const path = join(root, name);
  try {
    const info = await privatePath(path, 'file', 0o600);
    if (info.size > maximum) throw failure('SUPERVISOR_METADATA_LIMIT');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** A lightweight, kernel-released profile fence, independent of lazy application data. */
async function ownerFence(root) {
  const path = join(root, 'owner.sqlite');
  try { const file = await open(path, 'wx', 0o600); await file.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await privatePath(path, 'file', 0o600);
  const { DatabaseSync } = await import('node:sqlite');
  let database;
  try {
    database = new DatabaseSync(path);
    database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_fence(id INTEGER PRIMARY KEY)');
    return () => database.close();
  } catch (error) {
    try { database?.close(); } catch {}
    if (/locked|busy/iu.test(error.message)) throw failure('OWNER_BUSY', 'This retained profile already has a live supervisor. Attach to it.');
    throw error;
  }
}

function checkedPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('SUPERVISOR_POLICY_INVALID');
  if (Object.keys(value).some(key => !['capabilities', 'commands', 'queries', 'context', 'contextEvidence', 'identity', 'maxRequests', 'maxStreams', 'maxViews', 'preserveOperationId'].includes(key)))
    throw failure('SUPERVISOR_POLICY_INVALID');
  if (serialize(value).length > 16384) throw failure('SUPERVISOR_POLICY_LIMIT');
  const capabilities = ['commands', 'queries', 'events', 'content', 'signals', 'operations', 'diagnostics', 'ownerAdmin', 'publish'];
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.some(item => !capabilities.includes(item))) ||
      [value.commands, value.queries].some(items => items !== undefined && (!Array.isArray(items) || items.length > 128 ||
        items.some(item => typeof item !== 'string' || !item.length || item.length > 128))) ||
      value.contextEvidence !== undefined && !['caller-asserted', 'owner-validated'].includes(value.contextEvidence) ||
      value.preserveOperationId !== undefined && typeof value.preserveOperationId !== 'boolean')
    throw failure('SUPERVISOR_POLICY_INVALID');
  for (const [field, keys] of [['context', ['viewId', 'documentPath', 'publicationId', 'runId']], ['identity', ['principalId', 'agentBindingId', 'deviceProfileId']]]) {
    const fields = value[field];
    if (fields !== undefined && (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.entries(fields).some(([key, item]) =>
      !keys.includes(key) || typeof item !== 'string' || !item.length || item.length > (key === 'documentPath' ? 1024 : 128) || /[\u0000-\u001f]/u.test(item))))
      throw failure('SUPERVISOR_POLICY_INVALID');
  }
  bounded(value.maxRequests, 16, 64); bounded(value.maxStreams, 8, 16); bounded(value.maxViews, 8, 32);
  return structuredClone(value);
}

function scopedOperationId(applicationId, bindingId, value, publication = false) {
  // Publication identities have a 128-character wire limit. Preserve existing
  // command identities and give publications a distinct deterministic scope.
  const binding = digest(applicationId + ':' + bindingId);
  const prefix = publication ? 'nativepub_' + binding.slice(0, 32) + '_' : 'native_' + binding + '_';
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw failure('OPERATION_ID_INVALID');
  if (value.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(value.slice(prefix.length))) return value;
  if (value.startsWith('native_') || value.startsWith('nativepub_')) throw failure('OPERATION_BINDING_MISMATCH');
  return prefix + digest(value);
}
function scopedOperations(frame, applicationId, bindingId, signer, policy) {
  if (!frame || typeof frame !== 'object' || !Array.isArray(frame.args)) return frame;
  if (frame.method === 'resume' && !policy.capabilities?.includes('ownerAdmin')) throw failure('APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED');
  if (policy.preserveOperationId === true) return frame;
  const operation = value => scopedOperationId(applicationId, bindingId, value);
  const args = [...frame.args];
  if (frame.method === 'command') args[2] = { ...args[2], operationId: operation(args[2]?.operationId) };
  else if (frame.method === 'reapply') {
    if (!args[3]?.originalAuthor || args[3].originalAuthor === signer) args[0] = operation(args[0]);
    args[3] = { ...args[3], operationId: operation(args[3]?.operationId) };
  } else if (frame.method === 'retry' || frame.method.startsWith('operation.')) {
    if (!args[1]?.author || args[1].author === signer) args[0] = operation(args[0]);
  }
  return { ...frame, args };
}

/** One process owns the signer; independently authenticated clients only attach.
 * openOwner runs AFTER the exclusive profile fence has been acquired.
 * Supports Unix sockets (Linux/macOS), Windows named pipes, and loopback TCP fallback. */
export async function createNativeSessionSupervisor({ directory: path, profileId, openOwner, bindings = [], maxClients = 32,
  maxClientsPerBinding = 4, maxBindings = 32, handshakeTimeoutMs = 3000, preferredTransport = 'auto', signal } = {}) {
  signal?.throwIfAborted(); identity(profileId);
  if (typeof openOwner !== 'function') throw failure('SUPERVISOR_OWNER_FACTORY_REQUIRED');
  maxClients = bounded(maxClients, 32, 128); maxBindings = bounded(maxBindings, 32, 128);
  maxClientsPerBinding = bounded(maxClientsPerBinding, 4, 8);
  handshakeTimeoutMs = bounded(handshakeTimeoutMs, 3000, 30000);
  const root = await directory(path, true), lock = await acquireAtomicLock(root);
  let releaseFence;
  try { releaseFence = await ownerFence(root); }
  catch (error) { await lock.release(); throw error; }
  const clients = new Set();
  let closeWhenIdle = false;
  let owner, listener, records = new Map(), stopped = false, closing, changes = Promise.resolve();
  const terminateClient = client => { client.detach?.(); client.detach = undefined; client.port?.close(); client.socket.destroy(); };
  const close = () => closing ??= (async () => {
    stopped = true; signal?.removeEventListener('abort', abort);
    owner?.session?.signal?.removeEventListener('abort', abort);
    for (const client of clients) terminateClient(client);
    await changes.catch(() => {});
    if (listener) await listener.close().catch(() => {});
    try { await owner?.close(); }
    finally {
      try { releaseFence(); }
      finally { await lock.release(); }
    }
  })();
  const abort = () => { void close().catch(() => {}); };
  const persist = next => writePrivateJsonAtomic(root, 'bindings.json', { version: 1, profileId, bindings: [...next.values()] });
  const mutate = work => {
    const pending = changes.then(async () => {
      if (stopped) throw failure('OWNER_UNREACHABLE');
      const next = new Map([...records].map(([id, row]) => [id, structuredClone(row)]));
      const result = work(next); await persist(next); records = next;
      for (const client of clients) {
        const row = client.bindingId && records.get(client.bindingId);
        if (client.bindingId && (!row?.active || row.revision !== client.revision)) terminateClient(client);
      }
      return result;
    });
    changes = pending.catch(() => {}); return pending;
  };
  try {
    const retained = await retainedJSON(root, 'bindings.json');
    if (retained && (retained.version !== 1 || retained.profileId !== profileId || !Array.isArray(retained.bindings) || retained.bindings.length > maxBindings))
      throw failure('SUPERVISOR_BINDINGS_INVALID');
    for (const row of retained?.bindings ?? []) {
      identity(row.id);
      if (!/^[a-f0-9]{64}$/u.test(row.hash) || typeof row.active !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 1 || records.has(row.id))
        throw failure('SUPERVISOR_BINDINGS_INVALID');
      records.set(row.id, { ...row, policy: checkedPolicy(row.policy) });
    }
    for (const value of bindings) {
      identity(value.id);
      if (!KEY.test(value.token)) throw failure('SUPERVISOR_CREDENTIAL_INVALID');
      const row = { id: value.id, hash: digest(value.token), active: true, revision: 1, policy: checkedPolicy(value.policy) }, prior = records.get(value.id);
      if (prior && (prior.hash !== row.hash || JSON.stringify(prior.policy) !== JSON.stringify(row.policy) || !prior.active))
        throw failure('SUPERVISOR_BINDING_CHANGED', 'Use the retained binding configuration; startup never silently reauthorizes revoked credentials.');
      if (!prior) records.set(row.id, row);
    }
    if (records.size > maxBindings) throw failure('SUPERVISOR_BINDING_LIMIT');
    await persist(records);
    owner = await openOwner({ signal, profileId });
    if (!owner?.session || typeof owner.attach !== 'function' || typeof owner.close !== 'function') throw failure('SUPERVISOR_OWNER_INVALID');
    owner.session.signal?.throwIfAborted();
    owner.session.signal?.addEventListener('abort', abort, { once: true });
    const description = owner.session.describe();
    const profile = { version: 1, profileId, applicationId: owner.session.applicationId, deviceId: owner.session.deviceId,
      definitionId: description.id, definitionVersion: description.version };
    const previous = await retainedJSON(root, 'profile.json', 4096);
    if (previous && JSON.stringify(previous) !== JSON.stringify(profile)) throw failure('SUPERVISOR_PROFILE_CHANGED', 'Resume the original signer and immutable definition; enroll another profile explicitly.');
    if (!previous) await writePrivateJsonAtomic(root, 'profile.json', profile);
    const onConnection = socket => {
      if (stopped || clients.size >= maxClients) { socket.destroy(); return; }
      const client = { socket, bindingId: null, revision: null, detach: undefined, port: undefined, snapshot: null, failed: false, stagedAssets: new Map(), stagedBytes: 0, controlRequests: 0 };
      clients.add(client);
      const timer = setTimeout(() => terminateClient(client), handshakeTimeoutMs);
      const controlAllowed = binding => binding.policy.capabilities?.includes('publish') ||
        binding.policy.capabilities?.includes('ownerAdmin');
      const discardStage = stageId => {
        const stage = client.stagedAssets.get(stageId);
        if (stage) { client.stagedBytes -= stage.bytes; client.stagedAssets.delete(stageId); }
        return stage;
      };
      const handleControl = async (frame, binding) => {
        const sendReply = reply => {
          if (!client.failed && !socket.destroyed) {
            try { transport.send({ type: 'control-reply', id: frame.id, ...reply }); }
            catch { terminateClient(client); }
          }
        };
        if (client.controlRequests >= (binding.policy.maxRequests ?? 16)) {
          sendReply({ error: { code: 'APPLICATION_ATTACHMENT_REQUEST_LIMIT', message: 'Too many outstanding control requests' } });
          return;
        }
        ++client.controlRequests;
        try {
          if (!controlAllowed(binding)) throw failure('APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED',
            'This native binding needs explicit publish or ownerAdmin capability. The owner can create a scoped publication binding; retained bindings are never silently elevated.');
          const control = owner.control;
          if (!control) throw failure('CONTROL_PARTICIPANT_UNAVAILABLE', 'This running owner did not expose a control participant for attached publishing.');
          const { method, args = [] } = frame;
          const operation = value => binding.policy.preserveOperationId === true ? value :
            scopedOperationId(profile.applicationId, binding.id, value, true);
          const checkedPublication = publication => {
            const operationId = publication?.payload?.operationId;
            if (operation(operationId) !== operationId) throw failure('OPERATION_BINDING_MISMATCH');
            return publication;
          };
          let value;
          if (method === 'definition') value = await control.definition();
          else if (method === 'publication') value = await control.publication();
          else if (method === 'publicationOperation') value = typeof control.publicationOperation === 'function' ? await control.publicationOperation(operation(args[0])) : (() => { throw failure('publication_inspection_unsupported', 'The installed Chronolog package cannot inspect retained publication receipts.'); })();
          else if (method === 'preparePublication') value = await control.preparePublication({ ...args[0], operationId: operation(args[0]?.operationId) });
          else if (method === 'publish') {
            const publication = checkedPublication(args[0]), assets = args[1];
            if (!Array.isArray(assets) || assets.length > PUBLICATION_LIMITS.files ||
                assets.some(asset => !publicationAsset(asset?.hash, asset?.bytes)))
              throw failure('SUPERVISOR_PROTOCOL_INVALID');
            value = await control.publish(publication, assets);
          } else if (method === 'publishStage') {
            const [stageId, hash, slice, done] = args;
            if (typeof stageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(stageId) ||
                !publicationAsset(hash, slice) || typeof done !== 'boolean' ||
                slice.length > PUBLICATION_SLICE || (!done && (slice.length !== PUBLICATION_SLICE || slice.includes('='))))
              throw failure('SUPERVISOR_PROTOCOL_INVALID');
            let stage = client.stagedAssets.get(stageId);
            if (!stage) {
              if (client.stagedAssets.size >= 4) throw failure('APPLICATION_ATTACHMENT_REQUEST_LIMIT');
              client.stagedAssets.set(stageId, stage = { assets: new Map(), bytes: 0 });
            }
            let asset = stage.assets.get(hash);
            if (asset?.done || (!asset && stage.assets.size >= PUBLICATION_LIMITS.files))
              throw failure('SUPERVISOR_PROTOCOL_INVALID');
            if (client.stagedBytes + slice.length > PUBLICATION_STAGE_BYTES) throw failure('PEER_PUBLICATION_TOO_LARGE');
            if (!asset) stage.assets.set(hash, asset = { parts: [], done: false });
            asset.parts.push(slice); asset.done = done;
            stage.bytes += slice.length; client.stagedBytes += slice.length;
            value = { staged: true, done };
          } else if (method === 'publishCommit') {
            const [stageId, publication] = args, stage = discardStage(stageId);
            if (!stage || [...stage.assets.values()].some(asset => !asset.done)) throw failure('SUPERVISOR_PROTOCOL_INVALID');
            const assets = [...stage.assets.entries()].map(([hash, asset]) => ({ hash, bytes: asset.parts.join('') }));
            value = await control.publish(checkedPublication(publication), assets);
          } else if (method === 'publishAbort') {
            discardStage(args[0]); value = { aborted: true };
          } else throw failure('SUPERVISOR_CONTROL_METHOD_UNKNOWN');
          sendReply({ value });
        } catch (error) {
          if (frame.method === 'publishStage' || frame.method === 'publishCommit') discardStage(frame.args[0]);
          sendReply({ error: {
            name: error?.name ?? 'Error', message: error?.message ?? String(error),
            code: error?.code, status: error?.status, outcome: error?.outcome, phase: error?.phase, receipt: error?.receipt,
            operationId: error?.operationId, publicationId: error?.publicationId,
            transportCauses: transportCauseSummary(error),
          } });
        } finally { --client.controlRequests; }
      };
      const transport = frames(socket, frame => {
        if (!frame || typeof frame !== 'object') throw failure('SUPERVISOR_PROTOCOL_INVALID');
        if (!client.bindingId) {
          if (frame.type !== 'attach' || frame.protocol !== PROTOCOL || typeof frame.token !== 'string' || !KEY.test(frame.token) ||
              serialize(frame).length > 16384) throw failure('SUPERVISOR_AUTHENTICATION_REQUIRED');
          if (listener && !listener.verifyLoopbackToken(frame.loopbackToken)) throw failure('SUPERVISOR_AUTHENTICATION_REQUIRED');
          const hash = Buffer.from(digest(frame.token), 'hex');
          const binding = [...records.values()].find(row => row.active && timingSafeEqual(Buffer.from(row.hash, 'hex'), hash));
          if (!binding) throw failure('SUPERVISOR_BINDING_REVOKED');
          if ([...clients].filter(value => value.bindingId === binding.id).length >= maxClientsPerBinding) throw failure('SUPERVISOR_BINDING_CAPACITY');
          client.bindingId = binding.id; client.revision = binding.revision; clearTimeout(timer);
          const channel = new MessageChannel(), endpoint = Object.assign(new EventTarget(), { postMessage() {} });
          client.port = channel.port2;
          channel.port2.addEventListener('message', event => {
            if (client.failed) return;
            const snapshot = event.data?.ready ?? event.data?.snapshot;
            if (snapshot) client.snapshot = { status: snapshot.status, revision: snapshot.revision, participation: snapshot.participation };
            try { transport.send({ type: 'frame', value: event.data }); } catch { terminateClient(client); }
          });
          channel.port2.addEventListener('close', () => { if (!client.failed) socket.end(); });
          channel.port2.start();
          // Publication is a supervisor-owned capability, not a Chronolog owner RPC.
          const applicationPolicy = { ...binding.policy,
            ...(binding.policy.capabilities ? { capabilities: binding.policy.capabilities.filter(value => value !== 'publish') } : {}) };
          client.detach = owner.attach(endpoint, { ...applicationPolicy, identity: {
            ...binding.policy.identity, deviceProfileId: profileId, agentBindingId: binding.id,
          } });
          endpoint.dispatchEvent(new MessageEvent('message', { data: { protocol: frame.ownerProtocol, handshake: frame.handshake, port: channel.port1 } }));
        } else {
          const current = records.get(client.bindingId);
          if (!current?.active || current.revision !== client.revision) throw failure('SUPERVISOR_BINDING_REVOKED');
          if (frame.type === 'control') {
            if (!Number.isSafeInteger(frame.id) || frame.id < 1 || typeof frame.method !== 'string' || !Array.isArray(frame.args)) throw failure('SUPERVISOR_PROTOCOL_INVALID');
            void handleControl(frame, current); return;
          }
          if (frame.type !== 'frame') throw failure('SUPERVISOR_PROTOCOL_INVALID');
          let scoped;
          try { scoped = scopedOperations(frame.value, profile.applicationId, current.id, profile.deviceId, current.policy); }
          catch (error) {
            if (!client.snapshot || !Number.isSafeInteger(frame.value?.id) || frame.value.id < 1) throw error;
            const code = error.code ?? 'SUPERVISOR_PROTOCOL_INVALID';
            transport.send({ type: 'frame', value: { id: frame.value.id,
              error: { name: 'Error', message: code, code }, snapshot: client.snapshot } });
            return;
          }
          client.port.postMessage(scoped);
        }
      }, error => {
        client.failed = true; clearTimeout(timer); client.detach?.(); client.detach = undefined; client.port?.close();
        return { type: 'error', code: error.code ?? 'SUPERVISOR_PROTOCOL_INVALID' };
      });
      socket.on('close', () => { clearTimeout(timer); transport.close(); client.stagedAssets.clear(); client.stagedBytes = 0; client.detach?.(); client.port?.close(); clients.delete(client); if (closeWhenIdle && clients.size === 0) void close(); });
    };
    listener = await listenLocalIpc(root, onConnection, { preferredTransport });
    listener.server.on('error', () => { abort(); });
    signal?.addEventListener('abort', abort, { once: true }); signal?.throwIfAborted();
    return {
      profile: Object.freeze(profile), ownerInstanceId: owner.ownerInstanceId,
      socketPath: listener.descriptor.address ?? `127.0.0.1:${listener.descriptor.port}`,
      endpoint: listener.descriptor,
      get activeClients() { return clients.size; },
      markCloseWhenIdle() { closeWhenIdle = true; if (clients.size === 0) return close(); },
      close,
      endpoints: () => owner.endpoints(),
      bindings: () => [...records.values()].map(({ hash, ...value }) => structuredClone(value)),
      async createBinding({ id = randomUUID(), policy = {} } = {}) {
        identity(id); const token = createNativeAttachmentKey(), approved = checkedPolicy(policy);
        await mutate(next => {
          if (next.has(id)) throw failure('SUPERVISOR_BINDING_EXISTS');
          if (next.size >= maxBindings) throw failure('SUPERVISOR_BINDING_LIMIT');
          next.set(id, { id, hash: digest(token), active: true, revision: 1, policy: approved });
        });
        return { id, token, revision: 1 };
      },
      async rotateBinding(id, token = createNativeAttachmentKey()) {
        identity(id); if (!KEY.test(token)) throw failure('SUPERVISOR_CREDENTIAL_INVALID');
        const revision = await mutate(next => {
          const row = next.get(id); if (!row?.active) throw failure('SUPERVISOR_BINDING_REVOKED');
          row.hash = digest(token); return ++row.revision;
        });
        return { id, token, revision };
      },
      revokeBinding: id => mutate(next => { const row = next.get(identity(id)); if (!row) throw failure('SUPERVISOR_BINDING_UNKNOWN'); row.active = false; row.revision++; }),
    };
  } catch (error) { await close(); throw error; }
}

/** Compose the public connectApplicationOwner facade with the cross-platform local IPC endpoint.
 * No signing store is opened and close/detach never shuts down the supervisor. */
export async function attachNativeSession({ directory: path, token, connect, applicationId, definitionId, definitionVersion,
  context, preserveOperationId = false, timeoutMs = 5000, signal } = {}) {
  if (!KEY.test(token)) throw failure('SUPERVISOR_CREDENTIAL_INVALID');
  if (typeof connect !== 'function') throw failure('SUPERVISOR_CONNECT_REQUIRED', 'Supply connectApplicationOwner from the public Chronolog browser facade.');
  signal?.throwIfAborted();
  const { socket, descriptor } = await connectLocalIpc(path), lifetime = new AbortController();
  let port, session, closed = false, controlSeq = 0;
  const controlWaiters = new Map();
  const end = cause => {
    if (closed) return; closed = true;
    const reason = cause ?? failure('OWNER_UNREACHABLE');
    lifetime.abort(reason);
    for (const waiter of controlWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(reason); }
    controlWaiters.clear();
    try { port?.postMessage({ ended: { name: 'Error', message: reason?.message ?? 'OWNER_UNREACHABLE', code: reason?.code ?? 'OWNER_UNREACHABLE' } }); } catch {}
    port?.close(); socket.destroy();
  };
  const transport = frames(socket, frame => {
    if (frame?.type === 'error') { end(failure(frame.code)); return; }
    if (frame?.type === 'control-reply') {
      const waiter = controlWaiters.get(frame.id);
      if (!waiter) return;
      controlWaiters.delete(frame.id); clearTimeout(waiter.timer);
      if (frame.error) {
        const transportCauses = transportCauseSummary(frame.error);
        const err = Object.assign(new Error(frame.error.message ?? 'Control request failed'), {
          name: frame.error.name ?? 'Error',
          ...(frame.error.code ? { code: frame.error.code } : {}),
          ...(frame.error.status !== undefined ? { status: frame.error.status } : {}),
          ...(frame.error.outcome !== undefined ? { outcome: frame.error.outcome } : {}),
          ...(frame.error.phase !== undefined ? { phase: frame.error.phase } : {}),
          ...(frame.error.receipt !== undefined ? { receipt: frame.error.receipt } : {}),
          ...(frame.error.operationId !== undefined ? { operationId: frame.error.operationId } : {}),
          ...(frame.error.publicationId !== undefined ? { publicationId: frame.error.publicationId } : {}),
          ...(transportCauses ? { transportCauses } : {}),
        });
        waiter.reject(err);
      } else waiter.resolve(frame.value);
      return;
    }
    if (frame?.type !== 'frame' || !port) throw failure('SUPERVISOR_PROTOCOL_INVALID');
    port.postMessage(frame.value);
  }, end);
  const callControl = (method, args = []) => new Promise((resolve, reject) => {
    if (closed) { reject(failure('OWNER_UNREACHABLE')); return; }
    if (controlWaiters.size >= 64) { reject(failure('APPLICATION_ATTACHMENT_REQUEST_LIMIT')); return; }
    const id = ++controlSeq;
    const timer = setTimeout(() => {
      controlWaiters.delete(id);
      reject(failure('CONTROL_REQUEST_TIMEOUT', 'The control reply deadline elapsed. Preserve the publication operation and inspect its receipt before retrying.'));
    }, CONTROL_TIMEOUT_MS);
    controlWaiters.set(id, { resolve, reject, timer });
    try { transport.send({ type: 'control', id, method, args }); }
    catch (error) { clearTimeout(timer); controlWaiters.delete(id); reject(error); }
  });
  const control = Object.freeze({
    definition: () => callControl('definition'),
    publication: () => callControl('publication'),
    publicationOperation: operationId => callControl('publicationOperation', [operationId]),
    preparePublication: input => callControl('preparePublication', [input]),
    async publish(publication, assets) {
      if (!Array.isArray(assets) || assets.length > PUBLICATION_LIMITS.files ||
          assets.some(asset => !publicationAsset(asset?.hash, asset?.bytes))) throw failure('SUPERVISOR_PROTOCOL_INVALID');
      const payloadBytes = assets.reduce((sum, item) => sum + item.bytes.length, 0);
      if (payloadBytes > PUBLICATION_STAGE_BYTES) throw failure('PEER_PUBLICATION_TOO_LARGE');
      if (payloadBytes <= 650_000) return callControl('publish', [publication, assets]);
      const stageId = randomUUID();
      try {
        for (const asset of assets) {
          for (let offset = 0; offset < asset.bytes.length || (offset === 0 && asset.bytes.length === 0); offset += PUBLICATION_SLICE) {
            const slice = asset.bytes.slice(offset, offset + PUBLICATION_SLICE);
            const done = offset + PUBLICATION_SLICE >= asset.bytes.length;
            await callControl('publishStage', [stageId, asset.hash, slice, done]);
          }
        }
        return await callControl('publishCommit', [stageId, publication]);
      } catch (error) {
        void callControl('publishAbort', [stageId]).catch(() => {});
        throw error;
      }
    },
  });
  socket.once('close', () => end());
  const abort = () => end(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { end(failure('OWNER_UNREACHABLE')); reject(failure('OWNER_UNREACHABLE')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); reject(failure('OWNER_UNREACHABLE')); });
    });
    const endpoint = {
      addEventListener() {}, removeEventListener() {},
      postMessage(frame) {
        if (port || !frame?.port) throw failure('SUPERVISOR_PROTOCOL_INVALID');
        port = frame.port;
        port.addEventListener('message', event => { try { transport.send({ type: 'frame', value: event.data }); } catch (error) { end(error); } });
        port.addEventListener('close', () => { socket.end(); });
        port.start();
        transport.send({
          type: 'attach', protocol: PROTOCOL, token, ownerProtocol: frame.protocol, handshake: frame.handshake,
          ...(descriptor.token ? { loopbackToken: descriptor.token } : {}),
        });
      },
    };
    session = await connect(endpoint, { applicationId, definitionId, definitionVersion, context, timeoutMs,
      signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
    const bindingId = session.endpoint?.identity?.agentBindingId;
    if (session.applicationId !== applicationId || typeof bindingId !== 'string' || !bindingId)
      throw failure('SUPERVISOR_BINDING_REQUIRED', 'The authenticated attachment must identify its approved operation namespace.');
    Object.defineProperty(session, 'scopeOperationId', {
      value: Object.freeze(value => preserveOperationId ? value : scopedOperationId(applicationId, bindingId, value)),
      writable: false, configurable: false,
    });
    const detach = async () => {
      try { await session.detach(); } finally { signal?.removeEventListener('abort', abort); transport.close(); port?.close(); socket.end(); }
    };
    session.signal.addEventListener('abort', () => { signal?.removeEventListener('abort', abort); transport.close(); port?.close(); socket.end(); }, { once: true });
    return { session, control, mode: 'attach', transport: descriptor.transport, detach };
  } catch (error) { signal?.removeEventListener('abort', abort); end(error); throw error; }
}

const TRUSTED_LOCAL_BINDING_FILE = 'local-caller.json';
const sleep = (ms, signal) => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(resolvePromise, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * Automatic connect-or-start (W2):
 * - `bounded: true`: direct in-process execution under exclusive atomic lockfile with ZERO sockets/pipes.
 * - Default shared mode: attaches automatically to an active local instance or starts one with
 *   a trusted-local binding (preserving operationId verbatim), resolving concurrent startup races
 *   with bounded jitter backoff (50ms -> 500ms, max 5s). Never silently mints a new device identity.
 */
export async function connectOrStartNativeSession({
  directory: path,
  profileId,
  openOwner,
  connect,
  applicationId,
  definitionId,
  definitionVersion,
  bounded: boundedMode = false,
  preferredTransport = 'auto',
  context,
  timeoutMs = 5000,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const root = await ensurePrivateDirectory(path, true);
  if (boundedMode) {
    const lock = await acquireAtomicLock(root);
    let owner;
    try {
      owner = await openOwner({ signal, profileId });
      if (!owner?.session) throw failure('SUPERVISOR_OWNER_INVALID');
      signal?.throwIfAborted();
      let closing;
      const close = () => closing ??= (async () => {
        try { await owner.close(); } finally { await lock.release(); }
      })();
      return { session: owner.session, mode: 'bounded', owner, close, detach: close };
    } catch (error) {
      try { await owner?.close(); } catch {}
      await lock.release();
      throw error;
    }
  }

  // Ensure a stable private trusted-local binding credential for automatic local attachment.
  let localBinding = await readPrivateJson(root, TRUSTED_LOCAL_BINDING_FILE);
  if (!localBinding || !KEY.test(localBinding.token)) {
    const candidate = {
      id: 'trusted-local',
      token: createNativeAttachmentKey(),
      policy: {
        capabilities: ['commands', 'queries', 'events', 'content', 'signals', 'operations', 'diagnostics', 'ownerAdmin'],
        preserveOperationId: true,
      },
    };
    try {
      const fd = await open(join(root, TRUSTED_LOCAL_BINDING_FILE), 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify(candidate)); await fd.sync(); } finally { await fd.close(); }
      localBinding = candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      localBinding = await readPrivateJson(root, TRUSTED_LOCAL_BINDING_FILE);
    }
  }

  const deadline = Date.now() + Math.max(5000, timeoutMs);
  let delayMs = 50;
  for (;;) {
    signal?.throwIfAborted();
    // 1. Try attaching to an already-running instance.
    try {
      const attached = await attachNativeSession({
        directory: root,
        token: localBinding.token,
        connect,
        applicationId,
        definitionId,
        definitionVersion,
        context,
        preserveOperationId: true,
        timeoutMs: Math.min(timeoutMs, 2500),
        signal,
      });
      return { ...attached, startedSupervisor: false, close: attached.detach };
    } catch (attachError) {
      signal?.throwIfAborted();
      if (!['ENOENT', 'ECONNREFUSED', 'OWNER_UNREACHABLE'].includes(attachError?.code)) throw attachError;
    }

    // 2. No live instance answered; try starting the shared supervisor atomically.
    try {
      const supervisor = await createNativeSessionSupervisor({
        directory: root,
        profileId,
        openOwner,
        bindings: [localBinding],
        preferredTransport,
        signal,
      });
      // Attach as a local caller so caller disconnect never kills an instance still serving other callers.
      try {
        const attached = await attachNativeSession({
          directory: root,
          token: localBinding.token,
          connect,
          applicationId,
          definitionId,
          definitionVersion,
          context,
          preserveOperationId: true,
          timeoutMs,
          signal,
        });
        return {
          ...attached,
          mode: 'shared-owner',
          startedSupervisor: true,
          supervisor,
          async detach() {
            await attached.detach();
            await supervisor.markCloseWhenIdle();
          },
          close: () => supervisor.close(),
        };
      } catch (error) {
        await supervisor.close();
        throw error;
      }
    } catch (startError) {
      const concurrentStartup = startError?.code === 'INSTANCE_UNRESPONSIVE'
        && startError.endpoint == null
        && typeof startError.lockAgeMs === 'number'
        && startError.lockAgeMs < 5000;
      if (!concurrentStartup && startError?.code === 'INSTANCE_UNRESPONSIVE') throw startError;
      if ((!concurrentStartup && startError?.code !== 'OWNER_BUSY') || Date.now() >= deadline) throw startError;
      const jitter = Math.floor(Math.random() * 40);
      await sleep(Math.min(500, delayMs) + jitter, signal);
      delayMs = Math.min(500, delayMs * 2);
      // Re-read winning caller's local-caller.json if another concurrent process wrote it first.
      const refreshed = await readPrivateJson(root, TRUSTED_LOCAL_BINDING_FILE).catch(() => null);
      if (refreshed && KEY.test(refreshed.token)) localBinding = refreshed;
    }
  }
}

/** Provider effect receipts are durable independently of recoverable application history.
 * A transaction never awaits network work, and retained uncertainty never causes replay. */
export async function createSqliteEffectJournal({ path, applicationId, providerId, maxRecords = 10_000, maxRecordBytes = 131_072 } = {}) {
  identifier(applicationId); identifier(providerId);
  maxRecords = bounded(maxRecords, 10_000, 1_000_000); maxRecordBytes = bounded(maxRecordBytes, 131_072, 1_048_576);
  const filename = resolve(path), root = dirname(filename);
  await mkdir(root, { recursive: true, mode: 0o700 }); await privatePath(root, 'directory', 0o700);
  try { const file = await open(filename, 'wx', 0o600); await file.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await privatePath(filename, 'file', 0o600);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(filename), scope = canonicalJson({ applicationId, providerId, version: 1 });
  let closed = false;
  const held = () => { if (closed) throw failure('EFFECT_JOURNAL_CLOSED'); };
  const atomic = update => {
    held(); let begun = false;
    try {
      database.exec('BEGIN IMMEDIATE'); begun = true;
      const result = update(); database.exec('COMMIT'); return result;
    } catch (error) {
      if (begun) database.exec('ROLLBACK');
      if (/database is (?:locked|busy)/iu.test(error.message)) throw failure('EFFECT_JOURNAL_BUSY', 'Retry journal admission using the same effect identity.');
      throw error;
    }
  };
  const idempotencyKey = effectId => 'effect_' + digest(scope + ':' + identifier(effectId));
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.some(row => !['effect_journal', 'effects'].includes(row.name))) throw failure('EFFECT_JOURNAL_SEPARATE_STORE_REQUIRED');
    database.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF');
    atomic(() => {
      database.exec('CREATE TABLE IF NOT EXISTS effect_journal(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,record TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
      const retained = database.prepare('SELECT scope FROM effect_journal WHERE singleton=1').get();
      if (retained && retained.scope !== scope) throw failure('EFFECT_JOURNAL_SCOPE_CHANGED');
      if (!retained) database.prepare('INSERT INTO effect_journal(singleton,scope) VALUES(1,?)').run(scope);
    });
    const parent = await open(root, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return Object.freeze({
      applicationId, providerId, idempotencyKey,
      async transact(effectId, update) {
        identifier(effectId); if (typeof update !== 'function') throw failure('EFFECT_JOURNAL_UPDATE_REQUIRED');
        return atomic(() => {
          const retained = database.prepare('SELECT record FROM effects WHERE id=?').get(effectId);
          const previous = retained ? JSON.parse(retained.record) : undefined;
          const result = update(previous === undefined ? undefined : structuredClone(previous));
          if (result?.then) throw failure('EFFECT_JOURNAL_ASYNC_UPDATE', 'Finish provider I/O outside the journal transaction.');
          if (!result || typeof result !== 'object' || !result.record || result.record.effectId !== effectId ||
              !['dispatching', 'outcomeUnknown', 'completed'].includes(result.record.status)) throw failure('EFFECT_JOURNAL_RECORD_INVALID');
          const record = { ...result.record, idempotencyKey: idempotencyKey(effectId) };
          if (result.record.idempotencyKey !== undefined && result.record.idempotencyKey !== record.idempotencyKey)
            throw failure('EFFECT_ID_CONFLICT');
          if (previous && (previous.payload !== record.payload || canonicalJson(previous.fence) !== canonicalJson(record.fence)))
            throw failure('EFFECT_ID_CONFLICT');
          if (previous?.status === 'completed' && (record.status !== 'completed' || canonicalJson(previous.receipt) !== canonicalJson(record.receipt)))
            throw failure('EFFECT_RECEIPT_CONFLICT');
          const encoded = canonicalJson(record, maxRecordBytes), now = Date.now();
          if (!retained && Number(database.prepare('SELECT COUNT(*) AS count FROM effects').get().count) >= maxRecords)
            throw failure('EFFECT_JOURNAL_FULL', 'Retained effect identities cannot be silently evicted or dispatched again.');
          database.prepare('INSERT INTO effects(id,record,revision,created_at,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,revision=effects.revision+1,updated_at=excluded.updated_at')
            .run(effectId, encoded, now, now);
          return structuredClone(result.value);
        });
      },
      async inspect(effectId) {
        held(); const row = database.prepare('SELECT record,revision,created_at,updated_at FROM effects WHERE id=?').get(identifier(effectId));
        return row ? { ...JSON.parse(row.record), journalRevision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null;
      },
      async list({ after = '', limit = 100, status } = {}) {
        held(); limit = bounded(limit, 100, 1000);
        if (typeof after !== 'string' || after.length > 200 || status !== undefined && !['dispatching', 'outcomeUnknown', 'completed'].includes(status)) throw failure('EFFECT_JOURNAL_CURSOR_INVALID');
        const rows = database.prepare('SELECT id,record FROM effects WHERE id>? ORDER BY id LIMIT ?').all(after, limit + 1);
        const page = rows.slice(0, limit);
        return { records: page.map(row => JSON.parse(row.record)).filter(record => status === undefined || record.status === status),
          next: page.at(-1)?.id ?? after, hasMore: rows.length > limit };
      },
      async close() { if (!closed) { closed = true; database.close(); } },
    });
  } catch (error) { database.close(); throw error; }
}
