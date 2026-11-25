// A bounded client for the selected existing Codex App Server. It never starts
// a daemon, subscribes to a thread, approves a tool, or logs conversation bodies.
import { execFile } from 'node:child_process';
import { connect as connectSocket, isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const failure = (code, message) => Object.assign(Error(message), { code });
const MAX_FRAME = 1024 * 1024;

export async function openCodexRpc({ remote, cwd, remoteAuthTokenEnv, timeoutMs = 30_000,
  signal, execute = executeFile, WebSocketImpl }) {
  signal?.throwIfAborted();
  const WebSocket = WebSocketImpl ?? (await import('ws')).WebSocket;
  const settings = { maxPayload: MAX_FRAME, handshakeTimeout: timeoutMs, perMessageDeflate: false };
  let address = remote;
  if (remote.startsWith('unix://')) {
    if (remoteAuthTokenEnv) throw failure('CODEX_RPC_AUTH_UNSUPPORTED', 'Unix Codex sockets use local socket authority, not bearer tokens.');
    let path = remote.slice('unix://'.length);
    if (!path) {
      // Read-only discovery of the existing daemon; never bootstrap or start one.
      const result = await execute('codex', ['app-server', 'daemon', 'version'], {
        cwd, shell: false, timeout: timeoutMs, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}),
      });
      let daemon;
      try { daemon = JSON.parse(result.stdout); } catch { /* fail closed below */ }
      if (daemon?.status !== 'running') throw failure('CODEX_RPC_DAEMON_UNAVAILABLE', 'The selected Codex daemon is not confirmed running.');
      path = daemon.socketPath;
    }
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\r\n\0]/u.test(path)) {
      throw failure('CODEX_RPC_SOCKET_INVALID', 'Codex must identify an absolute local control socket.');
    }
    address = 'ws://localhost/rpc';
    settings.createConnection = () => connectSocket(path);
  } else {
    const url = new URL(remote);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw failure('CODEX_RPC_REMOTE_INVALID', 'Select an explicit ws(s) endpoint without embedded credentials.');
    }
    if (remoteAuthTokenEnv) {
      const loopback = url.hostname.toLowerCase() === 'localhost' || url.hostname === '[::1]'
        || isIP(url.hostname) === 4 && url.hostname.startsWith('127.');
      if (url.protocol !== 'wss:' && !loopback) {
        throw failure('CODEX_RPC_AUTH_INSECURE', 'Authenticated remote Codex connections require TLS or loopback.');
      }
      const token = process.env[remoteAuthTokenEnv];
      if (!token || token.length > 16_384 || /[\r\n]/u.test(token)) {
        throw failure('CODEX_RPC_AUTH_MISSING', 'The selected authentication environment variable is unavailable.');
      }
      settings.headers = { Authorization: 'Bearer ' + token };
    }
  }
  signal?.throwIfAborted();
  const socket = new WebSocket(address, settings);
  let ended, serial = 0;
  const pending = new Map();
  const end = error => {
    if (ended) return;
    ended = error;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  socket.on('message', raw => {
    if (ended) return;
    if (raw.length > MAX_FRAME) return end(failure('CODEX_RPC_LIMIT', 'Codex returned an oversized protocol frame.'));
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { return end(failure('CODEX_RPC_PROTOCOL', 'Codex returned invalid JSON.')); }
    if (!message || typeof message !== 'object') return end(failure('CODEX_RPC_PROTOCOL', 'Codex returned an invalid protocol frame.'));
    // This admission-only connection must never answer approval or tool requests.
    if (message.method && message.id !== undefined) return end(failure('CODEX_RPC_INTERACTION_REQUIRED', 'The selected host requires an interactive response.'));
    const waiter = pending.get(message.id);
    if (!waiter) return; // Notifications are not receipts or automatic new turns.
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(failure('CODEX_RPC_REJECTED', 'Codex rejected this protocol request.'), {
      rpcCode: message.error.code, rpcMessage: message.error.message, rpcData: message.error.data,
    }));
    else if (Object.hasOwn(message, 'result')) waiter.resolve(message.result);
    else waiter.reject(failure('CODEX_RPC_PROTOCOL', 'Codex returned an unrecognized response.'));
  });
  socket.on('error', () => end(failure('CODEX_RPC_TRANSPORT', 'The selected Codex endpoint could not be reached.')));
  socket.on('close', () => end(failure('CODEX_RPC_TRANSPORT', 'The selected Codex endpoint disconnected.')));
  const abort = () => end(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const close = async () => {
    signal?.removeEventListener('abort', abort);
    end(failure('CODEX_RPC_CLOSED', 'Codex protocol connection closed.'));
    socket.terminate();
  };
  const request = (method, params) => {
    if (ended) return Promise.reject(ended);
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => end(failure('CODEX_RPC_TIMEOUT', 'Codex protocol acknowledgement timed out.')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch { end(failure('CODEX_RPC_TRANSPORT', 'Codex protocol transmission failed.')); }
    });
  };
  try {
    await new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => { clean(); reject(signal.reason); };
      const onError = () => { clean(); reject(failure('CODEX_RPC_TRANSPORT', 'Could not open the selected Codex endpoint.')); };
      const onOpen = () => { clean(); resolve(); };
      const clean = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        socket.removeListener('open', onOpen); socket.removeListener('error', onError); socket.removeListener('close', onError);
      };
      socket.once('open', onOpen); socket.once('error', onError); socket.once('close', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onError, timeoutMs);
      if (signal?.aborted) onAbort();
    });
    signal?.throwIfAborted();
    if (ended) throw ended;
    await request('initialize', { clientInfo: { name: 'tendriller-codex-bridge', version: '1' },
      capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    return { request, close };
  } catch (error) { await close(); throw error; }
}
