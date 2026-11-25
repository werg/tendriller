import {
  applicationDescriptionDigest,
  check,
  checkedApplicationInputSchema,
  parseApplicationInput,
  recordDigest,
  validateApplicationDescription
} from "./chunk-CZMLHZUQ.mjs";
import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";
import {
  canonicalJson,
  encodeChangeProgram
} from "./chunk-MAGRVNAE.mjs";

// packages/peer-session/src/definition.ts
function defineCommand(options) {
  const input = checkedApplicationInputSchema(options.input);
  if (typeof options.description !== "string" || options.description.length > 4096 || typeof options.prepare !== "function") {
    throw new Error("APPLICATION_COMMAND_INVALID");
  }
  return Object.freeze({
    description: options.description,
    input,
    prepare(value) {
      const validated = parseApplicationInput(input, value);
      const program = options.prepare(validated);
      encodeChangeProgram(program);
      return program;
    }
  });
}
function defineQuery(options) {
  const input = checkedApplicationInputSchema(options.input);
  if (typeof options.description !== "string" || options.description.length > 4096 || typeof options.read !== "function") {
    throw new Error("APPLICATION_QUERY_INVALID");
  }
  return Object.freeze({
    description: options.description,
    input,
    read(view, value) {
      return options.read(view, parseApplicationInput(input, value));
    }
  });
}
function defineApplication(definition) {
  for (const value of [definition.id, definition.version]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)) throw new Error("APPLICATION_DEFINITION_ID_INVALID");
  }
  for (const entries of [definition.commands, definition.queries]) {
    const names = Object.keys(entries);
    if (names.length > 128) throw new Error("APPLICATION_DEFINITION_TOO_LARGE");
    for (const name of names) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
        throw new Error("APPLICATION_DEFINITION_NAME_INVALID");
      }
      checkedApplicationInputSchema(entries[name].input);
    }
  }
  return Object.freeze({ ...definition, commands: Object.freeze({ ...definition.commands }), queries: Object.freeze({ ...definition.queries }) });
}
function describeApplication(definition) {
  const describe = (entries) => Object.keys(entries).sort().map((name) => ({ name, description: entries[name].description, input: entries[name].input }));
  return validateApplicationDescription({ id: definition.id, version: definition.version, commands: describe(definition.commands), queries: describe(definition.queries) });
}
async function applicationDefinitionDigest(definition) {
  return applicationDescriptionDigest(describeApplication(definition));
}

