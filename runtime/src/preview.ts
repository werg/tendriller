import type { RuntimeSocket, RuntimeFrame, FixtureTransport } from "../../contract/index.mjs";

/** In-process fixture transport for the released runtime. Install `.socket` as
 * window.__TENDRIL_TRANSPORT__ before loading tendril.js and set config.preview.
 * Fixtures exchange public protocol frames; no runtime internals are exposed. */
export function createFixtureTransport(): FixtureTransport {
  const sockets = new Set<RuntimeSocket>();
  const listeners = new Set<(frame: RuntimeFrame, reply: (frame: RuntimeFrame) => void) => void>();
  const receive = (frame: RuntimeFrame) => {
    for (const socket of sockets) if (socket.readyState === 1) socket.onmessage?.({ data: JSON.stringify(frame) });
  };
  return {
    socket() {
      const socket: RuntimeSocket = {
        readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
        send(data) {
          if (socket.readyState !== 1) throw new Error("Fixture socket is closed");
          const frame = JSON.parse(data) as RuntimeFrame;
          const reply = (message: RuntimeFrame) => queueMicrotask(() => {
            if (socket.readyState === 1) socket.onmessage?.({ data: JSON.stringify(message) });
          });
          for (const listener of listeners) listener(frame, reply);
        },
        close() {
          if (socket.readyState === 3) return;
          socket.readyState = 3;
          sockets.delete(socket);
          socket.onclose?.();
        },
      };
      sockets.add(socket);
      queueMicrotask(() => { if (socket.readyState === 0) { socket.readyState = 1; socket.onopen?.(); } });
      return socket;
    },
    receive,
    emit(event, data) { receive({ t: "fixture_event", event, data }); },
    onSend(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    disconnect() { for (const socket of [...sockets]) socket.close(); },
  };
}
