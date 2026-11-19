// A page-local review controller; it never submits a domain command automatically.
// The caller's analyzer may explicitly retain/share evidence. Only the separate
// commit callback submits the person's reviewed domain values.
function immutableJSON(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw TypeError('Review context, analysis and edited values must be finite, acyclic plain JSON.');
  seen.add(value);
  const copy = Array.isArray(value) ? value.map(item => immutableJSON(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJSON(item, seen)]));
  seen.delete(value); return Object.freeze(copy);
}
function waitOwned(task, signal) {
  const observed = Promise.resolve(task);
  if (signal.aborted) { void observed.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    observed.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function createReviewedInput({ analyze, commit, onChange, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof analyze !== 'function' || typeof commit !== 'function') throw TypeError('Provide explicit analyze and commit functions.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw TypeError('maxBytes must be a positive safe integer.');
  const lifetime = new AbortController();
  const owned = AbortSignal.any([lifetime.signal, ...[signal].filter(Boolean)]);
  let closed = false, work, revision = 0, dispatched = false;
  let snapshot = Object.freeze({ phase: 'idle', candidate: null, analysis: null,
    reviewed: null, operationId: null, result: null, error: null });
  const update = value => {
    if (closed) return;
    snapshot = Object.freeze({ ...snapshot, ...value });
    try { onChange?.(snapshot); } catch { /* Observation cannot change the reviewed action. */ }
  };
  const assertEditable = () => {
    owned.throwIfAborted();
    if (dispatched) throw Error('A commit was dispatched. Inspect its original operation ID; this controller cannot discard, retry or reapply it.');
  };
  function begin(external) {
    work?.abort(Error('Review work was superseded.'));
    work = new AbortController();
    return { version: ++revision, signal: AbortSignal.any([owned, work.signal, ...[external].filter(Boolean)]) };
  }
  const stillCurrent = job => { job.signal.throwIfAborted(); if (closed || job.version !== revision) throw Error('Review work was superseded.'); };
  async function capture({ blob, context, signal: external } = {}) {
    assertEditable();
    if (!(blob instanceof Blob) || !blob.size) throw TypeError('Capture needs a nonempty immutable Blob.');
    if (blob.size > maxBytes) throw RangeError(`Capture exceeds the ${maxBytes}-byte review limit.`);
    const capturedContext = immutableJSON(context), bytes = blob.slice(0, blob.size, blob.type), job = begin(external);
    update({ phase: 'capturing', candidate: null, analysis: null, reviewed: null, error: null });
    try {
      const digest = await waitOwned(bytes.arrayBuffer().then(value => crypto.subtle.digest('SHA-256', value)), job.signal);
      stillCurrent(job);
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const candidate = Object.freeze({ id: crypto.randomUUID(), blob: bytes, sha256,
        type: bytes.type, size: bytes.size, context: capturedContext });
      update({ phase: 'captured', candidate }); return candidate;
    } catch (error) {
      if (!closed && job.version === revision) update({ phase: 'error', error });
      throw error;
    }
  }
  async function runAnalysis({ signal: external } = {}) {
    assertEditable();
    const candidate = snapshot.candidate;
    if (!candidate) throw Error('Capture evidence before requesting analysis.');
    const job = begin(external); update({ phase: 'analyzing', error: null });
    try {
      job.signal.throwIfAborted();
      const result = await waitOwned(analyze({ candidate, signal: job.signal }), job.signal);
      stillCurrent(job);
      const analysis = immutableJSON(result);
      // Analysis is a suggestion associated with this exact candidate. It never
      // overwrites human-edited values or becomes an application command here.
      update({ phase: snapshot.reviewed === null ? 'captured' : 'reviewing', analysis }); return analysis;
    } catch (error) {
      if (!closed && job.version === revision) update({ phase: 'error', error });
      throw error;
    }
  }
  function edit(value) {
    assertEditable();
    if (!snapshot.candidate) throw Error('Capture evidence before reviewing it.');
    const reviewed = immutableJSON(value);
    work?.abort(Error('Explicit editing superseded pending analysis.')); revision++;
    update({ phase: 'reviewing', reviewed, error: null }); return reviewed;
  }
  async function submit({ operationId, signal: external } = {}) {
    assertEditable();
    if (!snapshot.candidate || snapshot.reviewed === null) throw Error('Explicitly review the candidate before committing it.');
    if (typeof operationId !== 'string' || !operationId) throw TypeError('Commit needs a stable caller-owned operation ID.');
    const { candidate, reviewed } = snapshot, job = begin(external);
    job.signal.throwIfAborted(); dispatched = true;
    update({ phase: 'committing', operationId, error: null });
    try {
      const result = immutableJSON(await waitOwned(commit({ candidate, reviewed, operationId, signal: job.signal }), job.signal));
      stillCurrent(job); update({ phase: 'submitted', result }); return result;
    } catch (error) {
      // An aborted response wait cannot establish whether a durable command was
      // saved. Preserve the exact identity for session inspection, not retake.
      if (!closed && job.version === revision) update({ phase: 'uncertain', error });
      throw error;
    }
  }
  function cancel() {
    assertEditable(); work?.abort(Error('Review work was cancelled.')); revision++;
    update({ phase: 'idle', candidate: null, analysis: null, reviewed: null, error: null });
  }
  function close() {
    if (closed) return;
    closed = true; owned.removeEventListener('abort', close); revision++;
    lifetime.abort(Error('Review controller is closed.')); work?.abort(owned.reason);
    snapshot = Object.freeze({ ...snapshot, phase: 'closed' });
  }
  owned.addEventListener('abort', close, { once: true });
  if (owned.aborted) close();
  return Object.freeze({ capture, analyze: runAnalysis, edit, commit: submit, cancel, close,
    get snapshot() { return snapshot; } });
}