// packages/peer-session/src/live-view.ts
function createLiveView(session, derive, options = {}) {
  let snapshot = null, status = null, error = null, closed = false, dirty = false, running = false;
  const listeners = /* @__PURE__ */ new Set(), waiters = /* @__PURE__ */ new Set();
  let stopChange = () => {
  }, stopStatus = () => {
  };
  const notify = (fn) => {
    try {
      fn();
    } catch {
    }
  };
  const run = async () => {
    if (closed || running) return;
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        let view;
        try {
          view = await session.readView();
          const value = await derive(view);
          if (closed) return;
          if (dirty) continue;
          snapshot = { revision: view.revision, value };
          error = null;
          for (const listener of listeners) notify(() => listener(snapshot));
          for (const waiter of waiters) waiter.resolve(snapshot);
          waiters.clear();
        } catch (failure) {
          error = failure;
          notify(() => options.onError?.(failure));
          for (const waiter of waiters) waiter.reject(failure);
          waiters.clear();
        } finally {
          await view?.release();
        }
      }
    } finally {
      running = false;
      if (dirty && !closed) void run();
    }
  };
  const invalidate = () => {
    dirty = true;
    void run();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopChange();
    stopStatus();
    options.signal?.removeEventListener("abort", close);
    for (const waiter of waiters) waiter.reject(new Error("LIVE_VIEW_CLOSED"));
    waiters.clear();
    listeners.clear();
  };
  const ready = (input = {}) => {
    if (closed) return Promise.reject(new Error("LIVE_VIEW_CLOSED"));
    if (input.signal?.aborted) return Promise.reject(input.signal.reason);
    if (snapshot !== null) return Promise.resolve(snapshot);
    const timeoutMs = input.timeoutMs ?? 3e4;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12e4) return Promise.reject(new Error("LIVE_VIEW_WAIT_LIMIT"));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        waiters.delete(waiter);
      };
      const abort = () => {
        done();
        reject(input.signal?.reason);
      };
      const waiter = { resolve(value) {
        done();
        resolve(value);
      }, reject(failure) {
        done();
        reject(failure);
      } };
      const timer = setTimeout(() => {
        done();
        reject(new Error("LIVE_VIEW_TIMEOUT"));
      }, timeoutMs);
      waiters.add(waiter);
      input.signal?.addEventListener("abort", abort, { once: true });
      invalidate();
    });
  };
  stopChange = session.onChange(invalidate);
  stopStatus = session.onStatus((value) => {
    status = value;
    notify(() => options.onStatus?.(value));
    if (value.phase === "closed") close();
    else if (value.database === "ready") invalidate();
  });
  options.signal?.addEventListener("abort", close, { once: true });
  if (options.signal?.aborted) close();
  else invalidate();
  return { get snapshot() {
    return snapshot;
  }, get status() {
    return status;
  }, get error() {
    return error;
  }, ready, refresh() {
    snapshot = null;
    return ready();
  }, subscribe(listener) {
    if (closed) throw new Error("LIVE_VIEW_CLOSED");
    listeners.add(listener);
    if (snapshot !== null) notify(() => listener(snapshot));
    return () => {
      listeners.delete(listener);
    };
  }, close };
}

// packages/peer-session/src/projection.ts
function defineProjection(definition) {
  if (!definition.name || !definition.version || typeof definition.derive !== "function") throw new Error("PROJECTION_INVALID");
  return Object.freeze({ ...definition });
}
function createProjection(session, definition) {
  return createLiveView(session, (view) => definition.derive(view));
}

// packages/peer-session/src/view-store.ts
var SessionError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
    this.name = "SessionError";
  }
  code;
};
function canonicalJson2(value, maxBytes = 8192) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 24) throw new SessionError("PAYLOAD_TOO_COMPLEX");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new SessionError("INVALID_PAYLOAD");
      return `[${item.map((child) => visit(child, depth + 1)).join(",")}]`;
    }
    if (item === null || typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new SessionError("INVALID_PAYLOAD");
    const record = item;
    return `{${Object.keys(record).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor === void 0 || !("value" in descriptor)) throw new SessionError("INVALID_PAYLOAD");
      return `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`;
    }).join(",")}}`;
  };
  const encoded = visit(value, 0);
  if (new TextEncoder().encode(encoded).length > maxBytes) throw new SessionError("PAYLOAD_TOO_LARGE");
  return encoded;
}
function createViewStore(options) {
  const { storage, applicationId, profileId, viewId } = options;
  const segment = (value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new SessionError("INVALID_IDENTITY");
    return encodeURIComponent(value);
  };
  const prefix = `chronolog:view:${segment(applicationId)}:${segment(profileId)}:`, draftPrefix = `${prefix}${segment(viewId)}:draft:`;
  const read = (key) => {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new SessionError("LOCAL_REFERENCE_CORRUPT");
    }
  };
  const operationKey = (reference, owner = viewId) => {
    if (reference.applicationId !== applicationId || !/^[0-9a-f]{64}$/u.test(reference.author) || !/^[0-9a-f]{64}$/u.test(reference.proposalId)) throw new SessionError("OPERATION_SCOPE_MISMATCH");
    return `${prefix}operation:${segment(owner)}:${reference.proposalId}`;
  };
  return {
    viewId,
    readDraft: (id = "default") => read(draftPrefix + segment(id)),
    writeDraft(value, id = "default") {
      storage.setItem(draftPrefix + segment(id), canonicalJson2(value, 65536));
    },
    removeDraft(id = "default") {
      storage.removeItem(draftPrefix + segment(id));
    },
    retainOperation(reference, context) {
      const key = operationKey(reference), existing = read(key);
      if (existing !== null) {
        if (canonicalJson2(existing.reference) !== canonicalJson2(reference) || context !== void 0 && canonicalJson2(existing.context, 65536) !== canonicalJson2(context, 65536)) throw new SessionError("OPERATION_REFERENCE_CONFLICT");
        return structuredClone(existing);
      }
      const value = { reference, viewId, context: context ?? {} };
      storage.setItem(key, canonicalJson2(value, 65536));
      return structuredClone(value);
    },
    inspectOperation: (reference) => read(operationKey(reference)),
    removeOperation(reference) {
      storage.removeItem(operationKey(reference));
    },
    pending(input = {}) {
      const values = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null || !key.startsWith(`${prefix}operation:`)) continue;
        const value = read(key);
        if (value !== null && (input.allViews === true || value.viewId === viewId)) {
          operationKey(value.reference, value.viewId);
          values.push(value);
        }
      }
      ;
      return values;
    }
  };
}

