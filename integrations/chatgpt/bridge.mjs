/** An enrolled native peer, independent from Tendriller's filtered HTTP host. */
const ID = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const DEFAULT_RESULT_BYTES = 256 * 1024;
const DEFAULT_EVENT_BYTES = 16 * 1024;

export class BridgeError extends Error {
  constructor(code, message = code, details) {
    super(message); this.name = 'BridgeError'; this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new BridgeError(code, message, details); };
function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > maximum) fail('BRIDGE_INPUT_INVALID', `Invalid ${name}`);
  return value;
}
function names(values, field, validate = value => NAME.test(value)) {
  if (!Array.isArray(values) || values.length > 128 || values.some(value => typeof value !== 'string' || !validate(value))) {
    fail('BRIDGE_CONFIGURATION_INVALID', `${field} must be an explicit bounded allowlist`);
  }
  return new Set(values);
}
function bounded(value, maximum, code = 'BRIDGE_RESULT_TOO_LARGE') {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $integer: String(item) }
      : item instanceof Uint8Array ? { $bytes: Buffer.from(item).toString('hex') } : item);
  } catch { fail('BRIDGE_RESULT_INVALID', 'The result is not serializable'); }
  if (encoded === undefined) fail('BRIDGE_RESULT_INVALID', 'The result is not serializable');
  if (Buffer.byteLength(encoded) > maximum) fail(code, 'The bounded result limit was exceeded');
  return JSON.parse(encoded);
}

/**
 * openSession returns {session, control} using the public native session API.
 * Account access and egress consent belong to the caller; the signed native
 * grant and declared per-application allowlists are checked here as well.
 */
