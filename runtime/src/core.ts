import { encodePublicationPath } from "./paths";
// Runtime core (PROTOCOL 7, 11.1): socket, bus, state, offline queue, eval, logs, health.
import type { Bus, Core, Device, Presence, Role, StateApi, TendrilConfig, TranscriptEntry, Path } from "./types";
import { runtimeAsset } from "./assets";
import { OfflineStore, type OutboxItem } from "./offline";
import { assertValid, RESOURCE_LIMITS } from "../../contract/index.mjs";
import type { ConversationResult, OperationOptions, ScopeDescriptor, ServiceDescriptor, StateResult } from "../../contract/index.mjs";
import { captureContext, matchesContext, type OperationContext } from "./generations";
import { serialize, errorString } from "./serialize";
import { loadDevice, saveDevice, guessName, probeCaps, rand32 } from "./device";
import { installLogForwarding, createHealth, type LogEntry } from "./diagnostics";
import { applyOp, applyOps, clone, getPath, mergePatchToOps, toPath, type Op } from "./state";
import { createStreams } from "./streams";
import { createConnection } from "./connection";
import { deliveryPolicy } from "./delivery";
import { createRequests, createCommandReceipts } from "./requests";
import { captureData, type BlobReference, type CaptureOptions, type CaptureResult, type PendingCapture, type SendResult } from "./capture";
import { createBrowserBlobs, BlobHttpError } from "./blob-transfer";

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
        try { fn(payload); } catch (e) { setTimeout(() => { throw e; }); }
      }
    },
  };
}

function newCid(): string { return "c_" + Date.now().toString(36) + rand32(8); }

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

