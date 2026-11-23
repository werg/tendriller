// Qualification-only bounded two-lane bridge. The actual public sessions still
// authenticate identities and encrypt/sign every peer exchange across it.
export function createTestConnection(dispatch, { maxFrames = 128, maxBytes = 8 * 1024 * 1024 } = {}) {
  const owner = new AbortController();
  const queues = { reliable: [], live: [] };
  const wakes = { reliable: new Set(), live: new Set() };
  let bytes = 0;

  const wakeLane = lane => {
    for (const resolve of wakes[lane]) resolve();
    wakes[lane].clear();
  };

  const close = async () => {
    if (owner.signal.aborted) return;
    owner.abort(Error('Fixture connection closed.'));
    queues.reliable.length = 0;
    queues.live.length = 0;
    bytes = 0;
    wakeLane('reliable');
    wakeLane('live');
  };

  const frames = lane => async function* (signal) {
    const lifetime = signal ? AbortSignal.any([owner.signal, signal]) : owner.signal;
    const wake = () => wakeLane(lane);
    lifetime.addEventListener('abort', wake);
    try {
      while (!lifetime.aborted) {
        if (queues[lane].length) {
          const value = queues[lane].shift();
          bytes -= value.length;
          yield value;
        } else {
          await new Promise(resolve => {
            wakes[lane].add(resolve);
            if (lifetime.aborted || queues[lane].length) wake();
          });
        }
      }
    } finally {
      lifetime.removeEventListener('abort', wake);
    }
  };

  const send = lane => async (frame, options = {}) => {
    owner.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    await dispatch(lane, frame);
  };

  return {
    connection: {
      signal: owner.signal,
      close,
      send: send('reliable'),
      frames: frames('reliable'),
      live: {
        signal: owner.signal,
        close,
        frames: frames('live'),
        async trySend(frame, options) {
          await send('live')(frame, options);
          return true;
        },
      },
    },
    accept(lane, frame) {
      if (owner.signal.aborted) return false;
      const chunk = frame instanceof Uint8Array ? frame.slice() : new Uint8Array(frame);
      if (!Object.hasOwn(queues, lane) || queues[lane].length >= maxFrames || bytes + chunk.length > maxBytes) {
        throw Error('Fixture frame budget exceeded.');
      }
      queues[lane].push(chunk);
      bytes += chunk.length;
      wakeLane(lane);
      return true;
    },
    close,
  };
}
