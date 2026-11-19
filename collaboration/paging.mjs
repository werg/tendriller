import { CollaborationError } from './protocol.mjs';
import { readCollaborationTasks, readCollaborationResults, readCollaborationMessages, readCollaborationThread,
  readCollaborationTask, readCollaborationSnapshot } from './paging-read.mjs';

const MAX_PENDING = 8;
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

/** Own one coherent public read view; never open another application or signer. */
export async function captureCollaborationReader(session, { signal } = {}) {
  if (typeof session?.readView !== 'function') throw new CollaborationError('SESSION_REQUIRED');
  signal?.throwIfAborted(); session.signal?.throwIfAborted();
  let closed = false, closing, pending = 0;
  const held = () => {
    signal?.throwIfAborted(); session.signal?.throwIfAborted();
    if (closed) throw new CollaborationError('COLLABORATION_READER_CLOSED', 'Capture a new reader before querying again');
  };
  const opening = Promise.resolve().then(() => { held(); return session.readView(); });
  function close() {
    if (closing) return closing;
    closed = true; signal?.removeEventListener('abort', abort); session.signal?.removeEventListener('abort', abort);
    // If cancellation races view creation, release that eventual view too.
    closing = opening.then(view => view.release(), () => undefined);
    return closing;
  }
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true }); session.signal?.addEventListener('abort', abort, { once: true });
  try {
    const view = await opening; held();
    // A named-query allowlist does not authorize raw SQL. Probe the public
    // capability now so restricted attachments never receive a usable reader.
    await view.query('SELECT 1', []); held();
    const revision = frozen(structuredClone(view.revision));
    const captured = Object.freeze({ revision, async query(...args) {
      held(); const result = await view.query(...args); held(); return result;
    } });
    async function read(query, input) {
      held();
      if (pending >= MAX_PENDING) throw new CollaborationError('COLLABORATION_READER_BUSY', 'Finish a pending read before starting another', { limit: MAX_PENDING });
      pending++;
      try { const value = await query(captured, input); held(); return Object.freeze({ revision, value }); }
      finally { pending--; }
    }
    return Object.freeze({ revision, get closed() { return closed; }, close,
      tasks: (options = {}) => read(readCollaborationTasks, options),
      results: (options = {}) => read(readCollaborationResults, options),
      thread: options => read(readCollaborationThread, options),
      messages: (options = {}) => read(readCollaborationMessages, options),
      inspect: taskId => read(readCollaborationTask, taskId),
      snapshot: () => read(readCollaborationSnapshot),
    });
  } catch (error) { await close().catch(() => {}); throw error; }
}
