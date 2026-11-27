// Operational commands use the application's public session composition. This module
// has no transport, signer, delivery queue, event checkpoint or data store.
import { createHash } from 'node:crypto';
import { pack } from './pack.mjs';
import { diagnoseApplicationSession } from '@tendriller/core/diagnostics';
import { retainPublicationBlobs } from '@tendriller/core/publication-blobs';

function invocationFailure(error, signal) {
  // A watch classifies intentional cancellation itself; its remaining failures
  // carry primary read/output and cleanup evidence that must not be relabeled.
  if (!signal?.aborted || signal.reason === error || error?.watch) return error;
  const reason = signal.reason;
  return Object.assign(new Error(reason?.message ?? 'Invocation interrupted', { cause: error }), {
    code: reason?.code ?? 'invocation_interrupted',
    ...(error?.operation ? { operation: error.operation } : {}),
    ...(error?.publication ? { publication: error.publication } : {}),
    ...(error?.watch ? { watch: error.watch } : {}),
    ...(error?.revision !== undefined ? { revision: error.revision } : {}),
  });
}

/** How long a cancelled action may take to release its own attached resources (for example a captured read view)
 * before the attachment is detached under it. */
const ABORT_DETACH_GRACE_MS = 5000;

/** Attach to one page of the running agent program for one invocation. `open`
 * returns { session, control?, detach() }; detaching never stops the agent. */
export async function withSession(open, run, { signal, detachGraceMs = ABORT_DETACH_GRACE_MS } = {}) {
  if (typeof open !== 'function') throw Error('Supply the page attachment.');
  signal?.throwIfAborted();
  let owned;
  try { owned = await open({ signal }); }
  catch (error) { throw invocationFailure(error, signal); }
  const dispose = typeof owned?.detach === 'function' ? () => owned.detach()
    : typeof owned?.session?.detach === 'function' ? () => owned.session.detach()
      : typeof owned?.close === 'function' ? () => owned.close() : undefined;
  if (!owned?.session || !dispose) throw Error('A page attachment must return { session, detach } with a local detach method; detaching must not stop the agent program.');
  let closing, actionSettled;
  const close = () => closing ??= Promise.resolve().then(dispose);
  // Cancellation first lets the cooperative action finish releasing what it holds on the attachment (a view release is an
  // owner request, so detaching beneath it would turn a clean stop into a cleanup failure). Only an action that ignores the
  // signal is detached after the bounded grace, which also fails its pending owner requests.
  const abort = () => {
    void (async () => {
      await Promise.resolve();
      let timer;
      const grace = new Promise(resolve => { timer = setTimeout(resolve, detachGraceMs); });
      try { await Promise.race([actionSettled ?? Promise.resolve(), grace]); } finally { clearTimeout(timer); }
      await close();
    })().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let result, failure;
  try {
    signal?.throwIfAborted();
    const action = run({ ...owned, mode: 'attach' });
    actionSettled = Promise.resolve(action).then(() => {}, () => {});
    result = await action;
  } catch (error) {
    failure = invocationFailure(error, signal);
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await close(); }
    catch (cleanupError) {
      if (!failure) failure = cleanupError;
      else {
        if (!(failure instanceof Error) || !Object.isExtensible(failure)) failure = new Error('Application action failed', { cause: failure });
        failure.cleanupError = cleanupError;
      }
    }
  }
  if (failure) throw failure;
  return result;
}

const required = (value, description) => {
  if (typeof value !== 'string' || !value.length) throw Error(`Supply ${description}`);
  return value;
};
export function jsonInput(value, description = 'JSON input') {
  if (value === undefined) throw Error(`Supply ${description}`);
  try { return JSON.parse(value); } catch { throw Error(`Invalid ${description}`); }
}
const authorTime = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > (1n << 63n) - 1n) throw Error('Author time must be an exact nonnegative int64 decimal string');
  return BigInt(value);
};
const identity = options => ({ operationId: required(options.operation, '--operation with a stable operation identity'),
  ...(options['author-time'] === undefined ? {} : { authorTimestampMs: authorTime(options['author-time']) }) });