// packages/peer-session/src/event-forwarder.ts
function check2(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
async function forwardSessionEvents(options) {
  const { session, checkpoint, project, deliver } = options, limit = options.limit ?? 32, maxEvents = options.maxEvents ?? 1e4, maxBytes = options.maxBytes ?? 8 * 1024 * 1024, viewType = options.view ?? "local";
  check2(Number.isSafeInteger(limit) && limit >= 1 && limit <= 256 && Number.isSafeInteger(maxEvents) && maxEvents >= 1 && maxEvents <= 1e5 && Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 32 * 1024 * 1024, "EVENT_FORWARDER_LIMIT_INVALID");
  const topics = options.topics === void 0 ? void 0 : [...new Set(options.topics)].sort();
  check2(topics === void 0 || topics.length <= 128 && topics.every((topic) => typeof topic === "string" && topic.length > 0 && topic.length <= 128), "EVENT_FORWARDER_TOPICS_INVALID");
  const scope = JSON.stringify([session.applicationId, options.scope ?? "default", viewType, topics ?? null]), owner = new AbortController(), signal = AbortSignal.any([owner.signal, session.signal, ...options.signal === void 0 ? [] : [options.signal]]);
  const serialize = (value) => canonicalJson(value, { maxBytes, maxNodes: 1e6, maxDepth: 48 });
  let entries = /* @__PURE__ */ new Map(), dirty = true, ended = false, wake;
  const invalidate = () => {
    dirty = true;
    wake?.();
  };
  let stopStatus, iterator;
  const save = async () => {
    check2(entries.size <= maxEvents * 2, "EVENT_FORWARDER_ENTRY_LIMIT");
    const state = { format: "authored-event-outbox-v1", scope, entries: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))) };
    await awaitOwnedTask(signal, () => checkpoint.save(serialize(state)));
  };
  const observation = async (event, revision, present) => {
    const operation = await session.operations.get(event.proposalId);
    check2(operation !== null, "EVENT_FORWARDER_OPERATION_MISSING");
    const inspected = await operation.inspect();
    check2(inspected.applicationId === session.applicationId && inspected.author === event.author, "EVENT_FORWARDER_OPERATION_SCOPE_INVALID");
    return { stored: inspected.stored, materialized: present ? { proposalId: event.proposalId, revision, outcome: "accepted", rejectionCode: null, failingStatementIndex: null } : inspected.materialized, retained: structuredClone(inspected.retained), finalized: present && inspected.finalized, excluded: inspected.excluded };
  };
  try {
    const raw = await awaitOwnedTask(signal, () => checkpoint.load());
    if (raw !== void 0) {
      check2(typeof raw === "string" && new TextEncoder().encode(raw).length <= maxBytes, "EVENT_FORWARDER_CHECKPOINT_LIMIT");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw Object.assign(new Error("EVENT_FORWARDER_CHECKPOINT_INVALID"), { code: "EVENT_FORWARDER_CHECKPOINT_INVALID" });
      }
      check2(parsed.format === "authored-event-outbox-v1" && parsed.scope === scope && parsed.entries !== null && typeof parsed.entries === "object" && !Array.isArray(parsed.entries), "EVENT_FORWARDER_CHECKPOINT_SCOPE_INVALID");
      entries = new Map(Object.entries(parsed.entries));
      check2(entries.size <= maxEvents * 2, "EVENT_FORWARDER_ENTRY_LIMIT");
      serialize(parsed);
      for (const [id, entry] of entries) check2(entry.event?.id === id && typeof entry.event.proposalId === "string" && entry.projected !== null && typeof entry.projected === "object" && typeof entry.present === "boolean" && typeof entry.acknowledged === "boolean", "EVENT_FORWARDER_CHECKPOINT_INVALID");
    }
    stopStatus = session.onStatus(invalidate);
    iterator = session.changes({ signal })[Symbol.asyncIterator]();
    const changes = iterator;
    void (async () => {
      for (; ; ) {
        const next = await awaitOwnedTask(signal, () => changes.next());
        if (next.done === true) {
          ended = true;
          wake?.();
          return;
        }
        ;
        invalidate();
      }
    })().catch((error) => owner.abort(error));
    for (; ; ) {
      if (!dirty) {
        if (ended) return;
        const waiting = new Promise((resolve) => {
          wake = resolve;
        });
        await awaitOwnedTask(signal, () => waiting);
      }
      signal.throwIfAborted();
      if (!dirty) continue;
      dirty = false;
      const desired = /* @__PURE__ */ new Map(), opening = session.readView({ view: viewType });
      let view;
      try {
        view = await awaitOwnedTask(signal, () => opening);
      } catch (error) {
        void opening.then((late) => late.release()).catch(() => void 0);
        throw error;
      }
      let batch = { revision: view.revision, events: [], cursor: "", hasMore: false };
      try {
        check2(view.applicationId === session.applicationId && view.revision.view === viewType, "EVENT_FORWARDER_READ_SCOPE_INVALID");
        let cursor, count = 0;
        for (; ; ) {
          batch = await awaitOwnedTask(signal, () => view.readEvents({ ...cursor === void 0 ? {} : { cursor }, ...topics === void 0 ? {} : { topics }, limit }));
          check2(batch.revision.digest === view.revision.digest && batch.revision.view === viewType, "EVENT_FORWARDER_READ_INCOHERENT");
          for (const event of batch.events) {
            check2(++count <= maxEvents && !desired.has(event.id), "EVENT_FORWARDER_ENTRY_LIMIT");
            const facts = await awaitOwnedTask(signal, () => observation(event, view.revision, true)), projected = await awaitOwnedTask(signal, () => project(structuredClone(event), batch, { view, observation: structuredClone(facts) }));
            if (projected !== null && projected !== void 0) {
              check2(typeof projected.name === "string" && projected.name.length > 0 && projected.name.length <= 128, "EVENT_FORWARDER_PROJECTION_INVALID");
              serialize(projected);
              desired.set(event.id, { event: structuredClone(event), projected: structuredClone(projected), observation: facts, revision: view.revision, present: true, acknowledged: false });
            }
          }
          if (!batch.hasMore) break;
          check2(batch.cursor !== cursor, "EVENT_FORWARDER_CURSOR_STALLED");
          cursor = batch.cursor;
        }
      } finally {
        await view.release();
      }
      if (dirty) continue;
      for (const [id, prior] of [...entries]) {
        if (dirty) break;
        if (desired.has(id)) continue;
        const facts = await awaitOwnedTask(signal, () => observation(prior.event, batch.revision, false)), entry = { ...prior, observation: facts, revision: batch.revision, present: false, acknowledged: false };
        entries.set(id, entry);
        await save();
        await awaitOwnedTask(signal, () => deliver({ ...structuredClone(entry.projected), observation: structuredClone(facts), change: "retract" }, structuredClone(entry.event), batch, signal));
        entries.delete(id);
        await save();
      }
      for (const [id, desiredEntry] of desired) {
        if (dirty) break;
        const prior = entries.get(id), comparison = (entry) => serialize({ event: entry.event, projected: entry.projected, observation: entry.observation, revision: entry.revision, present: entry.present });
        if (prior?.acknowledged === true && prior.present && comparison(prior) === comparison(desiredEntry)) continue;
        entries.set(id, desiredEntry);
        await save();
        await awaitOwnedTask(signal, () => deliver({ ...structuredClone(desiredEntry.projected), observation: structuredClone(desiredEntry.observation), change: "upsert" }, structuredClone(desiredEntry.event), batch, signal));
        entries.set(id, { ...desiredEntry, acknowledged: true });
        await save();
      }
    }
  } finally {
    stopStatus?.();
    owner.abort(new Error("EVENT_FORWARDER_CLOSED"));
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => void 0);
    } catch {
    }
  }
}

