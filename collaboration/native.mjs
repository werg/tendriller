import { createServer, createConnection } from 'node:net';
import { lstat, mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { MessageChannel } from 'node:worker_threads';
import { canonicalJson, identifier } from './protocol.mjs';

const PROTOCOL = 'tendriller.native-owner.v1';
const MAX_FRAME = 1_100_000, MAX_QUEUE = 4_400_000, KEY = /^td_n_[a-f0-9]{64}$/u;
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
      process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode)
    throw failure('SUPERVISOR_PRIVATE_PATH_REQUIRED', `Use an owned ${kind} with mode ${mode.toString(8)}: ${path}`);
  return stat;
}
async function directory(path, create = false) {
  if (process.platform === 'win32') throw failure('SUPERVISOR_UNIX_REQUIRED', 'This supervisor requires authenticated Unix IPC; it does not open a TCP fallback.');
  const value = resolve(path);
  if (create) await mkdir(value, { recursive: true, mode: 0o700 });
  await privatePath(value, 'directory', 0o700);
  if (Buffer.byteLength(join(value, 'owner.sock')) > 100) throw failure('SUPERVISOR_SOCKET_PATH_TOO_LONG', 'Choose a shorter private supervisor directory.');
  return value;
}
async function atomicJSON(root, name, data) {
  const temporary = join(root, `pending-${randomUUID()}.json`), target = join(root, name);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data)); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temporary, target);
    const parent = await open(root, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
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

/** Length framing preserves bytes, bigint and structured owner protocol values. */
function frames(socket, onMessage, onFailure, { maxFrame = MAX_FRAME, maxQueue = MAX_QUEUE } = {}) {
  let buffer = Buffer.alloc(0), closed = false, scheduled = false;
  const fail = cause => { if (!closed) { closed = true; onFailure(cause); socket.destroy(); } };
  function drain() {
    scheduled = false;
    try {
      let count = 0;
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (!size || size > maxFrame) throw failure('SUPERVISOR_FRAME_LIMIT');
        if (buffer.length < size + 4) break;
        const value = deserialize(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        onMessage(value);
        if (++count === 64 && buffer.length) {
          socket.pause(); scheduled = true; setImmediate(() => { drain(); if (!closed) socket.resume(); }); break;
        }
      }
    } catch (error) { fail(error); }
  }
  socket.on('data', chunk => {
    if (closed) return;
    if (buffer.length + chunk.length > maxQueue) { fail(failure('SUPERVISOR_BACKPRESSURE')); return; }
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    if (!scheduled) drain();
  });
  socket.on('error', fail);
  return {
    send(value) {
      if (closed || socket.destroyed) throw failure('OWNER_UNREACHABLE');
      const payload = serialize(value);
      if (payload.length > maxFrame || socket.writableLength + payload.length + 4 > maxQueue) {
        const error = failure('SUPERVISOR_BACKPRESSURE'); fail(error); throw error;
      }
      const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    },
    close() { closed = true; buffer = Buffer.alloc(0); },
  };
}

function checkedPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('SUPERVISOR_POLICY_INVALID');
  if (Object.keys(value).some(key => !['capabilities', 'commands', 'queries', 'context', 'contextEvidence', 'identity', 'maxRequests', 'maxStreams', 'maxViews'].includes(key)))
    throw failure('SUPERVISOR_POLICY_INVALID');
  if (serialize(value).length > 16384) throw failure('SUPERVISOR_POLICY_LIMIT');
  const capabilities = ['commands', 'queries', 'events', 'content', 'signals', 'operations', 'diagnostics', 'ownerAdmin'];
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.some(item => !capabilities.includes(item))) ||
      [value.commands, value.queries].some(items => items !== undefined && (!Array.isArray(items) || items.length > 128 ||
        items.some(item => typeof item !== 'string' || !item.length || item.length > 128))) ||
      value.contextEvidence !== undefined && !['caller-asserted', 'owner-validated'].includes(value.contextEvidence))
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