const controlOf = owned => {
  if (!owned.control) throw Error('This action needs an independently authorized publisher/control port returned by the bootstrap. No data root or native participant is required to prepare/publish the browser-first starter.');
  return owned.control;
};
async function inspection(session, id) {
  const operation = await session.operations.get(id);
  return operation === null ? null : operation.inspect();
}
async function observe(operation, options, signal) {
  if (options.wait !== undefined) {
    if (!['materialized', 'retained', 'finalized'].includes(options.wait)) throw Error('Use --wait materialized, retained, or finalized');
    await operation[options.wait]({ signal });
  }
  return operation.inspect();
}

/** Call one public command. Operation identities and exact retry semantics stay in Chronolog. */
export async function runSessionCommand(owned, command, args, options = {}, { signal } = {}) {
  const { session } = owned;
  signal?.throwIfAborted();
  if (command === 'describe') return session.describe();
  if (command === 'status') return session.status;
  if (command === 'self') return { mode: 'attach', page: owned.page ?? null, applicationId: session.applicationId,
    identity: { publicKey: session.identity.publicKey }, endpoint: session.endpoint ?? null };
  if (command === 'endpoints') {
    if (typeof session.endpoints !== 'function') throw Error('Endpoint diagnostics require an attached application owner.');
    return session.endpoints();
  }
  if (command === 'doctor') return diagnoseApplicationSession(session, { mode: 'attach', signal });
  if (command === 'query') return session.query(required(args[0], 'a query name'), jsonInput(args[1] ?? '{}'));
  if (command === 'operation') return inspection(session, required(args[0], 'an operation identity'));
  if (command === 'command') {
    const metadata = identity(options);
    try {
      const operation = await session.command(required(args[0], 'a command name'), jsonInput(args[1]), metadata);
      return await observe(operation, options, signal);
    } catch (error) {
      error.operation = await inspection(session, metadata.operationId).catch(() => null); throw error;
    }
  }
  if (command === 'command-batch') {
    const items = jsonInput(args[0], 'command batch JSON array');
    if (!Array.isArray(items) || items.length > 64) throw Error('Supply a JSON array of 0..64 command objects');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['operationId', 'command', 'input', 'authorTimestampMs'].includes(key)) || !Object.hasOwn(item, 'input')) throw Error('Every batch item needs command, input and stable operationId');
      required(item.operationId, 'operationId on every command'); required(item.command, 'command name');
      if (item.authorTimestampMs !== undefined) authorTime(item.authorTimestampMs);
    }
    const results = [];
    for (const item of items) {
      if (signal?.aborted) break;
      try {
        const operation = await session.command(item.command, item.input, { operationId: item.operationId, ...(item.authorTimestampMs === undefined ? {} : { authorTimestampMs: authorTime(item.authorTimestampMs) }) });
        results.push({ operationId: item.operationId, command: item.command, observation: await observe(operation, options, signal) });
      } catch (error) {
        results.push({ operationId: item.operationId, command: item.command, observation: await inspection(session, item.operationId).catch(() => null),
          error: { code: error?.code ?? 'operation_uncertain', message: error?.message ?? String(error) }, nextAction: 'Inspect this original ID; exact retry never changes authored time or signed intent.' }); break;
      }
    }
    return { results, complete: results.length === items.length && results.every(item => !item.error), nextIndex: results.length };
  }
  if (command === 'retry') return observe(await session.operations.retry(required(args[0], 'the original operation identity')), options, signal);
  if (command === 'events') {
    const view = await session.readView();
    try { return await view.readEvents({ ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.topics === undefined ? {} : { topics: jsonInput(options.topics, 'topic array JSON') }),
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }) }); }
    finally { await view.release(); }
  }
  if (command === 'finality') {
    const record = async value => {
      const [{ encodeRecord }, { authorityRecord }] = await Promise.all([import('@chronolog/peer-session'), import('@tendriller/core/authority')]);
      return authorityRecord(encodeRecord(value));
    };
    if (args[0] === 'status') {
      const status = session.finality.status();
      return {
        hasActiveFinality: status.hasActiveFinality,
        closedThroughMs: status.closedThroughMs === null ? null : status.closedThroughMs.toString(),
        checkpoints: status.checkpoints.length,
      };
    }
    if (args[0] === 'close') {
      const checkpoint = await session.finality.createCheckpoint({ throughMs: authorTime(required(options.through, '--through with an explicit author-time frontier')) });
      return { closedThroughMs: checkpoint.payload.closedThroughMs.toString(), checkpoint: await record(checkpoint) };
    }
    if (args[0] === 'submit') {
      const [{ decodeRecord }, { authorityRecordBytes }] = await Promise.all([import('@chronolog/peer-session'), import('@tendriller/core/authority')]);
      const parsed = decodeRecord(authorityRecordBytes(jsonInput(args[1], 'canonical hex finality checkpoint record')));
      return session.finality.submitCheckpoints(Array.isArray(parsed) ? parsed : [parsed]);
    }
    throw Error('Use finality status, close, or submit; none is explicitly unsupported and unavailable finalizers never block local submission');
  }
  if (command === 'definition') return controlOf(owned).definition();
  if (command === 'publication') return controlOf(owned).publication();
  if (command === 'publication-operation') {
    const control = controlOf(owned);
    if (typeof control.publicationOperation !== 'function') throw Object.assign(Error('The installed Chronolog package cannot inspect retained publication receipts. Install the qualified composition; use publication to inspect the signed selected head in the meantime.'), { code: 'publication_inspection_unsupported' });
    return control.publicationOperation(required(args[0], 'the original publication operation identity'));
  }
  if (command === 'publish') {
    const control = controlOf(owned);
    const source = pack(required(args[0], 'the complete authored directory'), { entry: options.entry });
    const manifestFiles = source.files.map(file => ({ path: file.path, type: file.type, size: file.size, hash: file.sha256 }));
    let currentHead = null;
    try { currentHead = await control.publication(); }
    catch (error) {
      // Automatic identities depend on a verified head. A failed read is not an empty history.
      if (options.operation === undefined) throw error;
      // An explicitly retained identity can still retry with the complete original bytes.
    }
    const currentFiles = currentHead?.release?.files ?? currentHead?.publication?.payload?.files ?? [];
    const currentId = currentHead?.opId ?? currentHead?.publication?.id ?? null;
    const currentRevision = currentHead?.revision ?? currentHead?.publication?.payload?.revision ?? -1;
    const knownHashes = new Set(currentFiles.map(file => `${file.hash}:${file.size}`));
    const operationId = options.operation ?? (() => {
      const digest = createHash('sha256').update(JSON.stringify({
        previous: currentId, entry: source.entry, files: manifestFiles,
      })).digest('hex').slice(0, 16);
      return `pub-${currentRevision + 1}-${digest}`;
    })();
    let publication;
    try {
      publication = await control.preparePublication({ operationId, entry: source.entry, files: manifestFiles });
      const uniqueFiles = [...new Map(source.files.map(file => [file.sha256, file])).values()];
      const deltaAssets = uniqueFiles
        .filter(file => !knownHashes.has(`${file.sha256}:${file.size}`))
        .map(file => ({ hash: file.sha256, bytes: file.bytes.toString('base64') }));
      let receipt;
      try {
        receipt = await control.publish(publication, deltaAssets);
      } catch (error) {
        const missing = error?.code === 'peer_publication_content_missing' || error?.cause?.code === 'peer_publication_content_missing' ||
          /peer_publication_content_missing/u.test(error?.message ?? '');
        if (!missing || deltaAssets.length === uniqueFiles.length) throw error;
        const fullAssets = uniqueFiles.map(file => ({ hash: file.sha256, bytes: file.bytes.toString('base64') }));
        receipt = await control.publish(publication, fullAssets);
      }
      // Best-effort local blob seeding so this agent can serve historical assets
      // to connected Chronolog peers if the host later prunes this version.
      try {
        await retainPublicationBlobs(
          session,
          uniqueFiles.map(file => ({ hash: file.sha256, bytes: file.bytes })),
          { signal },
        );
      } catch { /* Never fail a committed publish if blob retention is unavailable. */ }
      return receipt;
    } catch (error) {
      const receiptId = error.receipt?.opId ?? error.receipt?.publication?.id ?? null;
      const publicationId = publication?.opId ?? publication?.id ?? null;
      const committed = error.outcome === 'committed' && receiptId !== null && (publicationId === null || receiptId === publicationId);
      error.publication = { operationId: publication?.payload?.operationId ?? operationId,
        ...(publication?.payload?.operationId && publication.payload.operationId !== operationId ? { localOperationId: operationId } : {}),
        publicationId,
        outcome: committed ? 'committed' : publication ? 'unknown' : 'not_submitted',
        phase: error.phase ?? (publication ? 'submission' : 'preparation'),
        receipt: committed ? { publicationId: receiptId, version: error.receipt.version } : null,
        nextAction: committed
          ? 'The host acknowledged this publication. Reopen the same device and inspect publication plus publication-operation; verify the signed selected head before calling the release current.'
          : 'Keep this operation identity, device store and authored bytes. Inspect publication and publication-operation after reopening. Retry only the original publication intent; do not create a replacement operation because the response was uncertain.' };
      throw error;
    }
  }
  if (command === 'signal') {
    await session.signals.send(required(args[0], 'a live topic'), jsonInput(args[1]),
      options.ttl === undefined ? {} : { ttlMs: Number(options.ttl) });
    return { sent: true, durable: false };
  }
  throw Error(`Unknown application command: ${command}`);
}

