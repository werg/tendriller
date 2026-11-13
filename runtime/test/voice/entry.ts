// Test entry: bundles the voice layer with a fake Core and a mock realtime provider.
// Bundled by voice.spec.ts with esbuild and loaded into a Playwright page.
import { createVoice, registerProvider, matchPhrase } from "../../src/voice/index";
import type { Core } from "../../src/types";
import type { ProviderHooks, RealtimeSession, ToolDef } from "../../src/voice/providers/types";

type Script = (text: string) => { tool?: string; args?: any; reply?: string } | null;

const log = {
  raw: [] as any[],
  bus: [] as { type: string; payload: any }[],
  instructions: [] as { text: string; via: string }[],
  calls: [] as { name: string; args: any }[],
  connects: [] as { mic: boolean; tools: ToolDef[]; session: any }[],
  sent: [] as { text: string; modality?: string }[],
  updates: [] as ToolDef[][],
};

const listeners = new Map<string, Set<(p: any) => void>>();
const state: any = { _prefs: { audio: false } };
const core = {
  bus: {
    on(type: string, fn: (p: any) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); return () => listeners.get(type)!.delete(fn); },
    emit(type: string, payload?: any) { log.bus.push({ type, payload }); listeners.get(type)?.forEach((f) => f(payload)); },
  },
  config: { id: "abc", base: "/t/abc/s/key/", version: 1, ws: "/t/abc/s/key/_tendril/ws", features: { transcribe: false, voice: false, push: false, vapid: null } },
  device: { id: "d_x", role: "owner", name: "test", pending: false },
  connected: true,
  presence: null,
  transcript: [],
  state: {
    get: (p?: any) => (p === undefined ? state : state[Array.isArray(p) ? p[0] : String(p).split(".")[0]]),
    set() {}, delete() {}, patch() {}, mine() { return {}; }, on() { return () => {}; },
  },
  send: async () => ({ queued: false }),
  instruction: async (text: string, via: string) => { log.instructions.push({ text, via }); },
  request: async () => ({}),
  raw: (m: object) => { log.raw.push(m); },
  upload: async () => ({ id: "b_x", url: "" }),
} as unknown as Core;

let script: Script = () => null;
let liveHooks: ProviderHooks | null = null;

registerProvider({
  name: "mock",
  async connect(opts) {
    log.connects.push({ mic: opts.mic, tools: opts.tools, session: opts.session });
    const hooks = opts.hooks;
    if (opts.mic) liveHooks = hooks;
    let open = true;
    const s: RealtimeSession = {
      mic: opts.mic,
      sendText(text, o) {
        log.sent.push({ text, modality: o?.modality });
        setTimeout(async () => {
          const r = script(text);
          if (r?.tool) await hooks.onToolCall({ name: r.tool, callId: "call_1", args: r.args ?? {} });
          if (r?.reply) hooks.onReply(r.reply);
          hooks.onTurnDone({ toolCalls: r?.tool ? 1 : 0 });
        }, 5);
      },
      updateTools(tools) { log.updates.push(tools); },
      setAudioOut() {},
      close() { if (open) { open = false; hooks.onClose("closed_by_client"); } },
    };
    return s;
  },
});

const voice = createVoice(core);

(window as any).T = {
  voice, core, log, matchPhrase,
  setScript(src: string) { script = new Function("text", src) as Script; },
  setVoiceFeature(on: boolean) { (core.config.features as any).voice = on; },
  // Simulate a live-audio turn: model calls a tool, then the user transcript arrives.
  async liveToolCall(tool: string, args: any, transcript: string) {
    const out = await liveHooks!.onToolCall({ name: tool, callId: "call_live", args });
    liveHooks!.onUserTranscript(transcript);
    liveHooks!.onTurnDone({ toolCalls: 1 });
    return out;
  },
  calls: log.calls,
};