function scopedOperations(frame, applicationId, bindingId, signer, policy) {
  if (!frame || typeof frame !== 'object' || !Array.isArray(frame.args)) return frame;
  const prefix = 'native_' + digest(applicationId + ':' + bindingId) + '_';
  const operation = value => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw failure('OPERATION_ID_INVALID');
    if (value.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(value.slice(prefix.length))) return value;
    if (value.startsWith('native_')) throw failure('OPERATION_BINDING_MISMATCH');
    return prefix + digest(value);
  };
  const args = [...frame.args];
  if (frame.method === 'command') args[2] = { ...args[2], operationId: operation(args[2]?.operationId) };
  else if (frame.method === 'reapply') {
    if (!args[3]?.originalAuthor || args[3].originalAuthor === signer) args[0] = operation(args[0]);
    args[3] = { ...args[3], operationId: operation(args[3]?.operationId) };
  } else if (frame.method === 'retry' || frame.method.startsWith('operation.')) {
    if (!args[1]?.author || args[1].author === signer) args[0] = operation(args[0]);
  } else if (frame.method === 'resume' && !policy.capabilities?.includes('ownerAdmin')) throw failure('APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED');
  return { ...frame, args };
}

/** One process owns the signer; independently authenticated clients only attach.
 * openOwner runs AFTER the exclusive profile fence has been acquired. */