/** Stream disposable live signals (e.g. page dev/telemetry errors and diagnostics) as NDJSON. */
export async function watchSignals(owned, emit, { signal, topics = ['dev/telemetry', 'dev/error', 'dev/health'], mode = 'all' } = {}) {
  const session = owned.session;
  let count = 0;
  try {
    signal?.throwIfAborted();
    for await (const item of session.signals.subscribe({ topics, mode, signal })) {
      signal?.throwIfAborted();
      await emit({
        topic: item.topic,
        authorId: item.authorId,
        issuedAtMs: item.issuedAtMs,
        ...(item.stream ? { stream: item.stream } : {}),
        payload: item.payload,
      });
      count++;
    }
  } catch (error) {
    if (!(signal?.aborted && (error === signal.reason || error?.name === 'AbortError'))) throw error;
  }
  return { mode: 'signals', topics, count, reason: signal?.reason?.code === 'invocation_timeout' ? 'timeout' : 'interrupted' };
}

// Subscribe before observing initial local state, so a quiet retained owner is
// immediately useful and an invalidation during the first capture is not lost.
async function* initialAndChanges(session, signal) {
  const stop = new AbortController(), lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const changes = session.changes({ signal: lifetime })[Symbol.asyncIterator]();
  let pending = Promise.resolve(changes.next());
  pending.catch(() => {});
  try {
    yield { kind: 'status', status: session.status };
    while (!lifetime.aborted) {
      const next = await pending;
      if (next.done) return;
      yield next.value;
      if (lifetime.aborted) return;
      pending = Promise.resolve(changes.next()); pending.catch(() => {});
    }
  } finally { stop.abort(); await changes.return?.(); }
}

