import {
  APPLICATION_OWNER_PROTOCOL,
  describeApplication,
  forwardSessionEvents
} from "./chunk-OFBQMO3O.mjs";
import {
  check
} from "./chunk-CZMLHZUQ.mjs";
import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";

// packages/peer-session/src/owner-types.ts
var APPLICATION_DEFAULT_ATTACHMENT_CAPABILITIES = ["commands", "queries", "events", "content", "signals", "operations", "diagnostics", "finality", "provisioning"];

// packages/peer-session/src/session-owner.ts
var isArray = (value) => Array.isArray(value);
var CONTROLS = /* @__PURE__ */ new Set(["close", "attachment.ping", "attachment.suspend", "attachment.resume", "view.release", "content.cancel", "signals.close", "upload.discard"]);
function requestBudget(value) {
  let nodes = 0, bytes = 0;
  const walk = (item, depth) => {
    check(++nodes <= 16384 && depth <= 32, "ENDPOINT_REQUEST_SIZE_LIMIT");
    if (item instanceof Uint8Array) bytes += item.length;
    else if (typeof item === "string") bytes += item.length * 3;
    else if (Array.isArray(item)) for (const child of item) walk(child, depth + 1);
    else if (item !== null && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      bytes += key.length * 3;
      walk(child, depth + 1);
    }
    else check(item === null || typeof item === "number" || typeof item === "boolean" || typeof item === "bigint" || item === void 0, "ENDPOINT_REQUEST_INVALID");
    check(bytes <= 4 * 1024 * 1024, "ENDPOINT_REQUEST_SIZE_LIMIT");
  };
  walk(value, 0);
}
function checkedContext(value) {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, item]) => ["viewId", "documentPath", "publicationId", "runId"].includes(key) && typeof item === "string" && item.length > 0 && item.length <= (key === "documentPath" ? 1024 : 128) && ![...item].some((character) => character.charCodeAt(0) < 32)), "APPLICATION_ENDPOINT_CONTEXT_INVALID");
  return structuredClone(value);
}
function limit(value, fallback, maximum) {
  const result = value ?? fallback;
  check(Number.isSafeInteger(result) && result > 0 && result <= maximum, "OWNER_CONFIGURATION_INVALID");
  return result;
}
function createApplicationOwner(session, options = {}) {
  const ownerInstanceId = crypto.randomUUID(), maxAttachments = limit(options.maxAttachments, 16, 64);
  const attachments = /* @__PURE__ */ new Map();
  const heldViewIds = /* @__PURE__ */ new Map();
  let closed = false, closing;
  const owner = {
    ownerInstanceId,
    session,
    endpoints: () => [...attachments.values()].map((value) => ({ ...value.binding(), state: value.state() })),
    close: () => closing ??= (async () => {
      closed = true;
      for (const attachment of [...attachments.values()]) attachment.close();
      await session.close();
    })(),
    attach(endpoint, policy = {}) {
      check(!closed && attachments.size < maxAttachments, "OWNER_ATTACHMENT_LIMIT");
      const endpointId = crypto.randomUUID(), endpointIncarnation = crypto.randomUUID(), lifetime = new AbortController();
      const views = /* @__PURE__ */ new Map(), uploads = /* @__PURE__ */ new Map(), completedUploads = /* @__PURE__ */ new Map(), readers = /* @__PURE__ */ new Map(), streams = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Map();
      let effective = policy, attachment = "", initialized = false, detached = false, suspended = false, highestRequest = 0, viewReservations = 0, uploadReservations = 0, lastReceived = performance.now(), context = policy.context ?? {};
      let claimedViewId;
      let stopStatus, stopChange;
      const physical = endpoint;
      const binding = () => ({ ownerInstanceId, endpointId, endpointIncarnation, context: structuredClone(context), evidence: "owner-bound", contextEvidence: effective.contextEvidence ?? "caller-asserted", capabilities: [...effective.capabilities ?? APPLICATION_DEFAULT_ATTACHMENT_CAPABILITIES], ...effective.identity === void 0 ? {} : { identity: structuredClone(effective.identity) } });
      const has = (capability) => (effective.capabilities ?? APPLICATION_DEFAULT_ATTACHMENT_CAPABILITIES).includes(capability);
      const allow = (capability) => check(has(capability), "ENDPOINT_CAPABILITY_FORBIDDEN");
      const post = (message) => {
        if (!detached) endpoint.postMessage(message);
      };
      const releaseResources = () => {
        for (const view of views.values()) view.release();
        views.clear();
        for (const reader of readers.values()) {
          reader.lifetime.abort();
          void reader.iterator.return?.().catch(() => void 0);
        }
        ;
        readers.clear();
        for (const stream of streams.values()) {
          stream.lifetime.abort();
          void stream.iterator.return?.().catch(() => void 0);
        }
        ;
        streams.clear();
      };
      const close = () => {
        if (detached) return;
        try {
          post({ protocol: APPLICATION_OWNER_PROTOCOL, attachment, kind: "notice", topic: "closed", value: "ENDPOINT_CLOSED" });
        } catch {
        }
        detached = true;
        clearInterval(expiry);
        lifetime.abort(new Error("ENDPOINT_CLOSED"));
        for (const request of pending.values()) request.lifetime.abort(new Error("ENDPOINT_CLOSED"));
        pending.clear();
        endpoint.removeEventListener("message", receive);
        physical.removeEventListener("close", physicalClose);
        physical.removeEventListener("messageerror", physicalClose);
        physical.off?.("close", close);
        physical.off?.("messageerror", close);
        if (claimedViewId !== void 0 && heldViewIds.get(claimedViewId) === endpointId) heldViewIds.delete(claimedViewId);
        stopStatus?.();
        stopChange?.();
        releaseResources();
        uploads.clear();
        completedUploads.clear();
        attachments.delete(endpointId);
        endpoint.close?.();
        if (!closed && attachments.size === 0 && options.lastClient === "shutdown") void owner.close();
      };
      const physicalClose = () => close();
      const active = (request) => {
        request.signal.throwIfAborted();
        check(!detached, "ENDPOINT_CLOSED");
      };
      const invoke = async (method, args, request) => {
        active(request);
        if (method === "hello") {
          check(!initialized && typeof args[0] === "object" && args[0] !== null, "ENDPOINT_HANDSHAKE_INVALID");
          const handshake = args[0];
          check(handshake.applicationId === session.applicationId, "ENDPOINT_APPLICATION_MISMATCH");
          effective = { ...policy, ...options.authorize?.(handshake) };
          limit(effective.maxRequests, 32, 64);
          limit(effective.maxViews, 8, 32);
          check(effective.capabilities === void 0 || isArray(effective.capabilities) && effective.capabilities.length <= APPLICATION_DEFAULT_ATTACHMENT_CAPABILITIES.length && new Set(effective.capabilities).size === effective.capabilities.length && effective.capabilities.every((capability) => APPLICATION_DEFAULT_ATTACHMENT_CAPABILITIES.includes(capability)), "OWNER_CONFIGURATION_INVALID");
          const requested = checkedContext(effective.context ?? handshake.context ?? {});
          let viewId = requested.viewId ?? crypto.randomUUID();
          while (heldViewIds.has(viewId)) viewId = crypto.randomUUID();
          heldViewIds.set(viewId, endpointId);
          claimedViewId = viewId;
          context = { ...requested, viewId };
          initialized = true;
          stopStatus = session.onStatus((value) => {
            if (!suspended) post({ protocol: APPLICATION_OWNER_PROTOCOL, attachment, kind: "notice", topic: "status", value });
          });
          stopChange = session.onChange((value) => {
            if (!suspended) post({ protocol: APPLICATION_OWNER_PROTOCOL, attachment, kind: "notice", topic: "change", value });
          });
          return { applicationId: session.applicationId, identity: session.identity, definition: describeApplication(session.definition), status: session.status, binding: binding() };
        }
        if (method === "close") return null;
        check(initialized, "ENDPOINT_HANDSHAKE_REQUIRED");
        if (method === "attachment.ping") return { ...binding(), state: suspended ? "suspended" : "active" };
        if (method === "attachment.suspend") {
          suspended = true;
          for (const work of pending.values()) if (!work.control) work.lifetime.abort(new Error("ENDPOINT_SUSPENDED"));
          releaseResources();
          return null;
        }
        if (method === "attachment.resume") {
          suspended = false;
          return session.status;
        }
        if (method === "view.release") {
          const id = String(args[0]), view = views.get(id);
          views.delete(id);
          view?.release();
          return null;
        }
        if (method === "content.cancel") {
          const id = String(args[0]), reader = readers.get(id);
          readers.delete(id);
          reader?.lifetime.abort();
          await reader?.iterator.return?.();
          return null;
        }
        if (method === "signals.close") {
          const id = String(args[0]), stream = streams.get(id);
          streams.delete(id);
          stream?.lifetime.abort();
          await stream?.iterator.return?.();
          return null;
        }
        if (method === "upload.discard") {
          const id = String(args[0]), upload = uploads.get(id) ?? completedUploads.get(id);
          uploads.delete(id);
          completedUploads.delete(id);
          await upload?.discard();
          return null;
        }
        check(!suspended, "ENDPOINT_SUSPENDED");
        if (method === "submit") {
          allow("commands");
          check(effective.rawSubmit ?? effective.commands === void 0, "ENDPOINT_RAW_SUBMIT_FORBIDDEN");
          const operation = await session.submit(args[0]);
          return { id: operation.id, operationId: operation.operationId };
        }
        if (method === "command") {
          allow("commands");
          const name = String(args[0]);
          check(effective.commands === void 0 || effective.commands.includes(name), "ENDPOINT_COMMAND_FORBIDDEN");
          const input = options.prepareCommand === void 0 ? args[1] : options.prepareCommand(binding(), name, args[1]);
          const operation = await session.command(name, input, args[2]);
          return { id: operation.id, operationId: operation.operationId };
        }
        if (method === "query") {
          allow("queries");
          const name = String(args[0]);
          check(effective.queries === void 0 || effective.queries.includes(name), "ENDPOINT_QUERY_FORBIDDEN");
          return session.query(name, args[1], { signal: request.signal });
        }
        if (method === "readView") {
          check(has("queries") || has("events"), "ENDPOINT_CAPABILITY_FORBIDDEN");
          check(views.size + viewReservations < (effective.maxViews ?? 8), "ENDPOINT_VIEW_LIMIT");
          viewReservations++;
          let view, deferred = false;
          const opening = session.readView(args[0]);
          try {
            view = await awaitOwnedTask(request.signal, () => opening);
            active(request);
            const id = crypto.randomUUID();
            views.set(id, view);
            const result = { id, revision: view.revision };
            view = void 0;
            return result;
          } catch (error) {
            if (request.signal.aborted && view === void 0) {
              deferred = true;
              void opening.then((late) => late.release()).catch(() => void 0).finally(() => {
                viewReservations--;
              });
            }
            ;
            throw error;
          } finally {
            if (!deferred) viewReservations--;
            view?.release();
          }
        }
        if (method === "view.query" || method === "view.events") {
          const view = views.get(String(args[0]));
          check(view !== void 0, "ENDPOINT_VIEW_STALE");
          if (method === "view.query") {
            allow("queries");
            check(effective.rawSql ?? effective.queries === void 0, "ENDPOINT_RAW_SQL_FORBIDDEN");
            return view.query(String(args[1]), args[2]);
          }
          ;
          allow("events");
          return view.readEvents(args[1]);
        }
        if (method === "operation.retry") {
          allow("operations");
          const operation = await session.operations.retry(String(args[0]));
          return { id: operation.id, operationId: operation.operationId };
        }
        if (method === "operation.get") {
          allow("operations");
          const operation = session.operations.get(String(args[0]));
          return operation === null ? null : { id: operation.id, operationId: operation.operationId, inspection: operation.inspect() };
        }
        if (method === "operation.inspect") {
          allow("operations");
          return session.inspectOperation(String(args[0]));
        }
        if (method === "operation.wait") {
          allow("operations");
          const operation = session.operations.get(String(args[0]));
          check(operation !== null, "OPERATION_UNKNOWN");
          const fact = args[1];
          check(fact === "materialized" || fact === "retained" || fact === "finalized", "OPERATION_FACT_INVALID");
          return operation[fact]({ signal: request.signal, timeoutMs: Number(args[2] ?? 3e4) });
        }
        if (method === "diagnostics.peers") {
          allow("diagnostics");
          return session.diagnostics();
        }
        if (method === "authority.read") {
          allow("diagnostics");
          return session.authority.bundle();
        }
        if (method === "endpoints.list") {
          allow("diagnostics");
          return owner.endpoints();
        }
        if (method === "authority.merge") {
          allow("diagnostics");
          return session.mergeAuthority(args[0]);
        }
        if (method === "finality.closeAuthorTime") {
          allow("finality");
          return session.finality.closeAuthorTime(args[0]);
        }
        if (method === "finality.voteAuthorTime") {
          allow("finality");
          return session.finality.voteAuthorTime(args[0]);
        }
        if (method === "finality.submitProofs") {
          allow("finality");
          return session.finality.submitProofs(args[0]);
        }
        if (method === "provisioning.createProvisioningRequest") {
          allow("provisioning");
          return session.provisioning.createProvisioningRequest();
        }
        if (method === "provisioning.exportProvisioning") {
          allow("provisioning");
          return session.provisioning.exportProvisioning(args[0]);
        }
        if (method === "provisioning.importProvisioning") {
          allow("provisioning");
          return session.provisioning.importProvisioning(args[0]);
        }
        if (["content.retain", "content.retention", "content.retained", "content.discard"].includes(method)) {
          allow("content");
          const reference = args[0];
          if (method === "content.retain") return session.content.retain(reference, { signal: request.signal });
          if (method === "content.retention") return session.content.retention(reference, { signal: request.signal });
          if (method === "content.retained") return session.content.retained(reference);
          return session.content.discard(reference);
        }
        if (method === "content.stage") {
          allow("content");
          check(uploads.size + uploadReservations < 4, "ENDPOINT_UPLOAD_LIMIT");
          uploadReservations++;
          let upload;
          try {
            upload = await session.content.stage(args[0]);
            active(request);
            uploads.set(upload.id, upload);
            const id = upload.id;
            upload = void 0;
            return id;
          } finally {
            uploadReservations--;
            if (upload !== void 0) await upload.discard();
          }
        }
        if (["upload.write", "upload.progress", "upload.commit"].includes(method)) {
          allow("content");
          const id = String(args[0]), upload = uploads.get(id) ?? completedUploads.get(id);
          check(upload !== void 0, "CONTENT_UPLOAD_UNKNOWN");
          if (method === "upload.write") {
            check(args[2] instanceof Uint8Array && args[2].length <= 65536, "CONTENT_CHUNK_LIMIT");
            return upload.write(Number(args[1]), args[2]);
          }
          if (method === "upload.progress") return upload.progress();
          const reference = await upload.commit();
          uploads.delete(id);
          completedUploads.set(id, upload);
          while (completedUploads.size > 32) completedUploads.delete(completedUploads.keys().next().value);
          return reference;
        }
        if (method === "content.openRead") {
          allow("content");
          check(readers.size < 4, "ENDPOINT_READER_LIMIT");
          const id = crypto.randomUUID(), owned = new AbortController(), iterator = session.content.read(args[0], { signal: AbortSignal.any([owned.signal, lifetime.signal]) })[Symbol.asyncIterator]();
          readers.set(id, { iterator, lifetime: owned, busy: false });
          return id;
        }
        if (method === "content.next") {
          allow("content");
          const id = String(args[0]), reader = readers.get(id);
          check(reader !== void 0 && !reader.busy, "CONTENT_READER_UNKNOWN");
          reader.busy = true;
          const abort = () => {
            reader.lifetime.abort();
            readers.delete(id);
          };
          request.signal.addEventListener("abort", abort, { once: true });
          try {
            const next = await reader.iterator.next();
            active(request);
            if (next.done) {
              readers.delete(id);
              return null;
            }
            ;
            check(next.value.length <= 65536, "CONTENT_CHUNK_LIMIT");
            return next.value;
          } finally {
            request.signal.removeEventListener("abort", abort);
            reader.busy = false;
          }
        }
        if (method === "signals.send") {
          allow("signals");
          const supplied = args[2] ?? {};
          return session.signals.send(String(args[0]), args[1], { ...supplied, signal: request.signal, stream: { ...supplied.stream, streamId: supplied.stream?.streamId ?? endpointId, endpointId, endpointIncarnation } });
        }
        if (method === "signals.open") {
          allow("signals");
          check(streams.size < 4, "ENDPOINT_STREAM_LIMIT");
          const id = crypto.randomUUID(), owned = new AbortController(), iterator = session.signals.subscribe({ ...args[0] ?? {}, signal: AbortSignal.any([owned.signal, lifetime.signal]) })[Symbol.asyncIterator]();
          streams.set(id, { iterator, lifetime: owned, pending: null, busy: false });
          return id;
        }
        if (method === "signals.next") {
          allow("signals");
          const stream = streams.get(String(args[0]));
          check(stream !== void 0 && !stream.busy, "ENDPOINT_STREAM_BUSY");
          stream.busy = true;
          let timer;
          const abort = () => {
            stream.lifetime.abort();
            streams.delete(String(args[0]));
          };
          request.signal.addEventListener("abort", abort, { once: true });
          try {
            stream.pending ??= stream.iterator.next();
            void stream.pending.catch(() => void 0);
            const idle = /* @__PURE__ */ Symbol("idle"), next = await Promise.race([stream.pending, new Promise((resolve) => {
              timer = setTimeout(() => resolve(idle), 2e4);
            })]);
            active(request);
            if (next === idle) return { idle: true };
            stream.pending = null;
            return next.done ? { done: true } : { value: next.value };
          } finally {
            clearTimeout(timer);
            request.signal.removeEventListener("abort", abort);
            stream.busy = false;
          }
        }
        if (method === "events.read") {
          allow("events");
          return session.readEvents(args[0]);
        }
        throw Object.assign(new Error("ENDPOINT_METHOD_UNKNOWN"), { code: "ENDPOINT_METHOD_UNKNOWN" });
      };
      const receive = (event) => {
        const input = event.data;
        if (input?.protocol !== APPLICATION_OWNER_PROTOCOL || detached || typeof input.attachment !== "string") return;
        if (attachment !== "" && input.attachment !== attachment) return;
        if (input.kind === "cancel") {
          if (Number.isSafeInteger(input.id)) pending.get(input.id)?.lifetime.abort(new Error("REQUEST_CANCELLED"));
          return;
        }
        if (input.kind !== "request") return;
        if (input.attachment.length > 128 || !Number.isSafeInteger(input.id) || input.id < 1 || typeof input.method !== "string" || !Array.isArray(input.args)) {
          close();
          return;
        }
        if (attachment === "") attachment = input.attachment;
        const id = input.id;
        if (id <= highestRequest) return;
        highestRequest = id;
        lastReceived = performance.now();
        const reply = (value, error) => {
          try {
            post({ protocol: APPLICATION_OWNER_PROTOCOL, attachment, kind: "response", id, ...error === void 0 ? { value } : { error } });
          } catch {
            close();
          }
        };
        try {
          requestBudget(input.args);
        } catch {
          reply(null, "ENDPOINT_REQUEST_SIZE_LIMIT");
          return;
        }
        const control = CONTROLS.has(input.method);
        if (!control && [...pending.values()].filter((request2) => !request2.control).length >= (effective.maxRequests ?? 32) || control && [...pending.values()].filter((request2) => request2.control).length >= 8) {
          reply(null, "ENDPOINT_REQUEST_LIMIT");
          return;
        }
        const owned = new AbortController(), request = { lifetime: owned, signal: AbortSignal.any([lifetime.signal, owned.signal]), method: input.method, control };
        pending.set(id, request);
        const timer = setTimeout(() => owned.abort(new Error("ENDPOINT_REQUEST_TIMEOUT")), 12e4);
        void invoke(input.method, input.args, request).then((value) => {
          if (!request.signal.aborted) reply(value);
          if (input.method === "close") close();
        }, (error) => {
          if (!request.signal.aborted) reply(null, error instanceof Error ? error.message : "ENDPOINT_REQUEST_FAILED");
        }).finally(() => {
          clearTimeout(timer);
          pending.delete(id);
        });
      };
      const expiry = setInterval(() => {
        if (!suspended && performance.now() - lastReceived > 9e4) close();
      }, 1e4);
      expiry.unref?.();
      endpoint.addEventListener("message", receive);
      physical.addEventListener("close", physicalClose);
      physical.addEventListener("messageerror", physicalClose);
      physical.on?.("close", close);
      physical.on?.("messageerror", close);
      endpoint.start?.();
      attachments.set(endpointId, { binding, state: () => suspended ? "suspended" : "active", close });
      return close;
    }
  };
  return owner;
}

