// Operational commands use the application's public session composition. This module
// has no transport, signer, delivery queue, event checkpoint or data store.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pack } from './pack.mjs';
import { diagnoseApplicationSession } from '@tendriller/core/diagnostics';

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
    ...(error?.recovery !== undefined ? { recovery: error.recovery } : {}),
  });
}

export async function withSession(modulePath, run, { signal, mode, profile, runId } = {}) {
  if (!modulePath) throw Error('Supply --session with a module exporting attachSession({ signal }) or openSession({ signal }). A page handle does not open a Chronolog session. Run tendril guide --server YOUR_SERVICE_ORIGIN and follow /docs/BUILD_AN_APP.md to configure authority, enroll the device and compose the session.');
  if (mode !== undefined && !['attach', 'own', 'independent'].includes(mode)) throw Error('Use --mode attach, own, or independent');
  if (profile !== undefined && (typeof profile !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(profile))) throw Error('Use --profile with a retained profile name');
  if (mode === 'independent' && !profile) throw Error('--mode independent requires --profile naming a separately provisioned device');
  if (runId !== undefined && (typeof runId !== 'string' || !runId.length || runId.length > 128 || /[\u0000-\u001f]/u.test(runId))) throw Error('Use --run with a bounded run identity');
  signal?.throwIfAborted();
  const bootstrap = await import(pathToFileURL(resolve(modulePath)).href);
  const selected = mode ?? (typeof bootstrap.attachSession === 'function' ? 'attach' : 'own');
  const hook = selected === 'attach' ? bootstrap.attachSession : bootstrap.openSession;
  if (typeof hook !== 'function') throw Error(selected === 'attach'
    ? 'The session module must export attachSession({ signal, profile, context }). Attachment never falls back to opening a signer.'
    : 'The session module must export openSession({ signal, mode, profile }) and acquire exclusive ownership of the selected retained profile.');
  let owned;
  try { owned = await hook({ signal, mode: selected, profile, ...(runId === undefined ? {} : { context: { runId } }) }); }
  catch (error) { throw invocationFailure(error, signal); }
  const dispose = selected === 'attach'
    ? typeof owned?.detach === 'function' ? () => owned.detach() : typeof owned?.session?.detach === 'function' ? () => owned.session.detach() : undefined
    : typeof owned?.close === 'function' ? () => owned.close() : typeof owned?.session?.close === 'function' ? () => owned.session.close() : undefined;
  if (!owned?.session || !dispose) throw Error(selected === 'attach'
    ? 'attachSession must return { session, detach? } with a local detach method; detaching must not stop the owner.'
    : 'openSession must return { session, control?, close? }; close releases its exclusive profile ownership.');
  let closing;
  const close = () => closing ??= Promise.resolve().then(dispose);
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let result, failure;
  try {
    signal?.throwIfAborted();
    result = await run({ ...owned, mode: selected });
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
const identity = options => ({ operationId: required(options.operation, '--operation with a stable operation identity'),
  ...(options['based-on'] === undefined ? {} : { basedOn: jsonInput(options['based-on'], 'captured revision JSON') }) });
const controlOf = owned => {
  if (!owned.control) throw Error('This action requires the session-owned control participant returned by openSession. Connect it with session.connectControlParticipant({ exchange }) and return { session, control }; see /docs/BUILD_AN_APP.md. Signed publication also requires an explicit publisher grant, independent of page access.');
  return owned.control;
};

/** Call one public command. Operation identities and exact retry semantics stay in Chronolog. */
export async function runSessionCommand(owned, command, args, options = {}, { signal } = {}) {
  const { session } = owned;
  signal?.throwIfAborted();
  if (command === 'describe') return session.describe();
  if (command === 'status') return session.status;
  if (command === 'self') return { mode: owned.mode ?? 'own', applicationId: session.applicationId,
    historyId: session.historyId ?? null, deviceId: session.deviceId, endpoint: session.endpoint ?? null };
  if (command === 'endpoints') {
    if (typeof session.endpoints !== 'function') throw Error('Endpoint diagnostics require an attached application owner.');
    return session.endpoints();
  }
  if (command === 'doctor') return diagnoseApplicationSession(session, { mode: owned.mode ?? 'own', signal });
  if (command === 'query') return session.query(required(args[0], 'a query name'), jsonInput(args[1] ?? '{}'));
  if (command === 'operation') return session.operations.inspect(required(args[0], 'an operation identity'));
  if (command === 'command' || command === 'reapply') {
    const metadata = identity(options);
    const operation = command === 'command'
      ? await session.command(required(args[0], 'a command name'), jsonInput(args[1]), metadata)
      : await session.reapply(required(args[0], 'the abandoned operation identity'), required(args[1], 'a command name'), jsonInput(args[2]), metadata);
    if (options.saved) return operation.get();
    try {
      const applied = await operation.applied({ signal });
      return options.shared ? { applied, retained: await operation.shared({ signal }) } : applied;
    } catch (error) {
      // A cancelled waiter does not cancel or replace its saved signed attempt.
      error.operation = await session.operations.get(metadata.operationId).catch(() => null);
      throw error;
    }
  }
  if (command === 'command-batch') {
    const items = jsonInput(args[0], 'command batch JSON array');
    if (!Array.isArray(items) || items.length > 64) throw Error('Supply a JSON array of 0..64 command objects.');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).some(key => !['operationId', 'command', 'input', 'basedOn'].includes(key)) ||
          !Object.hasOwn(item, 'input')) throw Error('Every batched command needs a name, input and stable operationId.');
      required(item.operationId, 'operationId on every batched command');
      required(item.command, 'command name on every batched command');
    }
    const results = [];
    for (const item of items) {
      if (signal?.aborted) break;
      const opId = item.operationId;
      try {
        const handle = await session.command(item.command, item.input, {
          operationId: opId, ...(item.basedOn === undefined ? {} : { basedOn: item.basedOn }),
        });
        if (options.saved) {
          const state = await handle.get();
          results.push({ operationId: opId, command: item.command,
            lifecycle: state?.status === 'applied' ? state.outcome === 'rejected' ? 'rejected' : 'applied'
              : state?.status === 'saved' ? 'recorded' : 'unknown', state });
        } else {
          const applied = await handle.applied({ signal });
          results.push({ operationId: opId, command: item.command, lifecycle: applied.outcome === 'rejected' ? 'rejected' : 'applied', applied });
        }
      } catch (error) {
        results.push({ operationId: opId, command: item.command, lifecycle: 'unknown',
          state: await session.operations.get(opId).catch(() => null),
          error: { code: error?.code ?? 'operation_uncertain', message: error?.message ?? String(error) },
          nextAction: 'Inspect this original operation before retrying. Keep its ID and input unchanged.' });
        break;
      }
    }
    return { results, complete: results.length === items.length, nextIndex: results.length };
  }

  if (command === 'retry') {
    const operationId = required(args[0], 'the original operation identity');
    await session.retry(operationId);
    return options.saved ? session.operations.get(operationId) : session.operations.wait(operationId, { signal });
  }
  if (command === 'events') {
    const view = await session.readView();
    try { return await view.readEvents({ ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.topics === undefined ? {} : { topics: jsonInput(options.topics, 'topic array JSON') }),
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }) }); }
    finally { await view.release(); }
  }
  if (command === 'recovery') {
    if (args[0] === 'inspect') return session.recovery.inspect();
    const transitionId = required(options.transition, '--transition with a stable transition identity');
    if (owned.mode === 'attach') {
      if (args[0] === 'takeover') return session.recovery.takeover({ transitionId, signal });
      if (args[0] === 'handover') return session.recovery.handover({ transitionId, coordinator: required(args[1], 'the successor device identity'), signal });
      throw Error('Use recovery inspect, takeover, or handover <coordinator>');
    }
    const control = controlOf(owned);
    if (args[0] === 'takeover') return session.recovery.takeover(control, { transitionId });
    if (args[0] === 'handover') return session.recovery.handover(control, { transitionId, coordinator: required(args[1], 'the successor device identity') });
    throw Error('Use recovery inspect, takeover, or handover <coordinator>');
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
    const knownHashes = new Set((currentHead?.publication?.payload?.files ?? []).map(file => `${file.hash}:${file.size}`));
    const operationId = options.operation ?? (() => {
      const digest = createHash('sha256').update(JSON.stringify({
        previous: currentHead?.publication?.id ?? null, entry: source.entry, files: manifestFiles,
      })).digest('hex').slice(0, 16);
      return `pub-${(currentHead?.publication?.payload?.revision ?? -1) + 1}-${digest}`;
    })();
    let publication;
    try {
      publication = await control.preparePublication({ operationId, entry: source.entry, files: manifestFiles });
      const uniqueFiles = [...new Map(source.files.map(file => [file.sha256, file])).values()];
      const deltaAssets = uniqueFiles
        .filter(file => !knownHashes.has(`${file.sha256}:${file.size}`))
        .map(file => ({ hash: file.sha256, bytes: file.bytes.toString('base64') }));
      try {
        return await control.publish(publication, deltaAssets);
      } catch (error) {
        const missing = error?.code === 'peer_publication_content_missing' || error?.cause?.code === 'peer_publication_content_missing' ||
          /peer_publication_content_missing/u.test(error?.message ?? '');
        if (!missing || deltaAssets.length === uniqueFiles.length) throw error;
        const fullAssets = uniqueFiles.map(file => ({ hash: file.sha256, bytes: file.bytes.toString('base64') }));
        return await control.publish(publication, fullAssets);
      }
    } catch (error) {
      const committed = error.outcome === 'committed' && error.receipt?.publication?.id === publication?.id;
      error.publication = { operationId: publication?.payload?.operationId ?? operationId,
        ...(publication?.payload?.operationId && publication.payload.operationId !== operationId ? { localOperationId: operationId } : {}),
        publicationId: publication?.id ?? null,
        outcome: committed ? 'committed' : publication ? 'unknown' : 'not_submitted',
        phase: error.phase ?? (publication ? 'submission' : 'preparation'),
        receipt: committed ? { publicationId: error.receipt.publication.id, version: error.receipt.version } : null,
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
    for await (const change of session.changes({ signal })) {
      signal?.throwIfAborted();
      if (!events) { await emitDelivered(change); continue; }
      const view = await session.readView();
      let viewFailure, viewFailed = false;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const batch = await view.readEvents({ ...(lastCursor === null ? {} : { cursor: lastCursor }),
            ...(topics === undefined ? {} : { topics }), ...(limit === undefined ? {} : { limit }) });
          if (batch.hasMore && batch.cursor === lastCursor)
            throw Object.assign(Error('Event cursor did not advance; inspect the retained history before restarting'), { code: 'EVENT_CURSOR_STALLED' });
          if (batch.cursor !== lastCursor) await emitDelivered(batch);
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
