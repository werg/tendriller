import { applicationSelection, createApplicationBinding, createCloudflareApplicationBackend, validateCloudflareProgram, validateApplicationOperation, assertApplicationOperationId } from "../../contract/application.mjs";
import type { ApplicationBackend, ApplicationOperation, CloudflareApplicationSubmission } from "../../contract/application.mjs";
import { createPageHost } from "./page-host";
import { createPeerCore } from "./peer-core";
import { documentUrl } from "./document";
// Runtime core (PROTOCOL 7, 11.1): socket, bus, state, offline queue, eval, logs, health.
import type { Bus, Core, Device, Presence, Role, StateApi, TendrilConfig, TranscriptEntry, Path } from "./types";
import { runtimeAsset } from "./assets";
import { OfflineStore, type OutboxItem } from "./offline";
import { assertValid, RESOURCE_LIMITS } from "../../contract/index.mjs";
import type { ConversationResult, OperationOptions, PendingStateCommand, PendingTimerCommand, ScopeDescriptor, ServiceDescriptor, StateResult, StateWriteOptions, TimerIntent, TimerMutationResult } from "../../contract/index.mjs";
import { assertStateJson, normalizeStateOps, normalizeStateChecks, StatePathError, StateInputError } from "../../contract/state.mjs";
import type { NormalizedStateChecks } from "../../contract/state.mjs";
import { captureContext, matchesContext, type OperationContext } from "./generations";
import { serialize, errorString } from "./serialize";
import { loadDevice, saveDevice, guessName, probeCaps, rand32 } from "./device";
import { installLogForwarding, createHealth, type LogEntry } from "./diagnostics";
import { applyOps, clone, getPath, mergePatchToOps, toPath, type Op } from "./state";
import { createStreams } from "./streams";
import { createRecordLogClient, validateRecordHead } from "../../contract/records.mjs";
import { createConnection } from "./connection";
import { deliveryPolicy } from "./delivery";
import { createRequests, createCommandReceipts } from "./requests";
import { captureData, type BlobReference, type CaptureOptions, type CaptureResult, type PendingCapture, type SendResult } from "./capture";
import { createBrowserBlobs, BlobHttpError } from "./blob-transfer";
import { createBrowserTimers, TimerHttpError, type TimerTerminalResult } from "./timers";

export type { Bus, Core } from "./types";

const TRANSCRIPT_MAX = 200;


const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => () => Promise<any>;

export function createBus(): Bus {
  const map = new Map<string, Set<(p: any) => void>>();
  return {
    on(type, fn) {
      let s = map.get(type);
      if (!s) map.set(type, (s = new Set()));
      s.add(fn);
      return () => { s!.delete(fn); };
    },
    emit(type, payload) {
      const s = map.get(type);
      if (!s) return;
      for (const fn of [...s]) {
        try { fn(["state", "state_result", "state_queue", "timer_result", "timer_queue", "sensors", "upload_event", "capture_queue"].includes(type) ? clone(payload) : payload); } catch (e) { setTimeout(() => { throw e; }); }
      }
    },
  };
}

function newCid(): string { return "c_" + Date.now().toString(36) + rand32(8); }
function stateRejection(message: any): Extract<StateResult, { status: "rejected" }> {
  return { status: "rejected", error: String(message.error?.code || message.error), message: message.message || message.error?.message,
    ...(typeof message.rev === "number" ? { rev: message.rev } : {}), ...(message.conflict ? { conflict: clone(message.conflict) } : {}) };
}

const permanentUploadFailure = (error: unknown): boolean => error instanceof BlobHttpError
  ? error.status < 500 && error.status !== 408 && error.status !== 429
  : ["invalid_response", "bad_request", "upload_closed"].includes((error as any)?.code);

type Internal = Core & {
  readonly rev: number; health: ReturnType<typeof createHealth>;
  uploadEvent(blob: Blob, opts: CaptureOptions): Promise<CaptureResult>;
  captures(): PendingCapture[];
  retryCapture(id: string): Promise<CaptureResult>;
  discardCapture(id: string): Promise<void>;
  setBlobRetention(id: string, opts: OperationOptions & { keep: boolean }): Promise<BlobReference>;
};

