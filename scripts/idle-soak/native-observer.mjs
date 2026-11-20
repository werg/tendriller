// Loaded only into the operator's dedicated synthetic participant. No payload or URL is sent over IPC.
import { classifyTransport, transportCategories } from './classification.mjs';
const emit = (kind, count = 1, category = 'other') => process.send?.({ idleSoak: 1, source: 'native', kind, count,
  category: transportCategories.includes(category) ? category : 'other' });
const bytes = value => typeof value === 'string' ? Buffer.byteLength(value) : value?.byteLength ?? value?.size ?? 0;
let pending = 0;
const activity = () => process.send?.({ idleSoakActivity: 1, source: 'native', pending });
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init = {}) {
  emit('requests', 1, classifyTransport(input));
  const signals = [AbortSignal.timeout(30000), init.signal, input instanceof Request ? input.signal : undefined].filter(Boolean);
  pending++; activity();
  return Promise.resolve().then(() => originalFetch.call(this, input, { ...init, signal: AbortSignal.any(signals) }))
    .finally(() => { pending--; activity(); });
};
const OriginalSocket = globalThis.WebSocket;
if (OriginalSocket) globalThis.WebSocket = new Proxy(OriginalSocket, {
  construct(Target, args) {
    const category = classifyTransport(args[0]);
    emit('requests', 1, category);
    const socket = new Target(...args), send = socket.send;
    socket.send = function (value) { const result = send.call(this, value); emit('framesSent', 1, category); emit('bytesSent', bytes(value), category); return result; };
    socket.addEventListener('open', () => emit('socketsOpened', 1, category));
    socket.addEventListener('close', () => emit('socketsClosed', 1, category));
    socket.addEventListener('message', e => { emit('framesReceived', 1, category); emit('bytesReceived', bytes(e.data), category); });
    return socket;
  },
});
// A private native bootstrap may instrument actual model dispatch / notification handling with this fixed numeric API.
Object.defineProperty(globalThis, Symbol.for('tendriller.idle-soak.record'), { value: emit });
process.on('disconnect', () => process.exit(75));

// Observation must not keep a completed native participant artificially alive.
process.channel?.unref();
