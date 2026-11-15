// Runtime core (PROTOCOL 7, 11.1): socket, bus, state, offline queue, eval, logs, health.
import type { Bus, Core, Device, Presence, Role, StateApi, TendrilConfig, TranscriptEntry, Path } from "./types";
import { OfflineStore, type OutboxItem } from "./offline";
import { serialize, errorString } from "./serialize";
import { loadDevice, saveDevice, guessName, probeCaps, rand32 } from "./device";
import { installLogForwarding, createHealth, type LogEntry } from "./diagnostics";
import { applyOp, applyOps, clone, getPath, mergePatchToOps, toPath, type Op } from "./state";
import { createSpeechOutput } from "./speech-output";
import { captureData, type BlobReference, type CaptureOptions, type CaptureResult, type PendingCapture, type SendResult } from "./capture";

export type { Bus, Core } from "./types";

/** Messages kept in the persistent outbox while offline and replayed in order. */
const QUEUED = new Set(["send", "state", "log", "upload", "rule_fired"]);
/** Outbox messages that stay queued until the server acks their cid (others leave once written). */
const ACKED = new Set(["send", "state"]);
/** Never queued: pointless after a reconnect. */
const DROP_OFFLINE = new Set(["eval_result", "ping"]);

const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const WELCOME_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SEND_WAIT_OFFLINE_MS = 3_000;
const TRANSCRIPT_MAX = 200;
const AXE_URL = "https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js";

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

class HttpError extends Error { constructor(public status: number, msg: string, public code = "upload_failed") { super(msg); } }

type Internal = Core & {
  readonly rev: number; health: ReturnType<typeof createHealth>;
  uploadEvent(blob: Blob, opts: CaptureOptions): Promise<CaptureResult>;
  captures(): PendingCapture[];
  retryCapture(id: string): Promise<CaptureResult>;
  discardCapture(id: string): Promise<void>;
  setBlobRetention(id: string, opts: { keep: boolean }): Promise<BlobReference>;
};