/** Pulling the next change is backpressure. Emitted cursors are not processing receipts. */
export async function watchSession(owned, emit, { signal, events = false, cursor, topics, limit } = {}) {
  const session = owned.session;
  let lastCursor = cursor ?? null, lastRevision = null, emitting = false, releaseFailed = false, cancelledFailure;
  const isInvocationCancellation = error => Boolean(signal?.aborted && (error === signal.reason ||
    (error?.name === 'AbortError' && (error.cause === undefined || error.cause === signal.reason))));
  const progress = () => ({ mode: events ? 'events' : 'changes', cursor: lastCursor, revision: lastRevision });
  const emitDelivered = async value => {
    emitting = true;
    await emit(value);
    emitting = false;
    lastRevision = value.revision ?? null;
    if (events) lastCursor = value.cursor;
  };
  try {
    signal?.throwIfAborted();
    for await (const change of initialAndChanges(session, signal)) {
      signal?.throwIfAborted();
      if (!events) { await emitDelivered(change); continue; }
      if (lastRevision && change.revision?.digest === lastRevision.digest) continue;
      const view = await session.readView();
      let viewFailure, viewFailed = false;
      try {
        if (lastRevision && lastRevision.digest !== view.revision.digest) await emitDelivered({ kind: 'reset', reason: 'materialization-revised', revision: view.revision, events: [], cursor: null, hasMore: true });
        for (;;) {
          signal?.throwIfAborted();
          const batch = await view.readEvents({ ...(lastCursor === null ? {} : { cursor: lastCursor }),
            ...(topics === undefined ? {} : { topics }), ...(limit === undefined ? {} : { limit }) });
          if (batch.hasMore && batch.cursor === lastCursor)
            throw Object.assign(Error('Event cursor did not advance; inspect the retained history before restarting'), { code: 'EVENT_CURSOR_STALLED' });
          if (batch.cursor !== lastCursor) await emitDelivered({ kind: 'snapshot', ...batch });
          if (!batch.hasMore) break;
        }
      } catch (error) {
        viewFailed = true; viewFailure = error;
        // Classify the original failure now. A later timeout during asynchronous
        // release must not turn a failed read into a successful cancellation.
        cancelledFailure = isInvocationCancellation(error);
        throw error;
      }
      finally {
        try { await view.release(); }
        catch (cleanupError) {
          releaseFailed = true;
          if (!viewFailed) throw cleanupError;
          if (!(viewFailure instanceof Error) || !Object.isExtensible(viewFailure))
            viewFailure = new Error('Event watch failed', { cause: viewFailure });
          viewFailure.cleanupError = cleanupError;
          throw viewFailure;
        }
      }
    }
    if (!signal?.aborted) throw session.signal?.reason ?? Object.assign(
      Error('Session change stream ended unexpectedly; restart the listener after checking the session.'), { code: 'SESSION_WATCH_ENDED' });
  } catch (error) {
    // Only failures caused by this invocation's cancellation are normal stops.
    // Cleanup and independent read/output failures remain failures even if an
    // interruption arrives while those failures are being cleaned up.
    if (releaseFailed || !(cancelledFailure ?? isInvocationCancellation(error))) {
      let failure = error instanceof Error && Object.isExtensible(error) ? error : new Error('Session watch failed', { cause: error });
      if (!emitting && owned.mode === 'attach' && session.signal?.aborted && error === session.signal.reason) {
        const cause = session.signal.reason ?? failure;
        failure = Object.assign(new Error(`Owner connection lost: ${cause?.message ?? 'OWNER_UNREACHABLE'}. Restart this attachment after the owner is available.`, { cause }), {
          code: cause?.code ?? 'OWNER_UNREACHABLE', ...(Number.isInteger(cause?.status) ? { status: cause.status } : {}),
          ...(failure.cleanupError ? { cleanupError: failure.cleanupError } : {}),
        });
      }
      failure.watch = progress();
      throw failure;
    }
  }
  return { ...progress(), reason: signal?.reason?.code === 'invocation_timeout' ? 'timeout' : 'interrupted' };
}

