// Cross-platform Shared Local Access IPC & atomic lockfile manager (W2).
// Supports:
//  1. Linux/macOS Unix domain sockets (auto-hashed short path under $XDG_RUNTIME_DIR/tmpdir if > 100 bytes)
//  2. Windows native named pipes (\\.\pipe\tendriller-<sha256(canonicalPath)>)
//  3. Restricted container loopback TCP fallback (127.0.0.1:0 + 0600 descriptor + 256-bit constant-time bearer token)
import { createServer, createConnection } from 'node:net';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fail = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function isWindows() {
  return process.platform === 'win32';
}

export function resolveUnixSocketPath(root) {
  const canonical = resolve(root);
  const direct = join(canonical, 'owner.sock');
  if (Buffer.byteLength(direct) <= 100) return direct;
  const runtimeBase = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(runtimeBase, `td-${sha256(canonical).slice(0, 24)}.sock`);
}

export function resolveWindowsPipePath(root) {
  return `\\\\.\\pipe\\tendriller-${sha256(resolve(root)).slice(0, 32)}`;
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function writePrivateJsonAtomic(root, name, data) {
  const temporary = join(root, `.pending-${randomUUID()}.json`);
  const target = join(root, name);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, target);
    if (!isWindows()) {
      const parent = await open(root, 'r');
      try { await parent.sync(); } catch {} finally { await parent.close(); }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readPrivateJson(root, name, maxBytes = 131_072) {
  const path = join(root, name);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('IPC_PRIVATE_PATH_INVALID', `Expected regular file: ${path}`);
    if (!isWindows() && ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600)) {
      throw fail('IPC_PRIVATE_PATH_INVALID', `Expected private 0600 file owned by current user: ${path}`);
    }
    if (stat.size > maxBytes) throw fail('IPC_METADATA_LIMIT', `Metadata exceeds limit: ${path}`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function ensurePrivateDirectory(path, create = false) {
  const canonical = resolve(path);
  if (create) await mkdir(canonical, { recursive: true, mode: 0o700 });
  const stat = await lstat(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail('SUPERVISOR_PRIVATE_PATH_REQUIRED', `Expected directory: ${canonical}`);
  }
  if (!isWindows() && ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o700)) {
    throw fail('SUPERVISOR_PRIVATE_PATH_REQUIRED', `Use an owned directory with mode 700: ${canonical}`);
  }
  return canonical;
}

/**
 * Probe whether a recorded IPC endpoint accepts a TCP/pipe/socket connection.
 */
export async function probeEndpointReachable(descriptor, timeoutMs = 600) {
  if (!descriptor) return false;
  return new Promise(resolvePromise => {
    let settled = false;
    const done = ok => { if (!settled) { settled = true; clearTimeout(timer); socket?.destroy(); resolvePromise(ok); } };
    const timer = setTimeout(() => done(false), timeoutMs);
    let socket;
    try {
      socket = descriptor.transport === 'loopback-tcp'
        ? createConnection({ host: '127.0.0.1', port: descriptor.port })
        : createConnection(descriptor.address);
    } catch { done(false); return; }
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Atomic O_CREAT | O_EXCL lockfile with PID + host + lease heartbeat and bounded stale recovery.
 * Never silently replaces a live lock holder; returns INSTANCE_UNRESPONSIVE if holder is alive but unreachable.
 */
export async function acquireAtomicLock(root, {
  lockName = 'owner.lock',
  leaseTtlMs = 15_000,
  maxStaleRetries = 2,
  probeReachable,
} = {}) {
  const lockPath = join(root, lockName);
  const hostId = hostname();
  const lockId = randomUUID();
  const makeRecord = () => ({
    version: 1,
    lockId,
    pid: process.pid,
    hostId,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    leaseTtlMs,
  });

  for (let attempt = 0; attempt <= maxStaleRetries; attempt++) {
    try {
      const fd = await open(lockPath, 'wx', 0o600);
      try {
        await fd.writeFile(JSON.stringify(makeRecord()));
        await fd.sync();
      } finally {
        await fd.close();
      }
      let released = false, pendingHeartbeat = Promise.resolve();
      const heartbeat = setInterval(() => {
        if (released) return;
        pendingHeartbeat = pendingHeartbeat.then(() => released ? undefined : writePrivateJsonAtomic(root, lockName, makeRecord())).catch(() => {});
      }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
      heartbeat.unref?.();
      return Object.freeze({
        lockPath,
        lockId,
        async release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await pendingHeartbeat;
          const current = await readPrivateJson(root, lockName).catch(() => null);
          if (!current || current.lockId === lockId) {
            await unlink(lockPath).catch(() => {});
          }
        },
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readPrivateJson(root, lockName).catch(() => null);
      const endpoint = await readPrivateJson(root, 'endpoint.json').catch(() => null);
      const reachable = probeReachable ? await probeReachable(endpoint) : await probeEndpointReachable(endpoint);
      if (reachable) {
        throw fail('OWNER_BUSY', 'A live instance already owns this project directory.', { pid: existing?.pid ?? null, endpoint });
      }
      const sameHost = !existing?.hostId || existing.hostId === hostId;
      const alive = sameHost && existing?.pid ? isProcessAlive(existing.pid) : false;
      if (alive) {
        const lockAgeMs = typeof existing?.startedAt === 'number' ? Math.max(0, Date.now() - existing.startedAt) : Infinity;
        throw fail('INSTANCE_UNRESPONSIVE', `Lock held by live PID ${existing.pid} whose IPC endpoint is unreachable. Inspect or stop that process; never mint a duplicate device.`, {
          pid: existing.pid,
          endpoint,
          lockPath,
          lockAgeMs,
        });
      }
      if (attempt >= maxStaleRetries) {
        throw fail('OWNER_BUSY', 'Unable to reclaim stale lock after bounded retries.', { pid: existing?.pid ?? null });
      }
      // Atomic stale-lock reclamation via unlink + retry of O_CREAT|O_EXCL.
      await unlink(lockPath).catch(() => {});
    }
  }
  throw fail('OWNER_BUSY', 'Failed to acquire exclusive project lock.');
}

/**
 * Listen on the best available cross-platform local IPC transport:
 * Unix domain socket (Linux/macOS), Windows named pipe (win32), or loopback TCP with 256-bit token fallback.
 */
export async function listenLocalIpc(root, onConnection, { preferredTransport = 'auto' } = {}) {
  const transportOrder = preferredTransport === 'loopback-tcp'
    ? ['loopback-tcp']
    : isWindows()
      ? ['windows-named-pipe', 'loopback-tcp']
      : ['unix-socket', 'loopback-tcp'];

  let lastError;
  for (const kind of transportOrder) {
    if (kind === 'unix-socket') {
      const address = resolveUnixSocketPath(root);
      try {
        const st = await lstat(address).catch(() => null);
        if (st?.isSocket()) await unlink(address).catch(() => {});
        const server = createServer(onConnection);
        await new Promise((resolvePromise, reject) => {
          server.once('error', reject);
          server.listen(address, () => { server.removeListener('error', reject); resolvePromise(); });
        });
        await chmod(address, 0o600);
        const descriptor = Object.freeze({ version: 1, transport: 'unix-socket', address, pid: process.pid });
        await writePrivateJsonAtomic(root, 'endpoint.json', descriptor);
        return Object.freeze({
          server,
          descriptor,
          verifyLoopbackToken: () => true,
          async close() {
            await new Promise(done => server.close(() => done()));
            await unlink(address).catch(() => {});
            await unlink(join(root, 'endpoint.json')).catch(() => {});
          },
        });
      } catch (error) {
        lastError = error;
      }
    } else if (kind === 'windows-named-pipe') {
      const address = resolveWindowsPipePath(root);
      try {
        const server = createServer(onConnection);
        await new Promise((resolvePromise, reject) => {
          server.once('error', reject);
          server.listen(address, () => { server.removeListener('error', reject); resolvePromise(); });
        });
        const descriptor = Object.freeze({ version: 1, transport: 'windows-named-pipe', address, pid: process.pid });
        await writePrivateJsonAtomic(root, 'endpoint.json', descriptor);
        return Object.freeze({
          server,
          descriptor,
          verifyLoopbackToken: () => true,
          async close() {
            await new Promise(done => server.close(() => done()));
            await unlink(join(root, 'endpoint.json')).catch(() => {});
          },
        });
      } catch (error) {
        lastError = error;
      }
    } else if (kind === 'loopback-tcp') {
      try {
        const loopbackToken = randomBytes(32).toString('hex');
        const expectedBuf = Buffer.from(loopbackToken, 'hex');
        const server = createServer(onConnection);
        await new Promise((resolvePromise, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolvePromise(); });
        });
        const info = server.address();
        const port = typeof info === 'object' && info ? info.port : 0;
        const descriptor = Object.freeze({ version: 1, transport: 'loopback-tcp', host: '127.0.0.1', port, token: loopbackToken, pid: process.pid });
        await writePrivateJsonAtomic(root, 'endpoint.json', descriptor);
        return Object.freeze({
          server,
          descriptor,
          verifyLoopbackToken(presented) {
            if (typeof presented !== 'string' || !/^[a-f0-9]{64}$/u.test(presented)) return false;
            return timingSafeEqual(expectedBuf, Buffer.from(presented, 'hex'));
          },
          async close() {
            await new Promise(done => server.close(() => done()));
            await unlink(join(root, 'endpoint.json')).catch(() => {});
          },
        });
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError ?? fail('IPC_LISTEN_FAILED', 'Unable to bind any supported local IPC transport.');
}

/**
 * Connect to an active local IPC endpoint discovered from `endpoint.json` (or legacy `owner.sock`).
 */
export async function connectLocalIpc(root) {
  const canonical = await ensurePrivateDirectory(root, false);
  const descriptor = await readPrivateJson(canonical, 'endpoint.json');
  if (descriptor) {
    const socket = descriptor.transport === 'loopback-tcp'
      ? createConnection({ host: '127.0.0.1', port: descriptor.port })
      : createConnection(descriptor.address);
    return { socket, descriptor };
  }
  if (!isWindows()) {
    const address = resolveUnixSocketPath(canonical);
    const socket = createConnection(address);
    return { socket, descriptor: { version: 1, transport: 'unix-socket', address } };
  }
  const address = resolveWindowsPipePath(canonical);
  return { socket: createConnection(address), descriptor: { version: 1, transport: 'windows-named-pipe', address } };
}