export function createCore(cfg: TendrilConfig): Internal {
  cfg.features = cfg.features || { push: false, vapid: null, shared_by: "Tendriller user",
    speech: { model: "cactus-whistle-v4", url: "_tendril/speech/whistle.cact",
      sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb" } };
  const bus = createBus();
  const stored = loadDevice(cfg.id);
  if (!stored.name) { stored.name = guessName(); saveDevice(cfg.id, stored); }
  const device: Device = { id: stored.id, role: (stored.role as Role) || "owner", name: stored.name, pending: false };
  const store = new OfflineStore(cfg.id);

  // ---------- state ----------
  let confirmed: any = {};
  let local: any = {};
  let rev = 0;
  let pendingState: { cid: string; ops: Op[] }[] = [];
  let transcript: TranscriptEntry[] = [];

  const snap = store.loadSnapshotSync();
  if (snap) {
    confirmed = snap.state && typeof snap.state === "object" ? snap.state : {};
    rev = snap.rev || 0;
    pendingState = Array.isArray(snap.pending) ? snap.pending : [];
    transcript = Array.isArray(snap.transcript) ? snap.transcript : [];
  }
  const rebuild = () => {
    local = clone(confirmed);
    for (const p of pendingState) local = applyOps(local, p.ops);
  };
  rebuild();

  let snapTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const snapshot = (): any => ({ rev, state: confirmed, pending: pendingState, transcript: transcript.slice(-50) });
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

  const localOps = (ops: Op[]) => {
    if (!ops.length) return;
    const cid = newCid();
    pendingState.push({ cid, ops });
    local = applyOps(local, ops);
    enqueue({ t: "state", cid, ops });
    persistSoon();
    emitState(ops, "device:" + device.id);
  };

  const state: StateApi = {
    get(path?: Path) { return clone(getPath(local, toPath(path))); },
    set(path: Path, value: any) {
      const p = toPath(path);
      if (!p.length) throw new Error("tendril.state.set needs a path");
      localOps([value === undefined ? { op: "delete", path: p } : { op: "set", path: p, value: clone(value) }]);
    },
    delete(path: Path) {
      const p = toPath(path);
      if (!p.length) throw new Error("tendril.state.delete needs a path");
      localOps([{ op: "delete", path: p }]);
    },
    patch(mergePatch: object) {
      if (!mergePatch || typeof mergePatch !== "object" || Array.isArray(mergePatch)) throw new Error("tendril.state.patch needs an object");
      localOps(mergePatchToOps(local, clone(mergePatch)));
    },
    mine() { return clone(getPath(local, ["_device", device.id])); },
    on(fn) { stateListeners.add(fn); return () => { stateListeners.delete(fn); }; },
  };

  const resetState = (s: any, r: number, by: string) => {
    confirmed = s && typeof s === "object" && !Array.isArray(s) ? s : {};
    rev = r || 0;
    rebuild();
    persistSoon();
    emitState([], by);
  };

  // ---------- connection ----------
  let ws: WebSocket | null = null;
  let ready = false; // welcomed
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let pingTimer: ReturnType<typeof setInterval> | 0 = 0;
  let pongTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let welcomeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let initDone = false;
  const sentThisConn = new Set<string>();
  const memQueue: any[] = []; // non-persistent messages waiting for the socket
  const ackWaiters = new Map<string, (ack: any | null) => void>();
  const requests = new Map<string, { res: (v: any) => void; rej: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  const uploadWaiters = new Map<string, { res: (v: any) => void; rej: (e: any) => void }>();
  const captureWaiters = new Map<string, Set<(result: CaptureResult) => void>>();
  const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const captureRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let welcome: any = null;
  let presence: Presence | null = null;
  let rules: any[] = [];

  const wsUrl = () => {
    if (/^wss?:/.test(cfg.ws)) return cfg.ws;
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + cfg.ws;
  };

  const rawSend = (msg: any): boolean => {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
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

  const connect = () => {
    if (ws || !initDone) return;
    let sock: WebSocket;
    try { sock = new WebSocket(wsUrl()); } catch { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      rawSend(hello());
      welcomeTimer = setTimeout(() => { if (ws === sock && !ready) sock.close(); }, WELCOME_TIMEOUT_MS);
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = 0; }
      let m: any;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (m && typeof m.t === "string") {
        try { handle(m); } catch (e) { console.warn("[tendril] failed to handle", m.t, e); }
      }
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      const was = ready;
      ready = false;
      sentThisConn.clear();
      if (welcomeTimer) { clearTimeout(welcomeTimer); welcomeTimer = 0; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = 0; }
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = 0; }
      for (const [cid, w] of ackWaiters) { ackWaiters.delete(cid); w(null); }
      if (was) bus.emit("disconnect");
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (retryTimer) return;
    const base = Math.min(30_000, 500 * 2 ** Math.min(attempts, 10));
    attempts++;
    const delay = base / 2 + Math.random() * (base / 2);
    retryTimer = setTimeout(() => { retryTimer = 0; connect(); }, delay);
  };

  const reconnectNow = () => {
    if (ws) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
    attempts = 0;
    connect();
  };
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reconnectNow(); });

  // ---------- outbox ----------
  const captures = (): PendingCapture[] => store.items.filter((item) => item.msg.t === "upload_event").map((item) => ({
    capture_id: item.cid, name: item.msg.name, data: clone(item.msg.data),
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
    captureReceipt({ capture_id: item.cid, status: "rejected", queued: false, error, message });
  };
  const waitForCapture = (item: OutboxItem): Promise<CaptureResult> => {
    const promise = new Promise<CaptureResult>((resolve) => {
      const existing = captureWaiters.get(item.cid);
      if (existing) { existing.add(resolve); return; }
      captureWaiters.set(item.cid, new Set([resolve]));
      captureTimers.set(item.cid, setTimeout(() => {
        captureReceipt({ capture_id: item.cid, status: "queued", queued: true });
      }, ready ? 8000 : 0));
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

  let pumping = false;
  const pump = async () => {
    if (pumping || !ready) return;
    pumping = true;
    try {
      for (;;) {
        if (!ready || !ws) break;
        const item = store.items.find((i) => !i.msg.failed && !sentThisConn.has(i.cid));
        if (!item) break;
        sentThisConn.add(item.cid);
        if (item.msg.t === "upload_event") {
          try {
            if (!item.msg.uploaded) {
              const uploaded = await httpUpload(item.blob!, item.msg.name, item.cid, item.msg.keep);
              if (!store.has(item.cid)) continue;
              // Persist the upload receipt before sending the semantic event. A reload at any
              // point resumes this transaction with the same media and event identifiers.
              await store.updateDurable(item, { ...item.msg, uploaded });
            }
            if (!store.has(item.cid)) continue; // discarded while uploading
            const msg = item.msg;
            if (!ready || !rawSend({ t: "send", cid: msg.event_cid,
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
            if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
              await captureFailed(item, error.code, error.message);
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
            const r = await httpUpload(item.blob!, item.msg.name, item.cid, item.msg.keep);
            store.remove(item.cid);
            // After a reload the original promise is gone; pages learn the result from the event.
            bus.emit("upload", { cid: item.cid, name: item.msg.name ?? null, ...r });
            uploadWaiters.get(item.cid)?.res(r);
            uploadWaiters.delete(item.cid);
          } catch (e) {
            if (e instanceof HttpError) {
              store.remove(item.cid);
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
        if (!ACKED.has(item.msg.t)) store.remove(item.cid);
      }
    } finally {
      pumping = false;
    }
  };

  /** Queue an acked message; resolves with the ack, or null if it stays queued. */
  const sendAcked = (msg: any): Promise<any | null> => {
    const p = new Promise<any | null>((res) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (a: any | null) => { if (done) return; done = true; clearTimeout(timer); ackWaiters.delete(msg.cid); res(a); };
      ackWaiters.set(msg.cid, finish);
      // A socket can stay open while its acknowledgement is lost. Keep the message
      // in offline storage, but never leave the person's UI waiting indefinitely.
      timer = setTimeout(() => finish(null), ready ? 8000 : SEND_WAIT_OFFLINE_MS);
    });
    enqueue(msg);
    return p;
  };

  /** Proves this device to page HTTP routes (PROTOCOL 2.1). */
  const deviceHeaders = (): Record<string, string> => ({ "X-Tendril-Device": stored.id, "X-Tendril-Device-Secret": stored.secret });

  // ---------- http upload ----------
  const httpUpload = async (blob: Blob, name?: string, cid?: string, keep?: boolean): Promise<BlobReference> => {
    const headers: Record<string, string> = { "Content-Type": blob.type || "application/octet-stream", ...deviceHeaders() };
    if (cid) headers["X-Tendril-Cid"] = cid; // a replay after a lost response is stored once
    if (name) headers["X-Tendril-Name"] = name;
    if (keep === true) headers["X-Tendril-Keep"] = "true";
    const r = await fetch(cfg.base + "_tendril/blob", { method: "POST", body: blob, headers });
    if (!r.ok) {
      let msg = `upload failed (${r.status})`, code = "upload_failed";
      try { const j = await r.json(); if (j?.error?.message) msg = j.error.message; if (j?.error?.code) code = j.error.code; } catch { /* ignore */ }
      throw new HttpError(r.status, msg, code);
    }
    return r.json();
  };

  // ---------- incoming ----------
  const addTranscript = (e: TranscriptEntry) => {
    transcript.push(e);
    if (transcript.length > TRANSCRIPT_MAX) transcript.splice(0, transcript.length - TRANSCRIPT_MAX);
    persistSoon();
    bus.emit("transcript", e);
  };

  const tts = createSpeechOutput(cfg.base, bus, () => local?._prefs || {});
  let speechPrefs = JSON.stringify([local?._prefs?.audio, local?._prefs?.language]);
  state.on(() => {
    const next = JSON.stringify([local?._prefs?.audio, local?._prefs?.language]);
    if (next !== speechPrefs) { tts.stop(); speechPrefs = next; }
  });
  bus.on("role", () => { if (device.role !== "owner" || device.pending) tts.stop(); });
  const speak = (text: string) => tts.speak(text);

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
      void store.flush(1000).then(() => location.reload());
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
        s.src = AXE_URL;
        s.async = true;
        s.onload = () => (w.axe ? res(w.axe) : rej(new Error("axe-core did not load")));
        s.onerror = () => { axeLoading = null; s.remove(); rej(new Error("could not load axe-core from " + AXE_URL)); };
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

  const handle = (m: any) => {
    // Rejections correlated to queued input are terminal acknowledgements too. Keeping
    // them queued would turn an explicit rejection into a misleading "saved" result.
    if (m.t === "error" && m.cid && store.items.some((item) => item.cid === m.cid || item.msg.event_cid === m.cid)) {
      bus.emit("error", m);
      m = { ...m, t: "ack", error: m.code || "rejected" };
    }
    // Replies correlated by cid.
    if (m.cid && requests.has(m.cid)) {
      const r = requests.get(m.cid)!;
      requests.delete(m.cid);
      clearTimeout(r.timer);
      if (m.t === "error" || (m.t === "ack" && m.error)) {
        const err: any = new Error(m.message || (m.error && (m.error.message || m.error)) || m.code || "error");
        err.code = m.code || (m.error && m.error.code) || m.error;
        r.rej(err);
      } else r.res(m);
      if (m.t !== "ack") return;
    }
    switch (m.t) {
      case "welcome": {
        if (welcomeTimer) { clearTimeout(welcomeTimer); welcomeTimer = 0; }
        welcome = m;
        attempts = 0;
        setRole(m.role || device.role, !!m.pending, m.pair_code);
        if (m.device_purpose !== undefined) (device as any).purpose = m.device_purpose;
        presence = m.presence ?? presence;
        if (Array.isArray(m.transcript)) {
          transcript = m.transcript.slice(-TRANSCRIPT_MAX);
          persistSoon();
        }
        rules = Array.isArray(m.rules) ? m.rules : rules;
        if (m.features) Object.assign(cfg.features, m.features);
        if (m.state && typeof m.state === "object") resetState(m.state, m.rev, "server");
        else if (typeof m.rev === "number" && m.rev > rev) rev = m.rev;
        ready = true;
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (!ready) return;
          rawSend({ t: "ping" });
          if (!pongTimer) pongTimer = setTimeout(() => { pongTimer = 0; ws?.close(); }, PONG_TIMEOUT_MS);
        }, PING_MS);
        bus.emit("welcome", m);
        bus.emit("role", { role: device.role, pending: device.pending });
        if (presence) bus.emit("presence", presence);
        bus.emit("rules", rules);
        bus.emit("transcript", null);
        bus.emit("connect");
        while (memQueue.length && ready) rawSend(memQueue.shift());
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
            const receipt: CaptureResult = { capture_id: capture.cid, status: "accepted", queued: false, seq: m.seq, blob: capture.msg.uploaded };
            void store.removeDurable(capture.cid).catch(() => { store.remove(capture.cid); }).then(() => captureReceipt(receipt));
          }
          break;
        }
        const sent = m.cid ? store.items.find((item) => item.cid === m.cid)?.msg : null;
        const idx = pendingState.findIndex((p) => p.cid === m.cid);
        if (idx >= 0) {
          const [p] = pendingState.splice(idx, 1);
          if (!m.error) {
            confirmed = applyOps(confirmed, p.ops);
            if (typeof m.rev === "number") rev = m.rev;
          } else {
            rebuild();
            emitState([], "rejected");
          }
          persistSoon();
        }
        if (sent?.t === "send" && sent.kind !== "instruction") {
          const result: SendResult = m.error
            ? { status: "rejected", queued: false, error: String(m.error?.code || m.error),
              message: m.message || m.error?.message || "The input was rejected. Please try again." }
            : { status: "accepted", queued: false, seq: m.seq };
          // Replayed inputs no longer have their original promise. Keep the input
          // context in the receipt so pages can reconcile their own durable cards.
          bus.emit("send_result", { cid: m.cid, data: sent.data, ...result });
        }
        if (m.cid) store.remove(m.cid);
        if (sent?.t === "send" && sent.kind === "instruction") {
          const mine = transcript.find((e: any) => e._cid === m.cid) ||
            transcript.find((e: any) => e._local && e.from === "user" && e.text === sent.text);
          if (m.error) {
            if (mine) { transcript.splice(transcript.indexOf(mine), 1); persistSoon(); }
            // A queued instruction can fail after its caller has returned. Keep that
            // rejection observable and never restore it as a sending transcript row.
            bus.emit("instruction_rejected", { cid: m.cid, text: sent.text,
              error: String(m.error?.code || m.error),
              message: m.message || m.error?.message || "Message rejected. Your text is kept for retry." });
          } else {
            // Keep the local cid until the server echo arrives. Its ack can arrive
            // first; the echo must reconcile this row rather than append a duplicate.
            if (mine) { delete (mine as any)._local; persistSoon(); }
            bus.emit("instruction_ack", { cid: m.cid, text: sent.text, seq: m.seq });
          }
        }
        ackWaiters.get(m.cid)?.(m);
        break;
      }
      case "state": {
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
        resetState(m.state, m.rev, "server");
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
        if (m.present !== false) {
          addTranscript({ ts: m.ts || Date.now(), from: "agent", text: String(m.text ?? "") });
          bus.emit("say", m);
        }
        if (device.role === "owner" && !device.pending && m.speak !== false) speak(m.text);
        break;
      }
      case "instruction_echo": {
        const mine = m.device === device.id &&
          transcript.find((e: any) => (e._local || e._cid) && e.from === "user" && e.text === m.text);
        if (mine) { delete (mine as any)._local; delete (mine as any)._cid; mine.ts = m.ts || mine.ts; persistSoon(); }
        else addTranscript({ ts: m.ts || Date.now(), from: "user", text: String(m.text ?? "") });
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
      case "rules":
        rules = Array.isArray(m.rules) ? m.rules : [];
        bus.emit("rules", rules);
        break;
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
    if (ready && rawSend(msg)) return;
    store.add({ ...msg, cid: newCid() });
  });
  const health = createHealth((ok, errors) => {
    raw({ t: "health", version: cfg.version, ok, errors });
  }, 2000);

  // ---------- public ----------
  function raw(msg: any) {
    if (!msg || typeof msg.t !== "string") return;
    if (QUEUED.has(msg.t)) {
      if (!msg.cid) msg.cid = newCid();
      enqueue(msg);
      return;
    }
    if (ready && rawSend(msg)) return;
    if (!DROP_OFFLINE.has(msg.t)) memQueue.push(msg);
  }

  const core: Internal = {
    deviceHeaders,
    bus,
    config: cfg,
    device,
    get connected() { return ready; },
    get presence() { return presence; },
    get transcript() { return transcript; },
    get welcome() { return welcome; },
    get rules() { return rules; },
    get rev() { return rev; },
    state,
    health,
    async send(data: any, opts?: { wake?: boolean }): Promise<SendResult> {
      // Browser user activation marks a real tap or key press; page code cannot fake it. The server
      // treats such events from owner devices as human input for the page-wake cap (PROTOCOL 8.2).
      const gesture = !!(navigator as any).userActivation?.isActive;
      const msg = { t: "send", cid: newCid(), data: data === undefined ? null : serialize(data), wake: opts?.wake !== false, gesture };
      const ack = await sendAcked(msg);
      if (!ack) return { status: "queued", queued: true };
      if (ack.error) return { status: "rejected", queued: false,
        error: String(ack.error?.code || ack.error), message: ack.message || ack.error?.message || "The input was rejected. Please try again." };
      return { status: "accepted", seq: ack.seq, queued: false };
    },
    async instruction(text: string, via: "voice" | "text") {
      tts.stop();
      const cid = newCid();
      const entry: any = { ts: Date.now(), from: "user", text, _local: true, _cid: cid };
      addTranscript(entry);
      const ack = await sendAcked({ t: "send", cid, kind: "instruction", text, via, data: { text, via }, wake: true });
      if (ack?.error) {
        const error = new Error(ack.message || ack.error?.message || "Message rejected. Your text is kept for retry.");
        (error as any).code = ack.error?.code || ack.error;
        throw error;
      }
      return { queued: !ack, cid };
    },
    request(msg) {
      const m: any = { ...msg, cid: msg.cid || newCid() };
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          requests.delete(m.cid);
          const i = memQueue.indexOf(m);
          if (i >= 0) memQueue.splice(i, 1);
          const e: any = new Error(ready ? "request timed out" : "offline");
          e.code = ready ? "timeout" : "offline";
          rej(e);
        }, REQUEST_TIMEOUT_MS);
        requests.set(m.cid, { res, rej, timer });
        if (QUEUED.has(m.t)) enqueue(m);
        else if (!(ready && rawSend(m))) memQueue.push(m);
      });
    },
    raw,
    captures,
    async uploadEvent(blob: Blob, opts: CaptureOptions): Promise<CaptureResult> {
      if (!(blob instanceof Blob)) throw new TypeError("tendril.uploadEvent needs a Blob");
      if (!opts?.data || typeof opts.data !== "object" || Array.isArray(opts.data)) throw new TypeError("uploadEvent needs a data object");
      const capture_id = newCid();
      const gesture = !!(navigator as any).userActivation?.isActive;
      const data = serialize(opts.data) as Record<string, unknown>;
      captureData(data, opts.dataPath, { id: "pending", url: "pending" }); // validate before saving
      await storeReady;
      try {
        const item = await store.addDurable({ t: "upload_event", cid: capture_id, event_cid: newCid(),
          name: opts.name, data, dataPath: opts.dataPath, keep: opts.keep === true, wake: opts.wake !== false, gesture }, blob);
        return waitForCapture(item);
      } catch (error) {
        const result: CaptureResult = { capture_id, status: "rejected", queued: false, error: "storage_unavailable",
          message: error instanceof Error ? error.message : "Could not save this capture. Keep it open and try again." };
        captureReceipt(result);
        return result;
      }
    },
    async retryCapture(capture_id: string): Promise<CaptureResult> {
      await storeReady;
      const item = store.items.find((entry) => entry.cid === capture_id && entry.msg.t === "upload_event");
      if (!item) return { capture_id, status: "rejected", queued: false, error: "not_found", message: "This capture is no longer in the queue." };
      if (item.msg.failed) {
        // A server caches rejected event acknowledgements too; a deliberate retry is a new
        // event attempt while the upload id and the user-visible capture identity stay stable.
        await store.updateDurable(item, { ...item.msg, event_cid: newCid(), failed: undefined });
      }
      sentThisConn.delete(item.cid);
      return waitForCapture(item);
    },
    async discardCapture(capture_id: string): Promise<void> {
      await storeReady;
      const item = store.items.find((entry) => entry.cid === capture_id && entry.msg.t === "upload_event");
      if (!item) return;
      await store.removeDurable(capture_id);
      captureReceipt({ capture_id, status: "rejected", queued: false, error: "discarded", message: "Capture removed from this device's queue." });
    },
    async setBlobRetention(id: string, opts: { keep: boolean }): Promise<BlobReference> {
      if (!/^b_[a-z2-7]{20}$/.test(id) || typeof opts?.keep !== "boolean") throw new TypeError("setBlobRetention needs a blob id and {keep:boolean}");
      const response = await fetch(cfg.base + `_tendril/blob/${id}/retention`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...deviceHeaders() }, body: JSON.stringify(opts),
      });
      const result = await response.json();
      if (!response.ok) throw new HttpError(response.status, result.error?.message || "Could not change capture retention", result.error?.code);
      return result;
    },
    async upload(blob: Blob, opts?: { name?: string; keep?: boolean }) {
      if (!(blob instanceof Blob)) throw new TypeError("tendril.upload needs a Blob");
      const name = opts?.name;
      if (navigator.onLine !== false) {
        try { return await httpUpload(blob, name, undefined, opts?.keep); } catch (e) { if (e instanceof HttpError) throw e; }
      }
      const cid = newCid();
      return new Promise((res, rej) => {
        uploadWaiters.set(cid, { res, rej });
        enqueue({ t: "upload", cid, name, keep: opts?.keep }, blob);
      });
    },
    speak,
    tts,
    ready: () => health.ready(),
    readyManual: () => health.manual(),
  };

  // Open the store, merge persisted outbox + snapshot, then connect.
  const storeReady = store.init().then((idbSnap) => {
    if (idbSnap && (!snap || (idbSnap.rev || 0) > (snap.rev || 0))) {
      confirmed = idbSnap.state && typeof idbSnap.state === "object" ? idbSnap.state : {};
      rev = idbSnap.rev || 0;
      if (!transcript.length && Array.isArray(idbSnap.transcript)) transcript = idbSnap.transcript;
    }
    const fromOutbox = store.items.filter((i) => i.msg.t === "state").map((i) => ({ cid: i.cid, ops: i.msg.ops as Op[] }));
    const before = JSON.stringify(local);
    // Outbox is authoritative for pending ops when IndexedDB works; otherwise keep the snapshot's
    // pending ops and re-queue them so they are not lost.
    if (store.persistent) pendingState = fromOutbox;
    else for (const p of pendingState) if (!store.has(p.cid)) store.add({ t: "state", cid: p.cid, ops: p.ops });
    rebuild();
    if (JSON.stringify(local) !== before) emitState([], "cache");
    captureQueueChanged();
  }).catch(() => {}).finally(() => {
    initDone = true;
    connect();
  });

  return core;
}
