// Test entry: builds a fake Core from window.__TEST_OPTS__ and mounts the control,
// synchronously, like tendril.js does from <head>.
import { mountControl } from "../../src/control/index";
import { registry } from "../../src/registry";
import type { Core, Presence } from "../../src/types";

const opts: any = (window as any).__TEST_OPTS__ || {};
const handlers = new Map<string, Set<(p: any) => void>>();
const calls = { instruction: [] as any[], request: [] as any[], state: [] as any[], utterances: [] as any[], emitted: [] as any[] };
let state: any = JSON.parse(JSON.stringify(opts.state || {}));
const stateSubs = new Set<(s: any, ops: any[], by: string) => void>();
const toPath = (p: string | string[]) => (Array.isArray(p) ? p : p.split("."));

const presence: Presence | null = opts.presence === undefined
  ? { state: "listening", text: "listening", last_seen: Date.now(), schedule_minutes: null, withheld: 0, wake: "long_poll" }
  : opts.presence;

const core: Core = {
  bus: {
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(fn); return () => handlers.get(t)!.delete(fn); },
    emit(t, p) { calls.emitted.push({ t, p }); for (const f of handlers.get(t) || []) f(p); },
  },
  config: { id: "abc", base: "/t/abc/s/key/", version: 3, ws: "/t/abc/s/key/_tendril/ws", features: { transcribe: false, voice: false, push: false, vapid: null, ...(opts.features || {}) } },
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
    delete() {}, patch() {}, mine() { return null; },
    on(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); },
  },
  async send() { return { queued: false }; },
  async instruction(text, via) { calls.instruction.push({ text, via }); },
  async request(msg) {
    calls.request.push(msg);
    const r = (opts.replies || {})[msg.t];
    return typeof r === "function" ? r(msg) : (r ?? { t: "ack" });
  },
  raw() {},
  async upload() { return { id: "b_x", url: "_tendril/blob/b_x" }; },
};

registry.voice = {
  expose: () => () => {}, start: async () => {}, stop() {}, state: "idle",
  async handleUtterance(text, via) { calls.utterances.push({ text, via }); return (opts.voiceHandles || []).includes(text); },
};
if (opts.push) {
  let sub = false;
  registry.push = { available: true, subscribed: async () => sub, subscribe: async () => (sub = true), unsubscribe: async () => { sub = false; } };
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