export async function createNativeSessionSupervisor({ directory: path, profileId, openOwner, bindings = [], maxClients = 32,
  maxClientsPerBinding = 4, maxBindings = 32, handshakeTimeoutMs = 3000, signal } = {}) {
  signal?.throwIfAborted(); identity(profileId);
  if (typeof openOwner !== 'function') throw failure('SUPERVISOR_OWNER_FACTORY_REQUIRED');
  maxClients = bounded(maxClients, 32, 128); maxBindings = bounded(maxBindings, 32, 128);
  maxClientsPerBinding = bounded(maxClientsPerBinding, 4, 8);
  handshakeTimeoutMs = bounded(handshakeTimeoutMs, 3000, 30000);
  const root = await directory(path, true), releaseFence = await ownerFence(root), socketPath = join(root, 'owner.sock');
  const clients = new Set();
  let owner, server, records = new Map(), stopped = false, closing, changes = Promise.resolve();
  let createdSocket = false;
  const terminateClient = client => { client.detach?.(); client.detach = undefined; client.port?.close(); client.socket.destroy(); };
  const close = () => closing ??= (async () => {
    stopped = true; signal?.removeEventListener('abort', abort);
    owner?.session?.signal?.removeEventListener('abort', abort);
    for (const client of clients) terminateClient(client);
    await changes.catch(() => {});
    if (server) await new Promise(resolve => server.close(() => resolve()));
    try { await owner?.close(); }
    finally {
      try { if (createdSocket) await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      finally { releaseFence(); }
    }
  })();
  const abort = () => { void close().catch(() => {}); };
  const persist = next => atomicJSON(root, 'bindings.json', { version: 1, profileId, bindings: [...next.values()] });
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
    if (!previous) await atomicJSON(root, 'profile.json', profile);
    // Only the process holding the kernel-backed fence may remove a stale socket.
    try { await privatePath(socketPath, 'socket', 0o600); await unlink(socketPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    server = createServer(socket => {
      if (stopped || clients.size >= maxClients) { socket.destroy(); return; }
      const client = { socket, bindingId: null, revision: null, detach: undefined, port: undefined };
      clients.add(client);
      const timer = setTimeout(() => terminateClient(client), handshakeTimeoutMs);
      const transport = frames(socket, frame => {
        if (!frame || typeof frame !== 'object') throw failure('SUPERVISOR_PROTOCOL_INVALID');
        if (!client.bindingId) {
          if (frame.type !== 'attach' || frame.protocol !== PROTOCOL || typeof frame.token !== 'string' || !KEY.test(frame.token) ||
              serialize(frame).length > 16384) throw failure('SUPERVISOR_AUTHENTICATION_REQUIRED');
          const hash = Buffer.from(digest(frame.token), 'hex');
          const binding = [...records.values()].find(row => row.active && timingSafeEqual(Buffer.from(row.hash, 'hex'), hash));
          if (!binding) throw failure('SUPERVISOR_BINDING_REVOKED');
          if ([...clients].filter(value => value.bindingId === binding.id).length >= maxClientsPerBinding) throw failure('SUPERVISOR_BINDING_CAPACITY');
          client.bindingId = binding.id; client.revision = binding.revision; clearTimeout(timer);
          const channel = new MessageChannel(), endpoint = Object.assign(new EventTarget(), { postMessage() {} });
          client.port = channel.port2;
          channel.port2.addEventListener('message', event => { try { transport.send({ type: 'frame', value: event.data }); } catch { terminateClient(client); } });
          channel.port2.addEventListener('close', () => { socket.end(); });
          channel.port2.start();
          client.detach = owner.attach(endpoint, { ...binding.policy, identity: {
            ...binding.policy.identity, deviceProfileId: profileId, agentBindingId: binding.id,
          } });
          endpoint.dispatchEvent(new MessageEvent('message', { data: { protocol: frame.ownerProtocol, handshake: frame.handshake, port: channel.port1 } }));
        } else {
          const current = records.get(client.bindingId);
          if (!current?.active || current.revision !== client.revision) throw failure('SUPERVISOR_BINDING_REVOKED');
          if (frame.type !== 'frame') throw failure('SUPERVISOR_PROTOCOL_INVALID');
          client.port.postMessage(scopedOperations(frame.value, profile.applicationId, current.id, profile.deviceId, current.policy));
        }
      }, error => {
        try { transport.send({ type: 'error', code: error.code ?? 'SUPERVISOR_PROTOCOL_INVALID' }); } catch {}
        terminateClient(client);
      });
      socket.on('close', () => { clearTimeout(timer); transport.close(); client.detach?.(); client.port?.close(); clients.delete(client); });
    });
    server.on('error', () => { if (createdSocket) abort(); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
    createdSocket = true; await chmod(socketPath, 0o600);
    signal?.addEventListener('abort', abort, { once: true }); signal?.throwIfAborted();
    return {
      profile: Object.freeze(profile), ownerInstanceId: owner.ownerInstanceId, socketPath, close,
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

/** Compose the public connectApplicationOwner facade with a private Unix socket.
 * No signing store is opened and close/detach never shuts down the supervisor. */
export async function attachNativeSession({ directory: path, token, connect, applicationId, definitionId, definitionVersion,
  context, timeoutMs = 5000, signal } = {}) {
  if (!KEY.test(token)) throw failure('SUPERVISOR_CREDENTIAL_INVALID');
  if (typeof connect !== 'function') throw failure('SUPERVISOR_CONNECT_REQUIRED', 'Supply connectApplicationOwner from the public Chronolog browser facade.');
  signal?.throwIfAborted();
  const root = await directory(path), socketPath = join(root, 'owner.sock');
  await privatePath(socketPath, 'socket', 0o600);
  const socket = createConnection(socketPath), lifetime = new AbortController();
  let port, session, closed = false;
  const end = cause => {
    if (closed) return; closed = true;
    lifetime.abort(cause ?? failure('OWNER_UNREACHABLE'));
    try { port?.postMessage({ ended: { name: 'Error', message: cause?.message ?? 'OWNER_UNREACHABLE', code: cause?.code ?? 'OWNER_UNREACHABLE' } }); } catch {}
    port?.close(); socket.destroy();
  };
  const transport = frames(socket, frame => {
    if (frame?.type === 'error') { end(failure(frame.code)); return; }
    if (frame?.type !== 'frame' || !port) throw failure('SUPERVISOR_PROTOCOL_INVALID');
    port.postMessage(frame.value);
  }, end);
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
        transport.send({ type: 'attach', protocol: PROTOCOL, token, ownerProtocol: frame.protocol, handshake: frame.handshake });
      },
    };
    session = await connect(endpoint, { applicationId, definitionId, definitionVersion, context, timeoutMs,
      signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
    const detach = async () => {
      try { await session.detach(); } finally { signal?.removeEventListener('abort', abort); transport.close(); port?.close(); socket.end(); }
    };
    session.signal.addEventListener('abort', () => { signal?.removeEventListener('abort', abort); transport.close(); port?.close(); socket.end(); }, { once: true });
    return { session, mode: 'attach', detach };
  } catch (error) { signal?.removeEventListener('abort', abort); end(error); throw error; }
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