export function createCore(cfg: TendrilConfig): Internal {
  const bus = createBus();
  const stored = loadDevice(cfg.id);
  if (!stored.name) { stored.name = guessName(); saveDevice(cfg.id, stored); }
  const device: Device = { id: stored.id, role: (stored.role as Role) || "owner", name: stored.name, pending: false };
  const store = new OfflineStore(cfg.id);

  // ---------- state ----------
  let confirmed: any = {};
  let local: any = {};
  let rev = 0;
  let fullStateRev = 0;
  type PendingState = { cid: string; ops: Op[] } & OperationContext;
  let scopes: ScopeDescriptor[] = [];
  let service: ServiceDescriptor | null = null;
  let savingState = 0;
  let pendingState: PendingState[] = [];
  let transcript: TranscriptEntry[] = [];

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
    for (const p of pendingState) if (matchesContext(scopes, p, "state", p.ops)) local = applyOps(local, p.ops);
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
      try { fn(clone(local), ops, by); } catch (e) { setTimeout(() => { throw e; }); }
    }
  };
  const stateListeners = new Set<(state: any, ops: any[], by: string) => void>();

  let saving = Promise.resolve();
  const localOps = (operation: Op[] | ((state: any) => Op[]), options?: OperationOptions): Promise<StateResult> => {
    if (Array.isArray(operation) && !operation.length) return Promise.resolve({ status: "accepted", rev });
    const cid = newCid();
    const capturedScopes = clone(scopes), capturedOptions = clone(options);
    let context: OperationContext = { expected_generations: {} };
    let empty = false;
    savingState++;
    // Preserve invocation order even while IndexedDB opens. No optimistic state
    // or network delivery is visible before the command's durable commit.
    const saved = saving.then(async () => {
      await storeReady;
      const ops = typeof operation === "function" ? operation(local) : operation;
      if (!ops.length) { empty = true; return; }
      context = captureContext(capturedScopes, "state", capturedOptions, ops);
      const pending = { cid, ops, ...context };
      await store.addDurable({ t: "state", ...pending });
      pendingState.push(pending);
      rebuild();
      persistSoon();
      emitState(ops, "device:" + device.id);
    });
    saving = saved.then(() => {}, () => {});
    return saved.then(async () => {
      savingState--;
      if (empty) return { status: "accepted", rev } as StateResult;
      const receipt = receipts.wait(cid);
      void pump();
      const ack = await receipt;
      return !ack ? { status: "queued" } as StateResult
        : ack.error ? { status: "rejected", error: String(ack.error?.code || ack.error), message: ack.message || ack.error?.message } as StateResult
        : { status: "accepted", rev: ack.rev } as StateResult;
    }, error => {
      savingState--;
      const result: StateResult = { status: "rejected", error: (error as any)?.code || "storage_unavailable", message: error instanceof Error ? error.message : "Could not save this change." };
      bus.emit("state_result", { cid, ...context, ...result });
      return result;
    });
  };

  const state: StateApi = {
    get revision() { return rev; },
    get(path?: Path) { return clone(getPath(local, toPath(path))); },
    set(path: Path, value: any, options?: OperationOptions) {
      const p = toPath(path);
      if (!p.length) throw new Error("tendril.state.set needs a path");
      return localOps([value === undefined ? { op: "delete", path: p } : { op: "set", path: p, value: clone(value) }], options);
    },
    delete(path: Path, options?: OperationOptions) {
      const p = toPath(path);
      if (!p.length) throw new Error("tendril.state.delete needs a path");
      return localOps([{ op: "delete", path: p }], options);
    },
    patch(mergePatch: object, options?: OperationOptions) {
      if (!mergePatch || typeof mergePatch !== "object" || Array.isArray(mergePatch)) throw new Error("tendril.state.patch needs an object");
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
  const captures = (): PendingCapture[] => store.items.filter((item) => item.msg.t === "upload_event").map((item) => ({
    capture_id: item.cid, name: item.msg.name, data: clone(item.msg.data),
    scope: item.msg.scope, expected_generations: clone(item.msg.expected_generations),
    status: item.msg.failed ? "rejected" : "queued", ...(item.msg.uploaded ? { blob: item.msg.uploaded } : {}),
    ...(item.msg.failed || {}),
  }));
  const captureQueueChanged = () => bus.emit("capture_queue", captures());
  const captureReceipt = (result: CaptureResult) => {
    if (result.status !== "queued") {
      const retry = captureRetryTimers.get(result.capture_id);
      if (retry) clearTimeout(retry);
      captureRetryTimers.delete(result.capture_id);
    }
    bus.emit("upload_event", result);
    for (const resolve of captureWaiters.get(result.capture_id) || []) resolve(result);
    captureWaiters.delete(result.capture_id);
    const timer = captureTimers.get(result.capture_id);
    if (timer) clearTimeout(timer);
    captureTimers.delete(result.capture_id);
    captureQueueChanged();
  };
  const captureFailed = async (item: OutboxItem, error: string, message: string) => {
    // A rejected capture remains visible and retryable; it must not silently disappear.
    const msg = { ...item.msg, failed: { error, message } };
    try { await store.updateDurable(item, msg); } catch { item.msg = msg; }
    captureReceipt({ capture_id: item.cid, status: "rejected", error, message });
  };
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
        if (item.msg.t === "upload_event") {
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
        const latest = new URL(encodePublicationPath(cfg.publication?.entry || "index.html"), new URL(cfg.base, location.href));
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
    if (requests.receive(m) && m.t !== "ack") return;
    switch (m.t) {
      case "stream_record":
        bus.emit("stream_record", m.record);
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
            const receipt: CaptureResult = { capture_id: capture.cid, status: "accepted", seq: m.seq, blob: capture.msg.uploaded };
            void store.removeDurable(capture.cid).catch(() => { store.remove(capture.cid); }).then(() => captureReceipt(receipt));
          }
          break;
        }
        const sent = m.cid ? store.items.find((item) => item.cid === m.cid)?.msg : null;
        const idx = pendingState.findIndex((p) => p.cid === m.cid);
        if (idx >= 0) {
          if (!m.error && typeof m.rev === "number" && m.rev > fullStateRev && m.rev <= rev) {
            // Different sockets can broadcast N+1 before this socket gets its
            // ack for N. A delta does not include our write, and reapplying N on
            // top could overwrite N+1. Keep the item until a reconnect supplies
            // the full state; its cached ack is then covered by fullStateRev.
            connection.close(4000, "state resync");
            break;
          }
          const before = JSON.stringify(local);
          const [p] = pendingState.splice(idx, 1);
          // A reconnect may install a newer full snapshot before replay returns
          // a cached success for this cid. Its old ops are already accounted for
          // by that snapshot; applying them again can resurrect archived data.
          if (!m.error && typeof m.rev === "number" && m.rev > rev && matchesContext(scopes, p, "state", p.ops)) {
            confirmed = applyOps(confirmed, p.ops);
            rev = m.rev;
          }
          rebuild();
          bus.emit("state_result", { cid: p.cid, scope: p.scope, expected_generations: p.expected_generations, ...(m.error
            ? { status: "rejected", error: String(m.error?.code || m.error), message: m.message || m.error?.message }
            : { status: "accepted", rev: m.rev }) });
          if (m.error) emitState([], "rejected");
          else if (JSON.stringify(local) !== before) emitState([], "server");
          persistSoon();
        }
        if (sent?.t === "send" && sent.kind !== "instruction") {
          const result: SendResult = m.error
            ? { status: "rejected", error: String(m.error?.code || m.error),
              message: m.message || m.error?.message || "The input was rejected. Please try again." }
            : { status: "accepted", seq: m.seq };
          // Replayed inputs no longer have their original promise. Keep the input
          // context in the receipt so pages can reconcile their own durable cards.
          bus.emit("send_result", { cid: m.cid, scope: sent.scope, expected_generations: sent.expected_generations, data: sent.data, ...result });
        }
        if (m.cid) store.remove(m.cid);
        if (sent?.t === "send" && sent.kind === "instruction") {
          const mine = transcript.find(entry => entry.cid === m.cid && entry.device === device.id);
          const result: ConversationResult = m.error
            ? { cid: m.cid, status: "rejected", error: String(m.error?.code || m.error),
              message: m.message || m.error?.message || "Message rejected. Edit or retry the retained text." }
            : { cid: m.cid, status: "accepted", seq: m.seq };
          if (mine) { Object.assign(mine, result); persistSoon(); bus.emit("transcript", clone(mine)); }
          bus.emit("conversation_result", { ...result, text: sent.text });
        }
        receipts.acknowledge(m.cid, m);
        break;
      }
      case "state": {
        installScopes(m.scopes);
        const ops: Op[] = Array.isArray(m.ops) ? m.ops : [];
        confirmed = applyOps(confirmed, ops);
        if (typeof m.rev === "number") rev = m.rev;
        if (pendingState.length) rebuild();
        else for (const op of ops) local = applyOp(local, op);
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
    deviceHeaders,
    blobUrl(id: string) {
      if (!/^b_[a-z2-7]{20}$/.test(id)) throw new TypeError("Invalid blob identifier");
      return new URL(`_tendril/blobs/${id}`, new URL(cfg.base, location.href)).href;
    },
    bus,
    config: cfg,
    device,
    get connected() { return connection.connected; },
    get presence() { return presence; },
    get transcript() { return transcript; },
    get welcome() { return welcome; },
    get rev() { return rev; },
    state,
    streams: createStreams({ bus, base: cfg.base, connected: () => connection.connected, headers: deviceHeaders, request: message => core.transportRequest(message) }),
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
    async request<T = unknown>(path: string, options: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {}): Promise<T> {
      let decoded: string;
      try { decoded = decodeURIComponent(path); } catch { throw new TypeError("Invalid service path"); }
      if (!path || /[?#\\]/.test(decoded) || decoded.startsWith("/") || decoded.split("/").some(part => !part || part === "." || part === "..") || /^[a-z]+:/i.test(decoded)) throw new TypeError("Service requests require a relative path");
      const response = await fetch(cfg.base + "_tendril/" + path, {
        method: options.method || "GET", credentials: "same-origin",
        headers: { ...deviceHeaders(), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error?.message || `Service operation failed (${response.status})`), { code: result.error?.code || "service_error", status: response.status });
      return result as T;
    },
    raw,
    captures,
    pendingWork() {
      return {
        events: store.items.filter(item => item.msg.t === "send").length,
        state: savingState + new Set([...pendingState.map(item => item.cid), ...store.items.filter(item => item.msg.t === "state").map(item => item.cid)]).size,
        captures: store.items.filter(item => item.msg.t === "upload_event" || item.msg.t === "upload").length,
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
        // Rejected commands have no committed receipt. Retry the same command,
        // preserving its original identity, payload and captured generations.
        await store.updateDurable(item, { ...item.msg, failed: undefined });
      }
      sentThisConn.delete(item.cid);
      return waitForCapture(item);
    },
    async discardCapture(capture_id: string): Promise<void> {
      await storeReady;
      const item = store.items.find((entry) => entry.cid === capture_id && entry.msg.t === "upload_event");
      if (!item) return;
      await store.removeDurable(capture_id);
      captureReceipt({ capture_id, status: "rejected", error: "discarded", message: "Capture removed from this device's queue." });
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

  // Open the store, merge persisted outbox + snapshot, then connect.
  const storeReady = store.init().then((idbSnap) => {
    if (idbSnap && (!snap || (idbSnap.rev || 0) > (snap.rev || 0))) {
      confirmed = idbSnap.state && typeof idbSnap.state === "object" ? idbSnap.state : {};
      rev = fullStateRev = idbSnap.rev || 0;
      scopes = Array.isArray(idbSnap.scopes) ? idbSnap.scopes : [];
      if (!transcript.length && Array.isArray(idbSnap.transcript)) transcript = idbSnap.transcript;
    }
    for (const item of store.items) {
      if (item.msg.t !== "send" || item.msg.kind !== "instruction") continue;
      if (!transcript.some(entry => entry.cid === item.cid && entry.device === device.id)) {
        transcript.push({ ts: Math.floor(item.key / 1000), from: "user", text: item.msg.text,
          cid: item.cid, device: device.id, status: "queued" });
      }
    }
    const fromOutbox = store.items.filter((i) => i.msg.t === "state").map((i) => ({ cid: i.cid, ops: i.msg.ops as Op[], scope: i.msg.scope, expected_generations: i.msg.expected_generations }));
    const before = JSON.stringify(local);
    // The durable outbox is the only source of work that may be delivered.
    pendingState = store.persistent ? fromOutbox : [];
    rebuild();
    if (JSON.stringify(local) !== before) emitState([], "cache");
    captureQueueChanged();
  }).catch(() => {}).finally(() => {
    connection.start();
  });

  return core;
}