/** One combined change/event stream over several pages, with a cursor per page.
 * Each page attachment keeps its own backpressure; any page failure stops all. */
export async function watchPages(pages, emit, { signal, events = false, cursor = {}, topics, limit } = {}) {
  const stop = new AbortController(), lifetime = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
  const cursors = Object.fromEntries(pages.map(({ page }) => [page, cursor?.[page] ?? null]));
  const revisions = {};
  let output = Promise.resolve();
  const serialized = value => (output = output.then(() => emit(value)));
  const progress = () => ({ mode: events ? 'events' : 'changes', cursors: { ...cursors }, revisions: { ...revisions } });
  try {
    await Promise.all(pages.map(({ page, open }) => withSession(open, owned => watchSession(owned, async value => {
      await serialized({ page, ...value });
      revisions[page] = value.revision ?? null;
      if (events) cursors[page] = value.cursor;
    }, { signal: lifetime, events, ...(cursors[page] === null ? {} : { cursor: cursors[page] }), topics, limit }), { signal: lifetime })
      .catch(error => { if (!stop.signal.aborted) stop.abort(error); throw Object.assign(error, { page }); })));
  } catch (error) {
    const failure = error instanceof Error && Object.isExtensible(error) ? error : new Error('Session watch failed', { cause: error });
    failure.watch = progress();
    throw failure;
  }
  return { ...progress(), reason: signal?.reason?.code === 'invocation_timeout' ? 'timeout' : 'interrupted' };
}
