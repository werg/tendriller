import { serialize, deserialize } from 'node:v8';

const MAX_FRAME = 1_100_000, MAX_QUEUE = 4_400_000;
const failure = code => Object.assign(new Error(code), { code });

/** Internal Unix frame codec. A terminal rejection gets one bounded flush. */
export function createNativeFrames(socket, onMessage, onFailure, { maxFrame = MAX_FRAME, maxQueue = MAX_QUEUE } = {}) {
  let buffer = Buffer.alloc(0), closed = false, scheduled = false;
  const encoded = value => {
    const payload = serialize(value);
    if (payload.length > maxFrame || socket.writableLength + payload.length + 4 > maxQueue)
      throw failure('SUPERVISOR_BACKPRESSURE');
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length);
    return Buffer.concat([header, payload]);
  };
  const fail = cause => {
    if (closed) return;
    closed = true; buffer = Buffer.alloc(0); socket.pause();
    let terminal;
    try { terminal = onFailure(cause); } catch { /* A failing cleanup still fences the transport. */ }
    if (terminal === undefined || socket.destroyed) { socket.destroy(); return; }
    try {
      // send() is intentionally closed already. Write exactly this final frame
      // directly, then close gracefully so it is not discarded by destroy().
      socket.end(encoded(terminal));
      const timer = setTimeout(() => socket.destroy(), 250); timer.unref();
      socket.once('close', () => clearTimeout(timer));
    } catch { socket.destroy(); }
  };
  function drain() {
    scheduled = false;
    try {
      let count = 0;
      while (!closed && !socket.destroyed && buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (!size || size > maxFrame) throw failure('SUPERVISOR_FRAME_LIMIT');
        if (buffer.length < size + 4) break;
        const value = deserialize(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4); onMessage(value);
        if (++count === 64 && buffer.length) {
          socket.pause(); scheduled = true;
          setImmediate(() => { drain(); if (!closed && !socket.destroyed) socket.resume(); }); break;
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
  socket.on('close', () => { closed = true; buffer = Buffer.alloc(0); });
  return {
    send(value) {
      if (closed || socket.destroyed) throw failure('OWNER_UNREACHABLE');
      let frame;
      try { frame = encoded(value); } catch (error) { fail(error); throw error; }
      socket.write(frame);
    },
    close() { closed = true; buffer = Buffer.alloc(0); },
  };
}