// packages/peer-session/src/owner-lock.ts
function acquireApplicationOwnerLock(profileId, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId)) return Promise.reject(new Error("APPLICATION_OWNER_PROFILE_INVALID"));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const locks = options.locks ?? (typeof navigator === "undefined" ? void 0 : navigator.locks);
  if (locks === void 0 || typeof locks.request !== "function") return Promise.reject(new Error("APPLICATION_OWNER_LOCK_UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (!settled) {
        settled = true;
        reject(options.signal?.reason);
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const clean = () => options.signal?.removeEventListener("abort", abort);
    let completed;
    try {
      completed = locks.request("chronolog-owner:" + profileId, { mode: "exclusive", ...options.wait === true ? options.signal === void 0 ? {} : { signal: options.signal } : { ifAvailable: true } }, async (lock) => {
        if (settled) return;
        settled = true;
        clean();
        if (lock === null) {
          reject(Object.assign(new Error("OWNER_BUSY"), { code: "OWNER_BUSY" }));
          return;
        }
        const lifetime = new AbortController();
        let release, closing;
        const held = new Promise((done) => {
          release = done;
        });
        resolve(Object.freeze({ profileId, signal: lifetime.signal, close() {
          if (closing !== void 0) return closing;
          lifetime.abort(new Error("OWNER_UNREACHABLE"));
          release();
          closing = completed.then(() => void 0);
          return closing;
        } }));
        await held;
      });
      void completed.catch((error) => {
        if (!settled) {
          settled = true;
          clean();
          reject(error);
        }
      });
    } catch (error) {
      settled = true;
      clean();
      reject(error);
    }
  });
}