export function createSessionBridge({ applications, maxResultBytes = DEFAULT_RESULT_BYTES,
  maxEventBytes = DEFAULT_EVENT_BYTES, applyBudgetMs = 0 } = {}) {
  if (!Array.isArray(applications) || applications.length > 128) fail('BRIDGE_CONFIGURATION_INVALID');
  for (const limit of [maxResultBytes, maxEventBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 1024 * 1024) fail('BRIDGE_CONFIGURATION_INVALID');
  }
  if (!Number.isSafeInteger(applyBudgetMs) || applyBudgetMs < 0 || applyBudgetMs > 10_000) fail('BRIDGE_CONFIGURATION_INVALID');
  const configured = new Map(), opened = new Map(), available = new Map(), lifetime = new AbortController();
  let closed = false, closing;
  for (const input of applications) {
    if (!input || !ID.test(input.id) || configured.has(input.id) || typeof input.openSession !== 'function') {
      fail('BRIDGE_CONFIGURATION_INVALID', 'Each application needs a unique identity and an enrolled session factory');
    }
    if (input.eventProjection !== undefined && typeof input.eventProjection !== 'function') fail('BRIDGE_CONFIGURATION_INVALID');
    const entry = { id: input.id, label: text(input.label ?? input.id, 'label', 160), openSession: input.openSession,
      queries: names(input.allowedQueries ?? [], 'allowedQueries'), commands: names(input.allowedCommands ?? [], 'allowedCommands'),
      topics: names(input.eventTopics ?? [], 'eventTopics', value => value.length > 0 && value.length <= 128),
      project: input.eventProjection };
    configured.set(entry.id, entry);
  }
  function entryFor(id) {
    if (closed) fail('BRIDGE_CLOSED');
    const entry = configured.get(id);
    if (!entry) fail('BRIDGE_APPLICATION_UNAVAILABLE');
    return entry;
  }
  async function own(entry) {
    if (!opened.has(entry.id)) {
      const task = Promise.resolve().then(() => entry.openSession({ signal: lifetime.signal })).then(async owned => {
        try {
          if (closed) fail('BRIDGE_CLOSED');
          if (!owned?.session || owned.session.applicationId !== entry.id || !ID.test(owned.session.deviceId)
            || typeof owned.session.close !== 'function' || typeof owned.control?.application !== 'function') {
            fail('BRIDGE_SESSION_INVALID', 'An application requires its own matching native session and verified control participant');
          }
          available.set(entry.id, owned);
          return owned;
        } catch (error) { await owned?.session?.close?.(); throw error; }
      });
      opened.set(entry.id, task);
      void task.catch(() => { if (opened.get(entry.id) === task) opened.delete(entry.id); });
    }
    return opened.get(entry.id);
  }
  async function access(entry, right = 'reader') {
    const owned = await own(entry);
    // The public control participant verifies pinned, monotonic signed authority
    // and adopts it in the session before returning. A stale cached grant is not
    // a remote access decision; failure to refresh fails closed.
    const authority = await owned.control.application({ signal: lifetime.signal });
    lifetime.signal.throwIfAborted();
    if (authority?.descriptor?.payload?.applicationId !== entry.id) fail('BRIDGE_AUTHORITY_SCOPE_MISMATCH');
    const grants = authority.controls?.at(-1)?.payload?.grants;
    const grant = Array.isArray(grants) ? grants.find(value => value.publicKey === owned.session.deviceId) : undefined;
    if (grant?.reader !== true || (right === 'writer' && grant.writer !== true)) fail('BRIDGE_GRANT_REQUIRED', `A current ${right} device grant is required`);
    return { ...owned, grant };
  }
  function permitted(entry, description, kind, name) {
    text(name, `${kind} name`, 128);
    if (!entry[kind].has(name)) fail('BRIDGE_OPERATION_FORBIDDEN');
    const declared = description[kind === 'commands' ? 'commands' : 'queries'];
    if (!Array.isArray(declared) || !declared.some(value => value.name === name)) fail('BRIDGE_OPERATION_UNDECLARED');
  }
  function selected(session, revision) {
    if (session.status.generation !== revision.generation) {
      const error = new BridgeError('APPLICATION_VIEW_RECOVERED', 'The captured generation is no longer selected');
      error.revision = session.revision ?? { generation: session.status.generation };
      throw error;
    }
  }
  async function project(entry, event, revision) {
    if (!entry.topics.has(event.topic) || !entry.project) return null;
    const projection = await entry.project(structuredClone(event), { revision: structuredClone(revision) });
    if (projection === null || projection === undefined) return null;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)
      || !NAME.test(projection.name) || !projection.data || typeof projection.data !== 'object' || Array.isArray(projection.data)) {
      fail('BRIDGE_EVENT_PROJECTION_INVALID');
    }
    const sourceTimestampMs = typeof event.authorTimestampMs === 'string' && /^[0-9]{1,16}$/u.test(event.authorTimestampMs)
      ? Number(event.authorTimestampMs) : NaN;
    return bounded({ name: projection.name, data: projection.data, sourceEventId: event.id,
      sourceOperationId: event.operationId, sourceAuthor: event.author, sourceAttemptId: event.attemptId,
      // Authenticated author metadata is not a trusted server wall clock.
      ...(Number.isSafeInteger(sourceTimestampMs) && sourceTimestampMs <= 8.64e15 ? { sourceTimestampMs } : {}),
      revision }, maxEventBytes, 'BRIDGE_EVENT_TOO_LARGE');
  }
  async function read(id, options = {}) {
    const entry = entryFor(id), owned = await access(entry);
    const { cursor, limit = 128 } = options;
    if (cursor !== undefined) text(cursor, 'event cursor', 128 * 1024);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('BRIDGE_INPUT_INVALID', 'Event limit must be between 1 and 128');
    const view = await owned.session.readView();
    try {
      const batch = await view.readEvents({ topics: [...entry.topics].sort(), limit,
        ...(cursor === undefined ? {} : { cursor }) });
      const events = [];
      for (const event of batch.events) {
        const projection = await project(entry, event, batch.revision);
        if (projection !== null) events.push(projection);
      }
      await access(entry);
      selected(owned.session, batch.revision);
      return bounded({ applicationId: id, revision: batch.revision, cursor: batch.cursor,
        hasMore: batch.hasMore, events }, maxResultBytes);
    } finally { await view.release(); }
  }
  async function findEvent(id, sourceEventId, { maxBatches } = {}) {
    text(sourceEventId, 'source event ID', 512);
    if (maxBatches !== undefined && (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 128)) fail('BRIDGE_INPUT_INVALID');
    const entry = entryFor(id), { session } = await access(entry), view = await session.readView();
    try {
      let cursor;
      // The captured native view is finite. A fixed prefix budget would make
      // every delivery retry fail for a perfectly valid older source. Bound
      // each page, yield to native recovery/close, and finish this selected view.
      for (let scanned = 0; maxBatches === undefined || scanned < maxBatches; scanned++) {
        lifetime.signal.throwIfAborted();
        const batch = await view.readEvents({ topics: [...entry.topics].sort(), limit: 128,
          ...(cursor === undefined ? {} : { cursor }) });
        selected(session, batch.revision);
        const event = batch.events.find(value => value.id === sourceEventId && entry.topics.has(value.topic));
        const projection = event === undefined ? null : await project(entry, event, batch.revision);
        if (projection !== null || !batch.hasMore) {
          await access(entry); selected(session, batch.revision);
          return { revision: batch.revision, found: projection === null ? null
            : bounded({ applicationId: id, revision: batch.revision, event, projection }, maxResultBytes) };
        }
        if (batch.cursor === cursor) fail('BRIDGE_EVENT_CURSOR_STALLED');
        cursor = batch.cursor;
        await new Promise(resolve => setImmediate(resolve));
      }
      fail('BRIDGE_EVENT_SCAN_LIMIT', 'Selected event lookup exceeded its bounded scan; absence was not established');
    } finally { await view.release(); }
  }
  const bridge = {
    // Configuration metadata only. The caller filters this list by account and
    // consent before returning it to a remote principal. This opens no session.
    listApplications() { if (closed) fail('BRIDGE_CLOSED'); return [...configured.values()].map(({ id, label }) => ({ id, label })); },
    async describeApplication(id) {
      const entry = entryFor(id), { session } = await access(entry), description = session.describe();
      return bounded({ applicationId: id, id: description.id, version: description.version,
        capabilities: description.capabilities,
        commands: description.commands.filter(value => entry.commands.has(value.name)),
        queries: description.queries.filter(value => entry.queries.has(value.name)) }, maxResultBytes);
    },
    async getStatus(id) {
      const { session, grant } = await access(entryFor(id));
      return bounded({ applicationId: id, deviceId: session.deviceId, status: session.status,
        grant: Object.fromEntries(['reader', 'writer', 'coordinator', 'recovery', 'administrator', 'publisher'].map(name => [name, grant[name] === true])),
        participation: session.participation?.status ?? null }, maxResultBytes);
    },
    async readRevision(id) {
      const { session } = await access(entryFor(id)), view = await session.readView();
      try { selected(session, view.revision); return bounded(view.revision, 16 * 1024); }
      finally { await view.release(); }
    },
    // This synchronous fence follows a fresh authorized native read. No I/O or
    // await may be inserted between this check and invoking an external effect.
    assertSelection(id, revision) {
      entryFor(id);
      const session = available.get(id)?.session;
      if (!session || session.status.phase === 'closed') fail('BRIDGE_SESSION_UNAVAILABLE');
      if (!revision || revision.applicationId !== id || revision.historyId !== session.historyId)
        fail('BRIDGE_REVISION_SCOPE_MISMATCH');
      selected(session, revision);
    },
    async query(id, name, input) {
      const entry = entryFor(id), { session } = await access(entry);
      permitted(entry, session.describe(), 'queries', name);
      const result = await session.query(name, bounded(input, 64 * 1024, 'BRIDGE_INPUT_TOO_LARGE'));
      await access(entry);
      selected(session, result.revision);
      return bounded(result, maxResultBytes);
    },
    async command(id, name, input, { operationId, basedOn, beforeSubmit, onSaved } = {}) {
      const entry = entryFor(id), { session } = await access(entry, 'writer');
      permitted(entry, session.describe(), 'commands', name);
      text(operationId, 'operation ID', 256);
      if (basedOn !== undefined && (!basedOn || typeof basedOn !== 'object' || Array.isArray(basedOn)
        || basedOn.applicationId !== id || basedOn.historyId !== session.historyId)) fail('BRIDGE_REVISION_SCOPE_MISMATCH');
      if ([beforeSubmit, onSaved].some(callback => callback !== undefined && typeof callback !== 'function')) fail('BRIDGE_INPUT_INVALID');
      const metadata = { operationId, ...(basedOn === undefined ? {} : { basedOn: bounded(basedOn, 16 * 1024) }) };
      const value = bounded(input, 64 * 1024, 'BRIDGE_INPUT_TOO_LARGE');
      // Native command prepares and durably saves one signed attempt. Return its
      // real state promptly; an HTTP deadline never creates another attempt.
      await beforeSubmit?.();
      lifetime.signal.throwIfAborted();
      const operation = await session.command(name, value, metadata);
      await onSaved?.();
      if (applyBudgetMs) {
        const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(applyBudgetMs)]);
        try { await operation.applied({ signal: deadline }); }
        catch (error) { if (!deadline.aborted) throw error; }
      }
      return bounded(await operation.get(), maxResultBytes);
    },
    async operation(id, operationId) {
      text(operationId, 'operation ID', 256);
      const { session } = await access(entryFor(id));
      return bounded(await session.operations.get(operationId), maxResultBytes);
    },
    async inspectOperation(id, operationId) {
      text(operationId, 'operation ID', 256);
      const entry = entryFor(id), { session } = await access(entry);
      const inspected = await session.operations.inspect(operationId);
      if (inspected === null) return null;
      const { state, attempt } = inspected, header = attempt?.payload?.header;
      if (!header || header.applicationId !== id || header.operationId !== operationId || header.author !== session.deviceId
        || state?.operationId !== operationId || state.attemptId !== attempt.id) fail('BRIDGE_OPERATION_IDENTITY_INVALID');
      permitted(entry, session.describe(), 'commands', header.command);
      return bounded({ state, deviceId: session.deviceId, identity: { attemptId: attempt.id, applicationId: header.applicationId,
        historyId: session.historyId, operationId: header.operationId, author: header.author, command: header.command,
        commandVersion: header.commandVersion, basedOn: header.basedOn, coreDigest: header.coreDigest,
        generation: header.generation } }, maxResultBytes);
    },
    readEvents: read,
    async getEvent(id, sourceEventId, options) { return (await findEvent(id, sourceEventId, options)).found; },
    async verifySource(id, sourceEventId, sourceRevision) {
      if (!sourceRevision || sourceRevision.applicationId !== id || typeof sourceRevision.historyId !== 'string') {
        fail('BRIDGE_REVISION_SCOPE_MISMATCH');
      }
      const result = await findEvent(id, sourceEventId);
      if (result.revision.historyId !== sourceRevision.historyId) fail('BRIDGE_REVISION_SCOPE_MISMATCH');
      return { selected: result.found !== null, currentRevision: result.revision, sourceRevision };
    },
    async *observe(id, { cursor: initialCursor, limit = 128, signal } = {}) {
      const entry = entryFor(id), { session } = await access(entry);
      const observation = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
      let cursor = initialCursor;
      for await (const change of session.changes({ signal: observation })) {
        observation.throwIfAborted();
        if (change.kind === 'recovery') {
          await access(entry);
          yield bounded({ kind: 'recovery', applicationId: id, revision: change.revision,
            recovery: change.recovery, previousCursor: cursor ?? null, resetRequired: true }, maxResultBytes);
          // The consumer must durably record/reconcile this notice and explicitly
          // restart with its chosen cursor. Never reset an external side effect
          // checkpoint merely because the native history changed.
          return;
        }
        for (;;) {
          let batch;
          try { batch = await read(id, { ...(cursor === undefined ? {} : { cursor }), limit }); }
          catch (error) {
            if (error?.code !== 'APPLICATION_VIEW_RECOVERED' && error?.message !== 'APPLICATION_VIEW_RECOVERED') throw error;
            await access(entry);
            const revision = error.revision ?? session.revision;
            const notices = await session.inspectRecovery();
            yield bounded({ kind: 'recovery', applicationId: id, revision,
              recovery: notices.findLast(notice => notice.generation === revision?.generation) ?? null,
              previousCursor: cursor ?? null, resetRequired: true }, maxResultBytes);
            return;
          }
          observation.throwIfAborted();
          if (batch.cursor === cursor) {
            if (batch.hasMore) fail('BRIDGE_EVENT_CURSOR_STALLED');
            break;
          }
          yield { kind: 'events', ...batch };
          // Pulling the next batch is the consumer's acknowledgment that its
          // outbox and cursor transaction completed. Restart supplies that cursor.
          cursor = batch.cursor;
          if (!batch.hasMore) break;
        }
      }
    },
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(new BridgeError('BRIDGE_CLOSED'));
      closing = (async () => {
        const results = await Promise.allSettled([...opened.values()]);
        const shutdown = await Promise.allSettled(results.filter(result => result.status === 'fulfilled').map(result => result.value.session.close()));
        opened.clear(); available.clear();
        const failed = shutdown.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
      return closing;
    },
  };
  return Object.freeze(bridge);
}