export function createCore(cfg: TendrilConfig, selectedBackend?: ApplicationBackend): Internal {
  const selection = applicationSelection(cfg.application, `cf:${cfg.id}`);
  const bus = createBus();
  if (selection.kind === "peer") return createPeerCore(cfg, selection, bus, selectedBackend);
  if (selectedBackend) throw new TypeError("A custom backend requires an explicit peer application selection");
  const application = createApplicationBinding(selection);
  const stored = loadDevice(cfg.id);
  if (!stored.name) { stored.name = guessName(); saveDevice(cfg.id, stored); }
  const device: Device = { id: stored.id, role: (stored.role as Role) || "owner", name: stored.name, pending: false };
  const store = new OfflineStore(cfg.id);

  // ---------- state ----------
  let confirmed: any = {};
  let local: any = {};
  let rev = 0;
  let fullStateRev = 0;
  type PendingState = { cid: string; ops: Op[] } & OperationContext & NormalizedStateChecks;
  const conditional = (checks: NormalizedStateChecks) => checks.expected_revision !== undefined || checks.conditions !== undefined;
  let scopes: ScopeDescriptor[] = [];
  let service: ServiceDescriptor | null = null;
  let savingState = 0;
  let pendingState: PendingState[] = [];
  let transcript: TranscriptEntry[] = [];
  // A received ACK is first saved in its original outbox row. Memory bridges a
  // failed phase write; only committed cleanup can publish a terminal result.
  const commandOutcomes = new Map<string, any>();
  const reconciledStateAcks = new Set<string>();

  const snap = store.loadSnapshotSync();
  if (snap) {
    confirmed = snap.state && typeof snap.state === "object" ? snap.state : {};
    rev = fullStateRev = snap.rev || 0;
    scopes = Array.isArray(snap.scopes) ? snap.scopes : [];
    pendingState = Array.isArray(snap.pending) ? snap.pending : [];
    transcript = Array.isArray(snap.transcript) ? snap.transcript : [];
  }
  const rebuild = () => {
    local = clone(confirmed);
    // Old work stays durable and keeps its original generation until a receipt
    // arrives, but it must not cover a newer session received from the server.
    for (const p of pendingState) if (!commandOutcomes.has(p.cid) && !conditional(p) && matchesContext(scopes, p, "state", p.ops)) {
      try { local = applyOps(local, p.ops); }
      catch (error) {
        // A remote parent replacement can make an old path incompatible. Keep
        // the original command for its receipt, without hiding newer authority.
        if (!(error instanceof StatePathError) && !(error instanceof StateInputError)) throw error;
      }
    }
  };
  rebuild();

  let snapTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const snapshot = (): any => ({ rev, state: confirmed, scopes, pending: pendingState, transcript: transcript.slice(-50) });
  const persistSoon = () => {
    if (snapTimer) return;
    snapTimer = setTimeout(() => { snapTimer = 0; store.saveSnapshot(snapshot()); }, 300);
  };
  window.addEventListener("pagehide", () => {
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = 0; }
    store.saveSnapshot(snapshot());
  });

  const emitState = (ops: Op[], by: string) => {
    const s = clone(local);
    bus.emit("state", { state: s, ops, by });
    for (const fn of [...stateListeners]) {
      try { fn(clone(local), clone(ops), by); } catch (e) { setTimeout(() => { throw e; }); }
    }
  };
  const stateListeners = new Set<(state: any, ops: any[], by: string) => void>();
  const pendingStateCommands = (): PendingStateCommand[] => clone(store.items.filter(item => item.msg.t === "state").map(item => ({
    cid: item.cid, ops: item.msg.ops, status: "queued" as const, scope: item.msg.scope,
    expected_generations: item.msg.expected_generations, conditions: item.msg.conditions, expected_revision: item.msg.expected_revision,
  })));
  const stateQueueChanged = () => bus.emit("state_queue", pendingStateCommands());

  let saving = Promise.resolve();
  const localOps = (operation: Op[] | ((state: any) => Op[]), options?: StateWriteOptions): Promise<StateResult> => {
    // A misspelled guard must not silently turn a conditional write into an
    // unconditional one. Validate the complete option envelope before capture.
    assertValid("stateWriteOptions", options ?? {});
    const checks = normalizeStateChecks(options);
    if (Array.isArray(operation) && !operation.length && !conditional(checks)) return Promise.resolve({ status: "unchanged", rev });
    const cid = newCid();
    const capturedScopes = clone(scopes), capturedOptions = { ...clone(options), ...checks };
    let context: OperationContext = { expected_generations: {} };
    let createdOps: Op[] = Array.isArray(operation) ? operation : [];
    let empty = false;
    savingState++;
    // Preserve invocation order even while IndexedDB opens. No optimistic state
    // or network delivery is visible before the command's durable commit.
    const saved = saving.then(async () => {
      await storeReady;
      const ops = normalizeStateOps(typeof operation === "function" ? operation(local) : operation);
      createdOps = ops;
      if (!ops.length && !conditional(checks)) { empty = true; return; }
      context = captureContext(capturedScopes, "state", capturedOptions, ops);
      const pending = { cid, ops, ...context, ...checks };
      await store.addDurable({ t: "state", ...pending });
      pendingState.push(pending);
      rebuild();
      persistSoon();
      stateQueueChanged();
      if (!conditional(checks)) emitState(ops, "device:" + device.id);
    });
    saving = saved.then(() => {}, () => {});
    return saved.then(async () => {
      savingState--;
      if (empty) return { status: "unchanged", rev } as StateResult;
      const receipt = receipts.wait(cid);
      void pump();
      const ack = await receipt;
      return !ack ? { status: "queued", cid } as StateResult
        : ack.error ? { ...stateRejection(ack), cid }
        : { status: "accepted", cid, rev: ack.rev } as StateResult;
    }, error => {
      savingState--;
      const result: StateResult = { status: "rejected", error: (error as any)?.code || "storage_unavailable", message: error instanceof Error ? error.message : "Could not save this change." };
      bus.emit("state_result", { cid, ops: createdOps, ...context, ...checks, ...result });
      return result;
    });
  };

  const state: StateApi = {
    get revision() { return rev; },
    get(path?: Path) { return clone(getPath(local, toPath(path))); },
    pending: pendingStateCommands,
    async snapshot() {
      const reply = await requests.request({ t: "state_snapshot" });
      try {
        const result = assertValid("stateSnapshot", reply);
        // The reply may precede a newer broadcast or pending local work. Return
        // its coherent pair without rolling back the runtime's displayed view.
        return { state: clone(result.state), rev: result.rev, scopes: clone(result.scopes) };
      } catch {
        throw Object.assign(new Error("The service returned an invalid state snapshot"), { code: "invalid_response" });
      }
    },
    apply(ops, options) { return localOps(normalizeStateOps(ops), options); },
    set(path: Path, value: any, options?: StateWriteOptions) {
      const p = toPath(path);
      if (!p.length) throw new Error("tendril.state.set needs a path");
      return localOps(normalizeStateOps([value === undefined ? { op: "delete", path: p } : { op: "set", path: p, value }]), options);
    },
    delete(path: Path, options?: StateWriteOptions) {
      const p = toPath(path);
      if (!p.length) throw new Error("tendril.state.delete needs a path");
      return localOps([{ op: "delete", path: p }], options);
    },
    patch(mergePatch: object, options?: StateWriteOptions) {
      if (!mergePatch || typeof mergePatch !== "object" || Array.isArray(mergePatch)) throw new Error("tendril.state.patch needs an object");
      assertStateJson(mergePatch);
      const patch = clone(mergePatch);
      return localOps(current => mergePatchToOps(current, patch), options);
    },
    on(fn) { stateListeners.add(fn); return () => { stateListeners.delete(fn); }; },
  };

  const resetState = (s: any, r: number, by: string) => {
    confirmed = s && typeof s === "object" && !Array.isArray(s) ? s : {};
    rev = r || 0;
    fullStateRev = rev;
    rebuild();
    persistSoon();
    emitState([], by);
  };

  // ---------- connection ----------
  const sentThisConn = new Set<string>();
  const uploadWaiters = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  const captureWaiters = new Map<string, Set<(result: CaptureResult) => void>>();
  const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const captureRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  type CaptureOutcome = Exclude<CaptureResult, { status: "queued" }>;
  const captureOutcomes = new Map<string, CaptureOutcome>();
  const settlingCaptures = new Set<string>();
  const captureRemovals = new Map<string, Promise<void>>();
  const timerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const timerAttempts = new Map<string, number>();
  // A receipt first becomes a durable outbox phase, then the command is removed.
  // Memory only bridges failed phase writes; it never implies saved completion.
  const timerOutcomes = new Map<string, TimerTerminalResult>();
  const settlingCommands = new Set<string>();
  const commandRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let welcome: any = null;
  let presence: Presence | null = null;

  const wsUrl = () => {
    if (/^wss?:/.test(cfg.ws)) return cfg.ws;
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + cfg.ws;
  };

  const hello = () => ({
    t: "hello",
    device_id: device.id,
    device_secret: stored.secret,
    name: device.name,
    ua: navigator.userAgent,
    version: cfg.version,
    rev,
    caps: probeCaps(),
  });

  const connection = createConnection({
    url: wsUrl,
    hello,
    message: message => handle(message),
    disconnected(wasConnected) {
      sentThisConn.clear();
      receipts.disconnected();
      requests.disconnected();
      if (wasConnected) bus.emit("disconnect");
    },
  }, { socket: cfg.preview ? window.__TENDRIL_TRANSPORT__ : undefined });
  const rawSend = connection.send;
  let pendingHealth: { ok: boolean; errors: string[] } | null = null;
  const sendHealth = () => {
    if (!pendingHealth || document.visibilityState !== "visible" || !connection.connected) return;
    if (rawSend({ t: "health", version: cfg.version, visible: true, ...pendingHealth })) pendingHealth = null;
  };
  const receipts = createCommandReceipts(() => connection.connected);
  const requests = createRequests({ connected: () => connection.connected, send: rawSend,
    enqueue: message => enqueue(message), newCid });
  window.addEventListener("online", connection.reconnect);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { connection.reconnect(); sendHealth(); }
  });

  // ---------- outbox ----------
  const pendingTimers = (): PendingTimerCommand[] => store.items.filter(item => item.msg.t === "timer_command")
    .map(item => ({ ...clone(item.msg.intent), cid: item.cid, status: "queued" }));
  const timerQueueChanged = () => bus.emit("timer_queue", pendingTimers());
  const retryTimer = (item: OutboxItem, error: unknown) => {
    if (!store.has(item.cid) || timerRetryTimers.has(item.cid)) return;
    if (error instanceof TimerHttpError && error.code === "invalid_response")
      bus.emit("error", { code: error.code, message: error.message, cid: item.cid });
    const attempts = (timerAttempts.get(item.cid) || 0) + 1;
    timerAttempts.set(item.cid, attempts);
    timerRetryTimers.set(item.cid, setTimeout(() => {
      timerRetryTimers.delete(item.cid);
      sentThisConn.delete(item.cid);
      void pump();
    }, Math.min(30_000, 5000 * 2 ** Math.min(attempts - 1, 3))));
  };
  const captures = (): PendingCapture[] => store.items.filter((item) => item.msg.t === "upload_event").map((item) => ({
    capture_id: item.cid, name: item.msg.name, data: clone(item.msg.data),
    scope: item.msg.scope, expected_generations: clone(item.msg.expected_generations),
    status: item.msg.failed ? "rejected" : "queued", ...(item.msg.uploaded ? { blob: clone(item.msg.uploaded) } : {}),
    ...(item.msg.failed || {}),
  }));
  const captureQueueChanged = () => bus.emit("capture_queue", captures());
  const captureReceipt = (result: CaptureResult) => {
    if (result.status !== "queued") {
      const retry = captureRetryTimers.get(result.capture_id);
      if (retry) clearTimeout(retry);
      captureRetryTimers.delete(result.capture_id);
    }
    bus.emit("upload_event", clone(result));
    for (const resolve of captureWaiters.get(result.capture_id) || []) resolve(clone(result));
    captureWaiters.delete(result.capture_id);
    const timer = captureTimers.get(result.capture_id);
    if (timer) clearTimeout(timer);
    captureTimers.delete(result.capture_id);
    captureQueueChanged();
  };
  const removeCapture = (item: OutboxItem, result: CaptureOutcome): Promise<void> => {
    const removing = captureRemovals.get(item.cid);
    if (removing) return removing;
    const removal = (async () => {
      if (result.status === "accepted" && !item.msg.outcome) {
        await store.updateDurable(item, { ...item.msg, outcome: clone(result) });
      }
      if (!store.has(item.cid)) return;
      await store.removeDurable(item.cid);
      captureOutcomes.delete(item.cid);
      captureReceipt(result);
    })();
    captureRemovals.set(item.cid, removal);
    void removal.then(() => captureRemovals.delete(item.cid), () => captureRemovals.delete(item.cid));
    return removal;
  };
  const settleCaptureOutcome = async (item: OutboxItem): Promise<void> => {
    if (settlingCaptures.has(item.cid) || !store.has(item.cid)) return;
    const outcome: CaptureOutcome | undefined = item.msg.outcome || captureOutcomes.get(item.cid);
    if (!outcome) return;
    settlingCaptures.add(item.cid);
    try {
      // Rejections retain their saved bytes and intent for explicit retry. An
      // accepted receipt must survive reload before its queue row is removed.
      if (outcome.status === "accepted") await removeCapture(item, outcome);
      else {
        if (!item.msg.outcome) await store.updateDurable(item, { ...item.msg, outcome: clone(outcome),
          failed: { error: outcome.error, message: outcome.message } });
        if (!store.has(item.cid)) return; // A concurrent discard owns its durable removal.
        captureOutcomes.delete(item.cid);
        captureReceipt(outcome);
      }
    } catch {
      // A known decision only retries local persistence. Do not send another
      // upload, pin or semantic event while its outcome is still uncertain.
      if (store.has(item.cid) && !captureRetryTimers.has(item.cid)) {
        captureRetryTimers.set(item.cid, setTimeout(() => {
          captureRetryTimers.delete(item.cid);
          void settleCaptureOutcome(item);
        }, 5000));
      }
    } finally { settlingCaptures.delete(item.cid); }
  };
  const captureDecided = (item: OutboxItem, outcome: CaptureOutcome): Promise<void> => {
    if (item.msg.failed && item.msg.outcome?.status === "rejected") return Promise.resolve();
    if (!captureOutcomes.has(item.cid)) {
      captureOutcomes.set(item.cid, clone(item.msg.outcome || outcome));
      const retry = captureRetryTimers.get(item.cid);
      if (retry) clearTimeout(retry);
      captureRetryTimers.delete(item.cid);
    }
    return settleCaptureOutcome(item);
  };
  const captureFailed = (item: OutboxItem, error: string, message: string) =>
    captureDecided(item, { capture_id: item.cid, status: "rejected", error, message });
  const waitForCapture = (item: OutboxItem): Promise<CaptureResult> => {
    const promise = new Promise<CaptureResult>((resolve) => {
      const existing = captureWaiters.get(item.cid);
      if (existing) { existing.add(resolve); return; }
      captureWaiters.set(item.cid, new Set([resolve]));
      captureTimers.set(item.cid, setTimeout(() => {
        captureReceipt({ capture_id: item.cid, status: "queued" });
      }, connection.connected ? 8000 : 0));
    });
    captureQueueChanged();
    void pump();
    return promise;
  };

  const enqueue = (msg: any, blob?: Blob): OutboxItem => {
    const it = store.add(msg, blob);
    pump();
    return it;
  };

  const ensureUploaded = async (item: OutboxItem): Promise<BlobReference | null> => {
    if (!store.has(item.cid)) return null;
    if (!item.msg.uploaded) {
      const uploaded = await blobs.upload(item.blob!, item.msg.name, item.cid);
      if (!store.has(item.cid)) return null;
      // Each completed phase becomes durable before starting its dependent phase.
      await store.updateDurable(item, { ...item.msg, uploaded });
    }
    if (!store.has(item.cid)) return null;
    if (item.msg.pin && !item.msg.pinned) {
      const uploaded = await blobs.pin(item.msg.uploaded.id, item.msg.pin);
      if (!store.has(item.cid)) return null;
      await store.updateDurable(item, { ...item.msg, uploaded, pinned: true });
    }
    return store.has(item.cid) ? item.msg.uploaded : null;
  };

  const applicationOutcomes = new Map<string, ApplicationOperation>();
  const deliverApplication = async (item: OutboxItem): Promise<ApplicationOperation> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        core.request<ApplicationOperation>("application/changes", { method: "POST", signal: controller.signal,
          body: { program: item.msg.program, operationId: item.msg.operationId } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error("Application receipt timed out; retry the original operation"));
        }, 15_000); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const hasCommandAck = (item: OutboxItem) => item.msg.t === "state" || item.msg.t === "send";
  const settleCommandAck = async (item: OutboxItem): Promise<void> => {
    if (settlingCommands.has(item.cid) || !store.has(item.cid)) return;
    const ack = item.msg.outcome || commandOutcomes.get(item.cid);
    if (!ack) return;
    settlingCommands.add(item.cid);
    try {
      if (!item.msg.outcome) await store.updateDurable(item, { ...item.msg, outcome: clone(ack) });
      const p = pendingState.find(value => value.cid === item.cid);
      if (p && !reconciledStateAcks.has(item.cid)) {
        if (!ack.error && p.ops.length && typeof ack.rev === "number" && ack.rev > fullStateRev && ack.rev <= rev) {
          // N+1 can arrive before our ACK for N. Save that ACK, then obtain the
          // complete state; its old operations must never cover newer values.
          connection.close(4000, "state resync");
          return;
        }
        if (!ack.error && p.ops.length && typeof ack.rev === "number" && ack.rev > rev &&
          !matchesContext(scopes, p, "state", p.ops)) {
          // The accepted write belongs to an older scope generation. Its
          // revision is authoritative, but applying its old intent locally
          // after a reset could cover a newer state. Keep it until resync.
          connection.close(4000, "state resync");
          return;
        }
        const before = JSON.stringify(local);
        if (!ack.error && p.ops.length && typeof ack.rev === "number" && ack.rev > rev && matchesContext(scopes, p, "state", p.ops)) {
          try { confirmed = applyOps(confirmed, p.ops); }
          catch (error) {
            if (!(error instanceof StatePathError)) throw error;
            connection.close(4000, "state resync");
            return;
          }
          rev = ack.rev;
        }
        // This authoritative update is applied once, even if local deletion
        // needs retries while later state broadcasts continue to arrive.
        reconciledStateAcks.add(item.cid);
        rebuild();
        if (JSON.stringify(local) !== before) emitState([], "server");
        persistSoon();
      }
      await store.removeDurable(item.cid);
      const sent = item.msg;
      if (p) {
        pendingState = pendingState.filter(value => value.cid !== item.cid);
        bus.emit("state_result", { cid: p.cid, ops: p.ops, scope: p.scope, expected_generations: p.expected_generations, ...normalizeStateChecks(p), ...(ack.error
          ? stateRejection(ack)
          : { status: "accepted", rev: ack.rev }) });
        stateQueueChanged();
        if (ack.error) emitState([], "rejected");
        persistSoon();
      }
      if (sent.t === "send" && sent.kind !== "instruction") {
        const result: SendResult = ack.error
          ? { status: "rejected", error: String(ack.error?.code || ack.error),
            message: ack.message || ack.error?.message || "The input was rejected. Please try again." }
          : { status: "accepted", seq: ack.seq };
        bus.emit("send_result", clone({ cid: item.cid, scope: sent.scope, expected_generations: sent.expected_generations, data: sent.data, ...result }));
      }
      if (sent.t === "send" && sent.kind === "instruction") {
        const mine = transcript.find(entry => entry.cid === item.cid && entry.device === device.id);
        const result: ConversationResult = ack.error
          ? { cid: item.cid, status: "rejected", error: String(ack.error?.code || ack.error),
            message: ack.message || ack.error?.message || "Message rejected. Edit or retry the retained text." }
          : { cid: item.cid, status: "accepted", seq: ack.seq };
        if (mine) { Object.assign(mine, result); persistSoon(); bus.emit("transcript", clone(mine)); }
        bus.emit("conversation_result", { ...result, text: sent.text });
      }
      commandOutcomes.delete(item.cid);
      reconciledStateAcks.delete(item.cid);
      const retry = commandRetryTimers.get(item.cid);
      if (retry) clearTimeout(retry);
      commandRetryTimers.delete(item.cid);
      requests.receive(clone(ack));
      receipts.acknowledge(item.cid, clone(ack));
    } catch {
      // Neither a failed phase write nor a failed deletion authorizes a new
      // network decision. Keep the known ACK in memory and retry local storage.
      if (store.has(item.cid) && !commandRetryTimers.has(item.cid)) {
        commandRetryTimers.set(item.cid, setTimeout(() => {
          commandRetryTimers.delete(item.cid);
          void settleCommandAck(item);
        }, 5000));
      }
    } finally {
      settlingCommands.delete(item.cid);
    }
  };

  let pumping = false;
  const pump = async () => {
    if (pumping || !connection.connected) return;
    pumping = true;
    try {
      for (;;) {
        if (!connection.connected) break;
        const item = store.items.find((i) => !i.msg.failed && !sentThisConn.has(i.cid));
        if (!item) break;
        sentThisConn.add(item.cid);
        if (item.msg.t === "application") {
          try {
            let received = item.msg.outcome || applicationOutcomes.get(item.cid);
            if (!received) {
              try { received = await deliverApplication(item); }
              catch (error) {
                const failure = error as { status?: number; code?: string; message?: string };
                // Only the backend's exact-identity admission decisions establish
                // rejection. Host authentication/routing failures can hide an
                // already accepted operation whose earlier response was lost.
                if (!(failure.status === 429 && failure.code === "history_quota" ||
                    failure.status === 409 && failure.code === "operation_conflict")) throw error;
                received = { operationId: item.msg.operationId, proposalId: "", status: "final", outcome: "rejected", error: failure.code || "admission_failed", message: failure.message };
              }
            }
            const outcome = validateApplicationOperation(received, item.msg.operationId, { terminal: true });
            applicationOutcomes.set(item.cid, outcome);
            if (!item.msg.outcome) await store.updateDurable(item, { ...item.msg, outcome: clone(outcome), ...(outcome.outcome === "rejected" ? { failed: true } : {}) });
            if (outcome.outcome !== "rejected") await store.removeDurable(item.cid);
            sentThisConn.delete(item.cid);
            applicationOutcomes.delete(item.cid);
            bus.emit("application_operation", clone(outcome));
            receipts.acknowledge(item.cid, clone(outcome));
          } catch (error) {
            sentThisConn.delete(item.cid);
            setTimeout(() => { sentThisConn.delete(item.cid); void pump(); }, 1000);
            break;
          }
          continue;
        }
        if (item.msg.t === "timer_command") {
          try {
            const result: TimerTerminalResult = item.msg.outcome || timerOutcomes.get(item.cid) || await timers.deliver(item.msg.intent);
            timerOutcomes.set(item.cid, result);
            if (!item.msg.outcome) await store.updateDurable(item, { ...item.msg, outcome: clone(result) });
            await store.removeDurable(item.cid);
            timerOutcomes.delete(item.cid);
            const retry = timerRetryTimers.get(item.cid);
            if (retry) clearTimeout(retry);
            timerRetryTimers.delete(item.cid);
            timerAttempts.delete(item.cid);
            // The original promise can be gone after reload. Its exact command
            // remains in the event so the page can identify the reviewed intent.
            bus.emit("timer_result", clone({ ...item.msg.intent, ...result }));
            receipts.acknowledge(item.cid, clone(result));
            timerQueueChanged();
          } catch (error) {
            retryTimer(item, error);
            break;
          }
          continue;
        }
        if (hasCommandAck(item) && (item.msg.outcome || commandOutcomes.has(item.cid))) {
          await settleCommandAck(item);
          continue;
        }
        if (item.msg.t === "upload_event") {
          if (item.msg.outcome || captureOutcomes.has(item.cid)) {
            await settleCaptureOutcome(item);
            continue;
          }
          try {
            if (!await ensureUploaded(item)) continue;
            const msg = item.msg;
            if (!connection.connected || !rawSend({ t: "capture_complete", cid: msg.event_cid, scope: msg.scope, expected_generations: msg.expected_generations, blob: msg.uploaded.id,
              data: { ...captureData(msg.data, msg.dataPath, msg.uploaded), capture_id: item.cid }, wake: msg.wake, gesture: msg.gesture })) {
              sentThisConn.delete(item.cid);
              break;
            }
            const previous = captureRetryTimers.get(item.cid);
            if (previous) clearTimeout(previous);
            captureRetryTimers.set(item.cid, setTimeout(() => {
              captureRetryTimers.delete(item.cid);
              if (!store.has(item.cid) || item.msg.failed) return;
              if (item.msg.outcome || captureOutcomes.has(item.cid)) { void settleCaptureOutcome(item); return; }
              sentThisConn.delete(item.cid);
              void pump();
            }, 8000));
          } catch (error) {
            if (!store.has(item.cid)) continue;
            if (permanentUploadFailure(error)) {
              await captureFailed(item, (error as any).code, (error as Error).message);
            } else if (error instanceof TypeError && /dataPath/.test(error.message)) {
              await captureFailed(item, "invalid_capture", error.message);
            } else {
              sentThisConn.delete(item.cid);
              setTimeout(() => { sentThisConn.delete(item.cid); void pump(); }, 5000);
              break;
            }
          }
          continue;
        }
        if (item.msg.t === "upload") {
          try {
            const r = await ensureUploaded(item);
            if (!r) continue;
            await store.removeDurable(item.cid);
            // After a reload the original promise is gone; pages learn the result from the event.
            bus.emit("upload", { cid: item.cid, name: item.msg.name ?? null, ...r });
            uploadWaiters.get(item.cid)?.res(r);
            uploadWaiters.delete(item.cid);
          } catch (e) {
            if (permanentUploadFailure(e)) {
              await store.removeDurable(item.cid);
              bus.emit("error", { code: (e as any).code, message: (e as Error).message });
              uploadWaiters.get(item.cid)?.rej(e);
              uploadWaiters.delete(item.cid);
            } else {
              sentThisConn.delete(item.cid);
              setTimeout(() => { sentThisConn.delete(item.cid); pump(); }, 5000);
              break; // keep order: later items wait for this upload
            }
          }
          continue;
        }
        if (!rawSend(item.msg)) { sentThisConn.delete(item.cid); break; }
        if (deliveryPolicy(item.msg.t).outboxCompletion !== "ack") store.remove(item.cid);
      }
    } finally {
      pumping = false;
    }
  };

  /** Queue an acked message; resolves with the ack, or null if it stays queued. */
  const sendAcked = async (msg: any, saved?: () => void): Promise<any | null> => {
    try {
      await storeReady;
      await store.addDurable(msg);
    } catch (error) {
      return { error: "storage_unavailable", message: error instanceof Error ? error.message : "Could not save this input." };
    }
    saved?.();
    const pending = receipts.wait(msg.cid);
    void pump();
    return pending;
  };

  /** Proves this device to page HTTP routes (PROTOCOL 2.1). */
  const deviceHeaders = (): Record<string, string> => ({ "X-Tendril-Device": stored.id, "X-Tendril-Device-Secret": stored.secret });

  const blobs = createBrowserBlobs(cfg.base, deviceHeaders);
  const timers = createBrowserTimers({
    base: cfg.base, headers: deviceHeaders, scopes: () => scopes, newCid, pending: pendingTimers,
    async queue(intent: TimerIntent) {
      const cid = intent.command.cid;
      let saved = false;
      const result = await sendAcked({ t: "timer_command", cid, intent }, () => {
        saved = true;
        timerQueueChanged();
        bus.emit("timer_result", { ...clone(intent), cid, status: "queued" });
      });
      if (saved) return result || { cid, status: "queued" };
      const rejected: TimerMutationResult = { cid, status: "rejected", error: result.error,
        message: result.message || "Could not save this timer command. Keep the reviewed settings and try again." };
      bus.emit("timer_result", { ...clone(intent), ...rejected });
      return rejected;
    },
  });

  // ---------- incoming ----------
  const addTranscript = (e: TranscriptEntry) => {
    transcript.push(e);
    if (transcript.length > TRANSCRIPT_MAX) transcript.splice(0, transcript.length - TRANSCRIPT_MAX);
    persistSoon();
    bus.emit("transcript", clone(e));
  };


  let pendingReload: number | null = null;
  let reloadStarted = false;
  const maybeReload = (version: any, guard: boolean) => {
    if (version == null || version === cfg.version) return;
    if (pendingReload === version || reloadStarted) return;
    if (guard) {
      const k = `tendril:${cfg.id}:reloaded`;
      try {
        if (sessionStorage.getItem(k) === String(version)) return;
      } catch { return; }
    }
    pendingReload = version;
    bus.emit("reload", { version });
    const apply = () => {
      if (reloadStarted) return;
      reloadStarted = true;
      if (guard) { try { sessionStorage.setItem(`tendril:${cfg.id}:reloaded`, String(version)); } catch { /* optional guard */ } }
      if (snapTimer) { clearTimeout(snapTimer); snapTimer = 0; }
      store.saveSnapshot(snapshot());
      void store.flush(1000).then(() => {
        const latest = documentUrl(cfg, new URL(cfg.base, location.href));
        latest.search = location.search; latest.hash = location.hash;
        location.assign(latest.href);
      });
    };
    // Page components can save their drafts and defer an update until the person is ready.
    const event = new CustomEvent("tendril:before-reload", { cancelable: true, detail: { version, apply } });
    if (window.dispatchEvent(event)) apply();
  };

  let axeLoading: Promise<any> | null = null;
  const loadAxe = (): Promise<any> => {
    const w = window as any;
    if (w.axe) return Promise.resolve(w.axe);
    if (!axeLoading) {
      axeLoading = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = runtimeAsset(cfg, "axe.min.js");
        s.async = true;
        s.onload = () => (w.axe ? res(w.axe) : rej(new Error("axe-core did not load")));
        s.onerror = () => { axeLoading = null; s.remove(); rej(new Error("could not load the bundled accessibility checker from " + runtimeAsset(cfg, "axe.min.js"))); };
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return axeLoading;
  };

  const runEval = async (callId: string, code: string) => {
    let reply: any;
    try {
      const fn = new AsyncFunction(String(code));
      const v = await fn.call(window);
      reply = { t: "eval_result", call_id: callId, ok: true, value: serialize(v) };
    } catch (e) {
      reply = { t: "eval_result", call_id: callId, ok: false, error: errorString(e) };
    }
    rawSend(reply);
  };

  const runCheck = async (callId: string) => {
    let reply: any;
    try {
      const axe = await loadAxe();
      const r = await axe.run(document, { resultTypes: ["violations"] });
      const violations = (r.violations || []).map((v: any) => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: (v.nodes || []).length }));
      reply = { t: "eval_result", call_id: callId, ok: true, value: { violations } };
    } catch (e) {
      reply = { t: "eval_result", call_id: callId, ok: false, error: errorString(e) };
    }
    rawSend(reply);
  };

  const notifyLocal = (m: any) => {
    const payload = { title: m.title || "", body: m.body || "" };
    const N = (window as any).Notification;
    if (N && N.permission === "granted") {
      try { new N(payload.title, { body: payload.body }); return; } catch { /* Android: needs the service worker */ }
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistration(cfg.base).then((reg) => {
          if (reg) reg.showNotification(payload.title, { body: payload.body });
          else bus.emit("notify_local", payload);
        }).catch(() => bus.emit("notify_local", payload));
        return;
      }
    }
    bus.emit("notify_local", payload);
  };

  const setRole = (role: Role, pending: boolean, pairCode?: string) => {
    device.role = role;
    device.pending = !!pending;
    if (pairCode) device.pairCode = pairCode; else delete device.pairCode;
    if (stored.role !== role) { stored.role = role; saveDevice(cfg.id, stored); }
  };

  const installScopes = (value: unknown) => {
    if (!Array.isArray(value)) return;
    scopes = clone(value);
    bus.emit("scopes", clone(scopes));
  };

  const handle = (m: any) => {
    // Rejections correlated to queued input are terminal acknowledgements too. Keeping
    // them queued would turn an explicit rejection into a misleading "saved" result.
    if (m.t === "error" && m.cid && store.items.some((item) => item.cid === m.cid || item.msg.event_cid === m.cid)) {
      bus.emit("error", m);
      m = { ...m, t: "ack", error: m.code || "rejected" };
    }
    // Replies correlated by cid.
    const durableAck = m.t === "ack" && store.items.some(item => item.cid === m.cid && hasCommandAck(item));
    if (!durableAck && requests.receive(m) && m.t !== "ack") return;
    switch (m.t) {
      case "stream_record":
        bus.emit("stream_record", m.record);
        break;
      case "record_log_head":
        try { bus.emit("record_log_head", validateRecordHead(m.head)); }
        catch { bus.emit("error", { code: "invalid_response", message: "Invalid record log hint" }); }
        break;
      case "application_revision":
        if (typeof m.revision === "string") bus.emit("application_revision", { revision: m.revision });
        break;
      case "welcome": {
        welcome = m;
        installScopes(m.scopes);
        service = m.service || null;
        setRole(m.role || device.role, !!m.pending, m.pair_code);
        if (m.device_purpose !== undefined) (device as any).purpose = m.device_purpose;
        presence = m.presence ?? presence;
        if (Array.isArray(m.transcript)) {
          const received = m.transcript as TranscriptEntry[];
          const local = transcript.filter(entry => entry.cid && entry.device === device.id &&
            (entry.status === "queued" || entry.status === "rejected") &&
            !received.some(other => other.cid === entry.cid && other.device === entry.device));
          transcript = [...received, ...local].sort((a, b) => a.ts - b.ts).slice(-TRANSCRIPT_MAX);
          persistSoon();
        }
        if (m.features) {
          // Service availability can evolve; dependencies selected by the
          // executing publication keep their original configuration.
          Object.assign(cfg.features, m.features, cfg.publication?.runtime.features);
        }
        if (m.state && typeof m.state === "object") resetState(m.state, m.rev, "server");
        else if (typeof m.rev === "number" && m.rev > rev) rev = m.rev;
        connection.welcome();
        bus.emit("welcome", m);
        bus.emit("role", { role: device.role, pending: device.pending });
        if (presence) bus.emit("presence", presence);
        bus.emit("transcript", null);
        bus.emit("connect");
        requests.flush();
        sendHealth();
        pump();
        // `served` is what a reload would load (a failed current falls back to healthy), so
        // comparing against it avoids a pointless reload after a failed version.
        const cur = m.version && (m.version.served ?? m.version.current);
        if (cur != null) maybeReload(cur, true);
        break;
      }
      case "ack": {
        const capture = store.items.find((item) => item.msg.t === "upload_event" && item.msg.event_cid === m.cid);
        if (capture) {
          if (m.error) void captureFailed(capture, String(m.error?.code || m.error), m.message || m.error?.message || "The capture was rejected. You can retry it.");
          else if (typeof m.seq === "number") {
            void captureDecided(capture, { capture_id: capture.cid, status: "accepted", seq: m.seq, blob: capture.msg.uploaded });
          }
          break;
        }
        const item = m.cid ? store.items.find(value => value.cid === m.cid) : undefined;
        if (item && hasCommandAck(item)) {
          // Preserve the first received outcome even if the server does not
          // cache this rejection and a later attempt would be allowed.
          if (!commandOutcomes.has(item.cid)) commandOutcomes.set(item.cid, clone(item.msg.outcome || m));
          sentThisConn.add(item.cid);
          void settleCommandAck(item);
          break;
        }
        if (m.cid) store.remove(m.cid);
        receipts.acknowledge(m.cid, m);
        break;
      }
      case "state": {
        installScopes(m.scopes);
        const ops: Op[] = Array.isArray(m.ops) ? m.ops : [];
        try { confirmed = applyOps(confirmed, ops); }
        catch (error) {
          if (!(error instanceof StatePathError)) throw error;
          // A later writer can validly traverse a parent created by our own
          // unacknowledged command. This delta cannot be applied to our older
          // confirmed snapshot: retain the outbox and obtain the complete state.
          connection.close(4000, "state resync");
          break;
        }
        if (typeof m.rev === "number") rev = m.rev;
        if (pendingState.length) rebuild();
        else local = clone(confirmed);
        persistSoon();
        emitState(ops, m.by || "server");
        break;
      }
      case "state_reset":
        installScopes(m.scopes);
        resetState(m.state, m.rev, "server");
        break;
      case "scopes":
        installScopes(m.scopes);
        rebuild();
        persistSoon();
        emitState([], "server");
        break;
      case "fixture_event":
        if (cfg.preview === true && typeof m.event === "string") bus.emit(m.event, m.data);
        break;
      case "reload":
        maybeReload(m.version, false);
        break;
      case "presence": {
        const { t: _t, ...p } = m;
        presence = (m.presence || p) as Presence;
        bus.emit("presence", presence);
        break;
      }
      case "say": {
        let message;
        try { message = assertValid("sayMessage", m); }
        catch (error) {
          bus.emit("error", { code: "invalid_response", message: "Invalid reply: " + (error instanceof Error ? error.message : "The service sent an invalid reply") });
          break;
        }
        if (message.present !== false) {
          const existing = transcript.some(entry => entry.message_id === message.message_id);
          if (!existing) addTranscript({ ts: message.ts, from: "agent", text: message.text,
            message_id: message.message_id, ...(message.in_reply_to === undefined ? {} : { in_reply_to: message.in_reply_to }) });
          bus.emit("say", clone(message));
        }
        // All routing information is observable; optional presentation adapters
        // decide whether to speak. The kernel never constructs an audio engine.
        bus.emit("reply", clone(message));
        break;
      }
      case "instruction_echo": {
        const mine = m.cid && transcript.find(entry => entry.cid === m.cid && entry.device === m.device);
        const entry: TranscriptEntry = { ts: m.ts || Date.now(), from: "user", text: String(m.text ?? ""),
          message_id: m.message_id, cid: m.cid, device: m.device, status: "accepted" };
        if (mine) { Object.assign(mine, entry); persistSoon(); bus.emit("transcript", clone(mine)); }
        else if (!m.message_id || !transcript.some(value => value.message_id === m.message_id)) addTranscript(entry);
        bus.emit("instruction_echo", m);
        break;
      }
      case "role":
        setRole(m.role, !!m.pending, m.pair_code);
        bus.emit("role", { role: device.role, pending: device.pending });
        break;
      case "device_config": {
        const current = Array.isArray(m.devices) ? m.devices.find((entry: any) => entry.id === device.id) : null;
        if (current && current.purpose !== undefined) (device as any).purpose = current.purpose;
        if (welcome) welcome = { ...welcome, focus: m.focus ?? null, devices: m.devices };
        bus.emit("device_config", m);
        break;
      }
      case "eval":
        runEval(m.call_id, m.code);
        break;
      case "check":
        runCheck(m.call_id);
        break;
      case "notify_local":
        notifyLocal(m);
        break;
      case "pong":
        break;
      case "error":
        bus.emit("error", m);
        break;
      default:
        // versions, activity, devices, links, adopt_code … (also delivered via request())
        bus.emit(m.t, m);
    }
  };

  // ---------- diagnostics ----------
  installLogForwarding((entries: LogEntry[]) => {
    const msg = { t: "log", entries };
    if (connection.connected && rawSend(msg)) return;
    store.add({ ...msg, cid: newCid() });
  });
  const health = createHealth((ok, errors) => {
    pendingHealth = { ok, errors };
    sendHealth();
  }, 2000);

  // ---------- public ----------
  function raw(msg: any) {
    requests.raw(msg);
  }

  const core: Internal = {
    ...createPageHost(cfg, deviceHeaders),
    bus,
    config: cfg,
    device,
    get connected() { return connection.connected; },
    get presence() { return presence; },
    get transcript() { return transcript; },
    get welcome() { return welcome; },
    application,
    get rev() { return rev; },
    state,
    timers: timers.api,
    streams: createStreams({ bus, base: cfg.base, connected: () => connection.connected, headers: deviceHeaders, request: message => core.transportRequest(message) }),
    records: createRecordLogClient({ base: cfg.base + "_tendril", headers: deviceHeaders, subscribeHints: listener => {
      const offHead = bus.on("record_log_head", listener), offConnect = bus.on("connect", listener);
      return () => { offHead(); offConnect(); };
    } }),
    health,
    scopes: {
      list: () => clone(scopes),
      capture: (scope: string) => captureContext(scopes, "event", { scope }),
    },
    get service() { return service ? clone(service) : null; },
    conversation: {
      entries: () => clone(transcript),
      send: (text, options) => core.instruction(text, options?.via || "text"),
      presented(messageId) {
        if (typeof messageId !== "string" || !messageId || messageId.length > 128) throw new TypeError("A reply message ID is required");
        raw({ t: "say_rendered", message_id: messageId });
      },
    },
    async send(data: any, opts?: OperationOptions & { wake?: boolean }): Promise<SendResult> {
      // Browser user activation marks a real tap or key press; page code cannot fake it. The server
      // treats such events from owner devices as human input for the page-wake cap (PROTOCOL 8.2).
      const gesture = !!(navigator as any).userActivation?.isActive;
      const msg = { t: "send", cid: newCid(), ...captureContext(scopes, "event", opts), data: data === undefined ? null : serialize(data), wake: opts?.wake !== false, gesture };
      const ack = await sendAcked(msg);
      if (!ack) return { status: "queued" };
      if (ack.error) return { status: "rejected",
        error: String(ack.error?.code || ack.error), message: ack.message || ack.error?.message || "The input was rejected. Please try again." };
      return { status: "accepted", seq: ack.seq };
    },
    async instruction(text: string, via: "voice" | "text"): Promise<ConversationResult> {
      if (typeof text !== "string" || !text.trim()) throw new TypeError("Conversation input requires nonempty text");
      const cid = newCid();
      const entry: TranscriptEntry = { ts: Date.now(), from: "user", text, status: "queued", cid, device: device.id };
      const context = captureContext(scopes, "event");
      let saved = false;
      const ack = await sendAcked({ t: "send", cid, ...context, kind: "instruction", text, via, data: { text, via }, wake: true }, () => {
        saved = true; addTranscript(entry);
        bus.emit("conversation_result", { cid, text, status: "queued" });
      });
      const result: ConversationResult = ack?.error
        ? { cid, status: "rejected", error: String(ack.error?.code || ack.error),
          message: ack.message || ack.error?.message || "Message rejected. Keep the text and try again." }
        : ack ? { cid, status: "accepted", seq: ack.seq } : { cid, status: "queued" };
      if (!saved) bus.emit("conversation_result", { ...result, text });
      return result;
    },
    transportRequest: requests.request,
    raw,
    captures,
    pendingWork() {
      return {
        events: store.items.filter(item => item.msg.t === "send").length,
        state: savingState + new Set([...pendingState.map(item => item.cid), ...store.items.filter(item => item.msg.t === "state").map(item => item.cid)]).size,
        captures: store.items.filter(item => item.msg.t === "upload_event" || item.msg.t === "upload").length,
        timers: store.items.filter(item => item.msg.t === "timer_command").length,
      };
    },
    async uploadEvent(blob: Blob, opts: CaptureOptions): Promise<CaptureResult> {
      if (!(blob instanceof Blob)) throw new TypeError("tendril.uploadEvent needs a Blob");
      if (blob.size > RESOURCE_LIMITS.blob_bytes) throw new RangeError("Capture exceeds the platform byte limit");
      assertValid("captureOptions", opts);
      const capture_id = newCid();
      const context = captureContext(scopes, "capture", opts);
      const pin = opts.keep === true ? { cid: newCid(), ...captureContext(scopes, "blob.pin", opts), keep: true } : undefined;
      const gesture = !!(navigator as any).userActivation?.isActive;
      const data = serialize(opts.data) as Record<string, unknown>;
      captureData(data, opts.dataPath, { id: "pending", url: "pending" }); // validate before saving
      const message = { t: "upload_event", cid: capture_id, event_cid: newCid(), ...context,
        name: opts.name, data, dataPath: clone(opts.dataPath), pin, wake: opts.wake !== false, gesture };
      await storeReady;
      try {
        const item = await store.addDurable(message, blob);
        return waitForCapture(item);
      } catch (error) {
        const result: CaptureResult = { capture_id, status: "rejected", error: "storage_unavailable",
          message: error instanceof Error ? error.message : "Could not save this capture. Keep it open and try again." };
        captureReceipt(result);
        return result;
      }
    },
    async retryCapture(capture_id: string): Promise<CaptureResult> {
      await storeReady;
      const item = store.items.find((entry) => entry.cid === capture_id && entry.msg.t === "upload_event");
      if (!item) return { capture_id, status: "rejected", error: "not_found", message: "This capture is no longer in the queue." };
      if (item.msg.failed) {
        // Explicit retry clears the saved local rejection, preserving the
        // original command identity, payload and captured generations.
        const { failed: _failed, outcome: _outcome, ...message } = item.msg;
        await store.updateDurable(item, message);
        captureOutcomes.delete(capture_id);
      }
      sentThisConn.delete(item.cid);
      return waitForCapture(item);
    },
    async discardCapture(capture_id: string): Promise<void> {
      await storeReady;
      const item = store.items.find((entry) => entry.cid === capture_id && entry.msg.t === "upload_event");
      if (!item) return;
      // A known server acceptance owns its receipt even if discard is clicked
      // during local cleanup. Share that removal instead of emitting a second,
      // contradictory terminal result.
      const outcome: CaptureOutcome | undefined = item.msg.outcome || captureOutcomes.get(capture_id);
      const result: CaptureOutcome = outcome?.status === "accepted" ? outcome :
        { capture_id, status: "rejected", error: "discarded", message: "Capture removed from this device's queue." };
      try { await removeCapture(item, result); }
      catch (error) {
        // Outcome persistence may have completed while this deletion was in
        // progress. Settle that decision locally: the network pump skips saved
        // rejections and cannot finish their waiting receipt while offline.
        if (captureOutcomes.has(capture_id) || item.msg.outcome?.status === "accepted") void settleCaptureOutcome(item);
        else { sentThisConn.delete(capture_id); void pump(); }
        throw error;
      }
    },
    async setBlobRetention(id: string, opts: OperationOptions & { keep: boolean }): Promise<BlobReference> {
      if (!/^b_[a-z2-7]{20}$/.test(id) || typeof opts?.keep !== "boolean") throw new TypeError("setBlobRetention needs a blob id and {keep:boolean}");
      return blobs.pin(id, { cid: newCid(), ...captureContext(scopes, "blob.pin", opts), keep: opts.keep });
    },
    async upload(blob: Blob, opts?: OperationOptions & { name?: string; keep?: boolean }) {
      if (!(blob instanceof Blob)) throw new TypeError("tendril.upload needs a Blob");
      if (blob.size > RESOURCE_LIMITS.blob_bytes) throw new RangeError("Upload exceeds the platform byte limit");
      const cid = newCid();
      const pin = opts?.keep === true ? { cid: newCid(), ...captureContext(scopes, "blob.pin", opts), keep: true } : undefined;
      const message = { t: "upload", cid, name: opts?.name, pin };
      await storeReady;
      await store.addDurable(message, blob);
      return new Promise((res, rej) => {
        uploadWaiters.set(cid, { res, rej });
        void pump();
      });
    },
    ready: () => health.ready(),
    readyManual: () => health.manual(),
  };

  {
    let authoring = Promise.resolve();
    application.install(createCloudflareApplicationBackend({ id: selection.id,
      onChange(notify) {
        const stop = [bus.on("application_revision", notify), bus.on("state", notify), bus.on("scopes", notify), bus.on("connect", notify)];
        return () => { for (const off of stop) off(); };
      },
      request: async (path, options) => {
        if (path.startsWith("application/operations/")) {
          await storeReady;
          const operationId = decodeURIComponent(path.slice("application/operations/".length));
          const item = store.items.find(item => item.msg.t === "application" && item.msg.operationId === operationId);
          if (item) return clone(item.msg.outcome || { operationId, proposalId: "", status: "queued" });
        }
        return core.request(path, options as Parameters<typeof core.request>[1]);
      },
      async submit(input, options): Promise<CloudflareApplicationSubmission> {
        const program = validateCloudflareProgram(input), operationId = assertApplicationOperationId(options.operationId), cid = `app:${operationId}`;
        let terminal: CloudflareApplicationSubmission | undefined;
        const saved = authoring.then(async () => {
          await storeReady;
          const previous = store.items.find(item => item.cid === cid);
          if (previous) {
            if (previous.msg.t !== "application" || JSON.stringify(previous.msg.program) !== JSON.stringify(program))
              throw Object.assign(new Error("Operation identity already binds different contents"), { code: "operation_conflict" });
            terminal = previous.msg.outcome;
          } else await store.addDurable({ t: "application", cid, operationId, program });
        });
        authoring = saved.catch(() => {});
        await saved;
        if (terminal) return clone(terminal);
        const pending = receipts.wait(cid); void pump();
        return await pending || { operationId, proposalId: "", status: "queued" };
      },
    }));
  }

  // Open the store, merge persisted outbox + snapshot, then connect.
  const storeReady = store.init().then((idbSnap) => {
    if (idbSnap && (!snap || (idbSnap.rev || 0) > (snap.rev || 0))) {
      confirmed = idbSnap.state && typeof idbSnap.state === "object" ? idbSnap.state : {};
      rev = fullStateRev = idbSnap.rev || 0;
      scopes = Array.isArray(idbSnap.scopes) ? idbSnap.scopes : [];
      if (!transcript.length && Array.isArray(idbSnap.transcript)) transcript = idbSnap.transcript;
    }
    for (const item of store.items) {
      if (hasCommandAck(item) && item.msg.outcome) commandOutcomes.set(item.cid, clone(item.msg.outcome));
      if (item.msg.t !== "send" || item.msg.kind !== "instruction") continue;
      if (!transcript.some(entry => entry.cid === item.cid && entry.device === device.id)) {
        transcript.push({ ts: Math.floor(item.key / 1000), from: "user", text: item.msg.text,
          cid: item.cid, device: device.id, status: "queued" });
      }
    }
    const fromOutbox = store.items.filter((i) => i.msg.t === "state").map((i) => ({ cid: i.cid, ops: i.msg.ops as Op[], scope: i.msg.scope, expected_generations: i.msg.expected_generations, ...normalizeStateChecks(i.msg) }));
    const before = JSON.stringify(local);
    // The durable outbox is the only source of work that may be delivered.
    pendingState = store.persistent ? fromOutbox : [];
    rebuild();
    if (JSON.stringify(local) !== before) emitState([], "cache");
    stateQueueChanged();
    captureQueueChanged();
    timerQueueChanged();
    // Restored acceptances only need local cleanup, even without a connection.
    for (const item of store.items) {
      if (item.msg.t === "upload_event" && item.msg.outcome?.status === "accepted") void settleCaptureOutcome(item);
    }
  }).catch(() => {}).finally(() => {
    connection.start();
  });

  return core;
}
