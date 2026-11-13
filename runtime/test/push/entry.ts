// Test entry: bundles the push agent's runtime modules with a fake Core.
import { startRules, haversine } from "../../src/rules";
import { setupPush } from "../../src/push";

function makeCore(features: any = { transcribe: false, voice: false, push: false, vapid: null }) {
  const handlers = new Map<string, Set<(p: any) => void>>();
  const state: any = {};
  const log = { raw: [] as any[], sent: [] as any[], bus: [] as any[], requests: [] as any[] };
  const getPath = (p: any) => (typeof p === "string" ? p.split(".") : p ?? []);
  const core: any = {
    bus: {
      on(t: string, fn: any) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(fn); return () => handlers.get(t)!.delete(fn); },
      emit(t: string, p?: any) { log.bus.push({ t, p }); handlers.get(t)?.forEach((fn) => fn(p)); },
    },
    config: { id: "tid1", base: "/t/tid1/", version: 1, ws: "/t/tid1/_tendril/ws", features },
    device: { id: "dev1", role: "owner", name: "test", pending: false },
    connected: true, presence: null, transcript: [],
    state: {
      get(p?: any) { let o = state; for (const k of getPath(p)) o = o?.[k]; return o; },
      set(p: any, v: any) { const ks = getPath(p); let o = state; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks[ks.length - 1]] = v; },
      delete() {}, patch() {}, mine() { return {}; }, on() { return () => {}; },
    },
    async send(data: any) { log.sent.push(data); return { seq: log.sent.length, queued: false }; },
    async instruction() {},
    async request(m: any) { log.requests.push(m); return { cid: "x" }; },
    raw(m: any) { log.raw.push(m); },
    async upload() { return { id: "", url: "" }; },
  };
  return { core, log, state };
}

(window as any).T = { makeCore, startRules, setupPush, haversine };
