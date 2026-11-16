// Test entry: builds a fake Core from window.__TEST_OPTS__ and mounts the control,
// synchronously, like tendril.js does from <head>.
import { mountControl } from "../../src/control/index";
import { createPreferences } from "../../src/preferences";
import { registry } from "../../src/registry";
import type { Core, Presence } from "../../src/types";

const opts: any = (window as any).__TEST_OPTS__ || {};
const handlers = new Map<string, Set<(p: any) => void>>();
const calls = { instruction: [] as any[], request: [] as any[], state: [] as any[], preferences: [] as any[], utterances: [] as any[], emitted: [] as any[] };
let state: any = JSON.parse(JSON.stringify(opts.state || {}));
const stateSubs = new Set<(s: any, ops: any[], by: string) => void>();
const toPath = (p: string | string[]) => (Array.isArray(p) ? p : p.split("."));

const presence: Presence | null = opts.presence === undefined
  ? { state: "listening", text: "listening", last_seen: Date.now(), schedule_minutes: null, withheld: 0, wake: "long_poll" }
  : opts.presence;

const preferences = createPreferences("abc");
preferences.update(opts.preferences || {});
const updatePreferences = preferences.update;
preferences.update = patch => { calls.preferences.push(patch); updatePreferences(patch); };

const core: Core = {
  preferences,
  tts: {
    status: { enabled: false, state: "idle", message: "Browser voice is ready." },
    async enable() { this.status = { enabled: true, state: "ready", message: "Neural voice is ready." }; core.bus.emit("tts", this.status); },
    disable() { this.status = { enabled: false, state: "idle", message: "Using the browser voice." }; core.bus.emit("tts", this.status); },
    stop() { calls.emitted.push({t:"tts:stop",p:null}); },
    speak() {},
  },
  speak(text: string) { calls.utterances.push({text, via:"tts"}); },
  bus: {
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(fn); return () => handlers.get(t)!.delete(fn); },
    emit(t, p) { calls.emitted.push({ t, p }); for (const f of handlers.get(t) || []) f(p); },
  },
  config: { preview: !!opts.preview, id: "abc", base: "/t/abc/s/key/", version: 3, ws: "/t/abc/s/key/_tendril/ws", features: { push: false, vapid: null, shared_by: "Fixture", speech: {model:"fixture",url:"model",sha256:"0".repeat(64),engine:{script:"engine",wasm:"engine.wasm",wasm_sha256:"0".repeat(64)}}, ...(opts.features || {}) } },
  device: { id: "d_me", role: opts.role || "owner", name: "Test", pending: !!opts.pending, pairCode: opts.pairCode },
  connected: opts.connected !== false,
  presence,
  transcript: opts.transcript || [],
  state: {
    get(p?: any) { if (p === undefined) return state; let v = state; for (const k of toPath(p)) v = v?.[k]; return v; },
    set(p, value) {
      const path = toPath(p); calls.state.push({ path, value });
      let o = state; for (const k of path.slice(0, -1)) o = o[k] ??= {};
      o[path[path.length - 1]] = value;
      for (const f of stateSubs) f(state, [{ op: "set", path, value }], "device:d_me");
    },
    delete() {}, patch() {},
    on(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); },
  },
  pendingWork() { return { events: 0, state: 0, captures: 0 }; },
  deviceHeaders() { return {}; },
  async send() { return { status: "accepted", seq: 1 }; },
  async instruction(text, via) { calls.instruction.push({ text, via }); if (opts.instructionError) throw new Error(opts.instructionError); return { status: opts.instructionQueued === true ? "queued" : "accepted", cid: `instruction-${calls.instruction.length}` }; },
  async transportRequest(msg) {
    calls.request.push(msg);
    const r = (opts.replies || {})[msg.t];
    return typeof r === "function" ? r(msg) : (r ?? { t: "ack" });
  },
  raw() {},
  async upload() { return { id: "b_x", url: "_tendril/blobs/b_x" }; },
};

if (opts.push) {
  let sub = false;
  registry.push = {
    available: true,
    subscribed: async () => sub,
    status: async () => {
      if (opts.pushStatusFailsAfterSubscribe && sub) throw new Error("temporary status failure");
      return { permission: "granted", subscribed: sub, registered: sub };
    },
    subscribe: async () => (sub = true),
    unsubscribe: async () => { sub = false; },
    test: async () => { calls.request.push({ t: "push_test" }); return { sent: 1, failed: 0, status: 201 }; },
  };
}

const api = mountControl(core);

(window as any).__fake = {
  core, calls, api,
  emit: (t: string, p: any) => core.bus.emit(t, p),
  setPresence(p: Partial<Presence>) {
    core.presence = { ...(core.presence || { state: "listening", text: "", last_seen: null, schedule_minutes: null, withheld: 0, wake: "none" }), ...p } as Presence;
    core.bus.emit("presence", core.presence);
  },
  setConnected(v: boolean) { core.connected = v; core.bus.emit(v ? "connect" : "disconnect"); },
  setRole(role: string, pending = false) { core.device.role = role as any; core.device.pending = pending; core.bus.emit("role", { role, pending }); },
};