// packages/peer-session/src/multi-session.ts
function mergeSessionChanges(source = [], options = {}) {
  const owner = new AbortController();
  const lifetime = options.signal === void 0 ? owner.signal : AbortSignal.any([owner.signal, options.signal]);
  const members = /* @__PURE__ */ new Map();
  const ready = [];
  let failure;
  let wake = () => void 0;
  let iterating = false;
  const notify = () => {
    const resolve = wake;
    wake = () => void 0;
    resolve();
  };
  lifetime.addEventListener("abort", () => {
    for (const member of members.values()) member.abort();
    members.clear();
    notify();
  }, { once: true });
  async function follow(session, member) {
    const signal = AbortSignal.any([member.signal, ...session.signal === void 0 ? [] : [session.signal]]);
    try {
      for await (const change of session.changes({ signal })) {
        if (signal.aborted) return;
        await new Promise((resolve) => {
          const taken = () => {
            signal.removeEventListener("abort", taken);
            resolve();
          };
          signal.addEventListener("abort", taken, { once: true });
          ready.push({ session, taken, change: Object.freeze({ applicationId: session.applicationId, kind: change.kind, revision: change.revision, revisedProposalIds: change.revisedProposalIds }) });
          notify();
        });
        if (signal.aborted) return;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (options.onError !== void 0) options.onError(error, session);
      else {
        failure ??= { error };
        notify();
      }
    } finally {
      if (members.get(session) === member) members.delete(session);
    }
  }
  function add(session) {
    if (lifetime.aborted || members.has(session)) return;
    const member = new AbortController();
    members.set(session, member);
    void follow(session, member);
  }
  function remove(session) {
    const member = members.get(session);
    if (member === void 0) return;
    members.delete(session);
    member.abort();
    for (let index = ready.length - 1; index >= 0; index--) if (ready[index].session === session) ready.splice(index, 1);
  }
  if (Symbol.asyncIterator in source) {
    void (async () => {
      try {
        for await (const session of source) {
          if (lifetime.aborted) return;
          add(session);
        }
      } catch (error) {
        failure ??= { error };
        notify();
      }
    })();
  } else for (const session of source) add(session);
  return {
    add,
    remove,
    get size() {
      return members.size;
    },
    close() {
      owner.abort();
    },
    [Symbol.asyncIterator]() {
      if (iterating) throw new Error("SESSION_CHANGES_SINGLE_CONSUMER");
      iterating = true;
      return {
        async next() {
          for (; ; ) {
            if (failure !== void 0) {
              const { error } = failure;
              failure = void 0;
              owner.abort();
              throw error;
            }
            if (lifetime.aborted) return { done: true, value: void 0 };
            const entry = ready.shift();
            if (entry !== void 0) {
              entry.taken();
              return { done: false, value: entry.change };
            }
            await new Promise((resolve) => {
              wake = resolve;
            });
          }
        },
        async return() {
          owner.abort();
          return { done: true, value: void 0 };
        }
      };
    }
  };
}
function sessionCheckpointKey(applicationId) {
  return applicationId;
}
function forwardManySessionEvents(options) {
  const { sessions = [], checkpoints, onError, signal, ...forwarder } = options;
  const owner = new AbortController();
  const lifetime = signal === void 0 ? owner.signal : AbortSignal.any([owner.signal, signal]);
  let sourceFailure;
  const running = /* @__PURE__ */ new Map();
  function add(session) {
    if (lifetime.aborted || running.has(session)) return;
    const stop = new AbortController();
    const scope = Object.freeze({ applicationId: session.applicationId, key: sessionCheckpointKey(session.applicationId) });
    const done = forwardSessionEvents({
      ...forwarder,
      session,
      signal: AbortSignal.any([lifetime, stop.signal]),
      checkpoint: { load: () => checkpoints.load(scope), save: (state) => checkpoints.save(scope, state) }
    }).catch((error) => {
      if (!stop.signal.aborted && !lifetime.aborted && !session.signal.aborted) onError(error, session);
    }).finally(() => {
      if (running.get(session)?.stop === stop) running.delete(session);
    });
    running.set(session, { stop, done });
  }
  function remove(session) {
    const entry = running.get(session);
    if (entry === void 0) return;
    running.delete(session);
    entry.stop.abort();
  }
  if (Symbol.asyncIterator in sessions) {
    void (async () => {
      try {
        for await (const session of sessions) {
          if (lifetime.aborted) return;
          add(session);
        }
      } catch (error) {
        sourceFailure = { error };
        owner.abort(error);
      }
    })();
  } else for (const session of sessions) add(session);
  return {
    add,
    remove,
    get size() {
      return running.size;
    },
    async close() {
      const settled = [...running.values()].map((entry) => entry.done);
      owner.abort();
      await Promise.all(settled);
      if (sourceFailure !== void 0) throw sourceFailure.error;
    }
  };
}

// packages/peer-session/src/index.ts
async function createApplicationSession(options) {
  return (await import("./runtime-XS5LJKS4.mjs")).createApplicationSession(options);
}

export {
  createApplicationOwner,
  mergeSessionChanges,
  sessionCheckpointKey,
  forwardManySessionEvents,
  createApplicationSession
};