// packages/peer-session/src/tools.ts
function createScopedApplicationTools(session, options = {}) {
  const description = session.definition === void 0 ? session.describe?.() : describeApplication(session.definition);
  check(description !== void 0, "APPLICATION_TOOL_DESCRIPTION_REQUIRED");
  const commands = options.commands ?? [], queries = options.queries ?? [];
  for (const name of commands) check(description.commands.some((entry) => entry.name === name), "APPLICATION_TOOL_COMMAND_UNKNOWN");
  for (const name of queries) check(description.queries.some((entry) => entry.name === name), "APPLICATION_TOOL_QUERY_UNKNOWN");
  const result = async (operation) => {
    const state = await operation.inspect();
    check(state.applicationId === session.applicationId && state.author === session.identity.publicKey, "APPLICATION_TOOL_OPERATION_FORBIDDEN");
    return { state, operationReference: { applicationId: state.applicationId, author: state.author, operationId: state.operationId, proposalId: state.proposalId } };
  };
  const scopedOperationId = async (rawId, context) => {
    check(typeof context.caller === "string" && context.caller.length > 0 && context.caller.length <= 512 && typeof rawId === "string" && rawId.length > 0 && rawId.length <= 512, "APPLICATION_TOOL_SCOPE_INVALID");
    const digest = await recordDigest(["scoped-tool-operation", session.applicationId, session.identity.publicKey, context.caller, rawId]);
    return session.scopeOperationId?.(digest) ?? digest;
  };
  return {
    operationId: scopedOperationId,
    list() {
      return [...description.commands.filter((entry) => commands.includes(entry.name)).map((entry) => ({ name: entry.name, kind: "command", description: entry.description, inputSchema: entry.input })), ...description.queries.filter((entry) => queries.includes(entry.name)).map((entry) => ({ name: entry.name, kind: "query", description: entry.description, inputSchema: entry.input }))];
    },
    async execute(request, context) {
      context.signal?.throwIfAborted();
      check(typeof context.caller === "string" && context.caller.length > 0 && context.caller.length <= 512, "APPLICATION_TOOL_CALLER_REQUIRED");
      if (request.kind === "query") {
        check(request.name !== void 0 && queries.includes(request.name), "APPLICATION_TOOL_QUERY_FORBIDDEN");
        return session.query(request.name, request.input);
      }
      check(typeof request.operationId === "string" && request.operationId.length > 0 && request.operationId.length <= 512, "APPLICATION_TOOL_OPERATION_ID_REQUIRED");
      const operationId = await scopedOperationId(request.operationId, context);
      if (request.kind === "command") {
        check(request.name !== void 0 && commands.includes(request.name), "APPLICATION_TOOL_COMMAND_FORBIDDEN");
        if (request.basedOn !== void 0) {
          const view = await session.readView();
          try {
            check(view.revision.digest === request.basedOn.digest, "APPLICATION_TOOL_VIEW_STALE");
          } finally {
            await view.release();
          }
        }
        const operation2 = await session.command(request.name, request.input, { operationId });
        context.signal?.throwIfAborted();
        return result(operation2);
      }
      if (request.kind === "retry") return result(await session.operations.retry(operationId));
      const operation = await session.operations.get(operationId);
      check(operation !== null && (await operation.inspect()).author === session.identity.publicKey, "APPLICATION_TOOL_OPERATION_FORBIDDEN");
      if (request.kind === "wait") {
        const fact = request.fact ?? "materialized";
        check(["stored", "materialized", "retained", "finalized"].includes(fact), "APPLICATION_TOOL_FACT_INVALID");
        if (fact !== "stored") await operation[fact]({ ...context.signal === void 0 ? {} : { signal: context.signal }, ...context.timeoutMs === void 0 ? {} : { timeoutMs: context.timeoutMs } });
      } else check(request.kind === "inspect" || request.kind === "retry", "APPLICATION_TOOL_KIND_INVALID");
      return result(operation);
    }
  };
}

// packages/peer-session/src/ergonomics.ts
async function submitBatch(session, submissions) {
  const operations = [];
  for (const submission of submissions) operations.push(await session.submit(submission));
  return operations;
}
function createAppClient(session) {
  return { command: (name, input, options) => session.command(name, input, options), submit: (input) => session.submit(input), batch: (input) => submitBatch(session, input) };
}

// packages/peer-session/src/worker-application-protocol.ts
var APPLICATION_OWNER_PROTOCOL = "chronolog/authored-session/owner/v1";

export {
  defineCommand,
  defineQuery,
  defineApplication,
  describeApplication,
  applicationDefinitionDigest,
  createLiveView,
  defineProjection,
  createProjection,
  SessionError,
  canonicalJson2 as canonicalJson,
  createViewStore,
  forwardSessionEvents,
  acquireApplicationOwnerLock,
  createScopedApplicationTools,
  submitBatch,
  createAppClient,
  APPLICATION_OWNER_PROTOCOL
};
