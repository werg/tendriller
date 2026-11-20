// Loaded only into the operator's dedicated synthetic participant. No payload or URL is sent over IPC.
const emit = (kind, count = 1) => process.send?.({ idleSoak: 1, source: 'native', kind, count });
const bytes = value => typeof value === 'string' ? Buffer.byteLength(value) : value?.byteLength ?? value?.size ?? 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init = {}) {
  emit('requests');
  const signals = [AbortSignal.timeout(30000), init.signal, input instanceof Request ? input.signal : undefined].filter(Boolean);
  return originalFetch.call(this, input, { ...init, signal: AbortSignal.any(signals) });
};
const OriginalSocket = globalThis.WebSocket;
if (OriginalSocket) globalThis.WebSocket = new Proxy(OriginalSocket, {
  construct(Target, args) {
    emit('requests');
    const socket = new Target(...args), send = socket.send;
    socket.send = function (value) { const result = send.call(this, value); emit('framesSent'); emit('bytesSent', bytes(value)); return result; };
    socket.addEventListener('open', () => emit('socketsOpened'));
    socket.addEventListener('close', () => emit('socketsClosed'));
    socket.addEventListener('message', e => { emit('framesReceived'); emit('bytesReceived', bytes(e.data)); });
    return socket;
  },
});
// A private native bootstrap may instrument actual model dispatch / notification handling with this fixed numeric API.
Object.defineProperty(globalThis, Symbol.for('tendriller.idle-soak.record'), { value: emit });
process.on('disconnect', () => process.exit(75));

// Observation must not keep a completed native participant artificially alive.
process.channel?.unref();
