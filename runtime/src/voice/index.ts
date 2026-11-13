// Fast voice layer, page side (PROTOCOL section 9, PLAN section 13 feature 1).
//
// handleUtterance(text): (1) built-in phrases and the local phrase matcher over exposed
// functions; (2) if the server offers a realtime provider (features.voice), the model,
// with the exposed functions plus `ask_agent` as tools; (3) otherwise returns false and
// the caller (the control) sends the text as an instruction.
//
// Bus events emitted (for the control to show; all optional to consume):
//   voice:state   {state}                    "idle" | "listening" | "thinking" | "unavailable"
//   voice:heard   {text}                     what the user said (continuous listening only)
//   voice:reply   {text, spoken}             short reply from the layer (fn result or model)
//   voice:handled {text, function, args}     the layer handled it itself
//   voice:passed  {text}                     handed to the agent (show "Passed to the agent")
//   voice:exposed {names}                    exposed functions changed
//   control:go_back                          built-in "go back" / "undo"
import type { Core, Voice } from "../types";
import { matchPhrase, type PhraseEntry } from "./matcher";
import { getProvider, type RealtimeSession, type ToolDef, type ToolCall } from "./providers";

export { registerProvider } from "./providers";
export { matchPhrase, normalize } from "./matcher";

type VoiceState = "idle" | "listening" | "thinking" | "unavailable";
type ExposeOpts = { description?: string; phrases?: string[]; params?: object };

interface Exposed { name: string; toolName: string; opts: ExposeOpts; fn: (args: any) => any }
interface Builtin { name: string; description: string; phrases: string[] }

const BUILTINS: Builtin[] = [
  { name: "go_back", description: "Undo: restore the previous version of the page.", phrases: ["go back", "undo", "undo that", "show me the one from before", "previous version"] },
  { name: "stop_listening", description: "Stop the continuous voice conversation (turn the microphone off).", phrases: ["stop listening", "stop voice", "microphone off"] },
];
const ASK_AGENT: ToolDef = {
  name: "ask_agent",
  description: "Hand the user's request to the agent that owns this page. Use for anything no other function covers: questions, changes, new content, research. The agent replies later.",
  parameters: { type: "object", properties: { request: { type: "string", description: "The user's request, in their own words." } }, required: ["request"] },
};
const UTTERANCE_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 8000;
const IDLE_CLOSE_MS = 120000;
const RETRY_AFTER_MS = 60000;

const randomCid = () => "v_" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function toolNameFor(name: string, taken: Set<string>): string {
  const base = (name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "fn").slice(0, 60);
  let n = base, i = 2;
  while (taken.has(n)) n = `${base}_${i++}`;
  return n;
}

export function createVoice(core: Core): Voice {
  const exposed = new Map<string, Exposed>();
  let current: VoiceState = "idle";
  let live = false;                       // start() was called and not stopped
  let session: RealtimeSession | null = null;
  let connecting: Promise<RealtimeSession | null> | null = null;
  let failedUntil = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let recognition: any = null;
  let pending: { text: string; resolve: (v: boolean) => void; done: boolean } | null = null;
  let lastTranscript = "";
  let deferred: { text: string; function: string; args: any }[] = []; // live-mode events awaiting the transcript

  const emit = (type: string, payload?: any) => { try { core.bus.emit(type, payload); } catch (e) { console.warn(e); } };
  const prefs = (): any => { try { return core.state?.get?.("_prefs") || {}; } catch { return {}; } };
  const realtimeConfigured = () => !!core.config?.features?.voice;
  const canRealtime = () => realtimeConfigured() && Date.now() >= failedUntil;
  const SR = (): any => (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;
  const available = () => realtimeConfigured() || !!SR();

  function setState(s: VoiceState) {
    if (s === current) return;
    current = s;
    emit("voice:state", { state: s });
  }
  const restState = (): VoiceState => (live ? "listening" : "idle");

  function sendVoiceEvent(text: string, fn: string | undefined, args: any, handled: boolean) {
    const msg: any = { t: "voice_event", cid: randomCid(), text, handled };
    if (fn !== undefined) msg.function = fn;
    if (args !== undefined) msg.args = args;
    core.raw(msg);
    if (handled) emit("voice:handled", { text, function: fn, args });
    else emit("voice:passed", { text });
  }

  function speak(text: string) {
    const p = prefs();
    let spoken = false;
    if (p.audio !== false && typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined") {
      try {
        const u = new SpeechSynthesisUtterance(text);
        if (p.language) u.lang = p.language;
        speechSynthesis.speak(u);
        spoken = true;
      } catch {}
    }
    emit("voice:reply", { text, spoken });
  }

  function runBuiltin(name: string) {
    if (name === "go_back") emit("control:go_back");
    else if (name === "stop_listening") stop();
  }

  // ---- tools for the model ------------------------------------------------------------
  function toolDefs(): ToolDef[] {
    const out: ToolDef[] = [];
    const names = new Set<string>();
    for (const e of exposed.values()) {
      const hasWild = (e.opts.phrases || []).some((p) => p.includes("*"));
      const parameters = e.opts.params && typeof e.opts.params === "object"
        ? e.opts.params
        : hasWild
          ? { type: "object", properties: { text: { type: "string", description: "The free-text part of the request" } }, required: ["text"] }
          : { type: "object", properties: {} };
      const phr = e.opts.phrases?.length ? ` Example phrases: ${e.opts.phrases.map((p) => `"${p}"`).join(", ")}.` : "";
      out.push({ name: e.toolName, description: ((e.opts.description || e.name) + phr).slice(0, 1000), parameters });
      names.add(e.toolName);
    }
    for (const b of BUILTINS) if (!names.has(b.name)) out.push({ name: b.name, description: b.description, parameters: { type: "object", properties: {} } });
    out.push(ASK_AGENT);
    return out;
  }

  function contextInstructions(): string {
    const lines: string[] = [];
    try {
      const about = core.state?.get?.("_about");
      if (about?.purpose) lines.push(`This page: ${String(about.purpose).slice(0, 1000)}`);
    } catch {}
    const lang = prefs().language;
    if (lang) lines.push(`Reply in the user's language (${lang}).`);
    return lines.join("\n");
  }

  function resolvePending(v: boolean) {
    if (pending && !pending.done) { pending.done = true; pending.resolve(v); }
  }

  function flushDeferred() {
    for (const d of deferred) sendVoiceEvent(d.text || lastTranscript, d.function, d.args, true);
    deferred = [];
  }

  async function onToolCall(call: ToolCall): Promise<unknown> {
    const userText = pending && !pending.done ? pending.text : "";
    if (call.name === ASK_AGENT.name) {
      const text = userText || String(call.args?.request || lastTranscript || "").trim();
      if (!text) return { ok: false, error: "empty request" };
      sendVoiceEvent(text, undefined, undefined, false);
      resolvePending(true);
      return { ok: true, passed_to_agent: true, note: "The agent will respond later; tell the user it was passed on." };
    }
    const e = [...exposed.values()].find((x) => x.toolName === call.name);
    const builtin = !e && BUILTINS.find((b) => b.name === call.name);
    if (!e && !builtin) return { ok: false, error: `unknown function ${call.name}` };
    const fnName = e ? e.name : (builtin as Builtin).name;
    let result: unknown;
    try {
      if (e) result = await e.fn(call.args ?? {});
      else runBuiltin(fnName);
    } catch (err) {
      return { ok: false, error: String((err as any)?.message ?? err) };
    }
    if (pending && !pending.done) {
      sendVoiceEvent(userText, fnName, call.args ?? {}, true);
      resolvePending(true);
    } else {
      // Live audio: the user's transcript often arrives after the call; send on transcript/turn end.
      deferred.push({ text: "", function: fnName, args: call.args ?? {} });
    }
    return { ok: true, result: result === undefined ? null : result };
  }

  // ---- realtime session ---------------------------------------------------------------
  function scheduleIdleClose() {
    clearTimeout(idleTimer);
    if (session && !session.mic) idleTimer = setTimeout(() => { if (session && !session.mic && !pending) { session.close(); } }, IDLE_CLOSE_MS);
  }

  async function openSession(mic: boolean): Promise<RealtimeSession | null> {
    try {
      const tools = toolDefs();
      const res = await fetch(`${core.config.base}_tendril/voice/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: contextInstructions(), tools }),
      });
      if (!res.ok) throw new Error(`voice session ${res.status}`);
      const info = await res.json();
      const provider = getProvider(info?.provider);
      if (!provider) throw new Error(`unknown voice provider ${info?.provider}`);
      let mine: RealtimeSession | null = null;
      const s = await provider.connect({
        session: info,
        mic,
        tools,
        audioOut: prefs().audio !== false,
        hooks: {
          onToolCall,
          onUserTranscript(text) {
            lastTranscript = text;
            emit("voice:heard", { text });
            if (deferred.length) flushDeferred();
          },
          onReply(text) { emit("voice:reply", { text, spoken: prefs().audio !== false }); },
          onTurnDone() {
            if (deferred.length) flushDeferred();
            resolvePending(false);
            if (!pending || pending.done) setState(restState());
          },
          onSpeech(speaking) { if (speaking) lastTranscript = ""; },
          onClose() {
            if (session === mine) {
              session = null;
              resolvePending(false);
              if (mine?.mic && live) { live = false; }
              setState(restState());
            }
          },
        },
      });
      mine = s;
      return s;
    } catch (e) {
      console.warn("[tendril voice] realtime unavailable:", (e as any)?.message ?? e);
      failedUntil = Date.now() + RETRY_AFTER_MS;
      return null;
    }
  }

  async function ensureSession(mic: boolean): Promise<RealtimeSession | null> {
    if (session && (session.mic || !mic)) return session;
    if (connecting) {
      const s = await connecting;
      if (s && (s.mic || !mic)) return s;
    }
    if (session && mic && !session.mic) { const old = session; session = null; old.close(); }
    connecting = withTimeout(openSession(mic), mic ? CONNECT_TIMEOUT_MS * 3 : CONNECT_TIMEOUT_MS, "voice session timeout")
      .catch(() => { failedUntil = Date.now() + RETRY_AFTER_MS; return null; });
    const s = await connecting;
    connecting = null;
    session = s;
    return s;
  }

  // ---- public API ---------------------------------------------------------------------
  function expose(name: string, opts: ExposeOpts, fn: (args: any) => any): () => void {
    if (typeof name !== "string" || !name) throw new TypeError("tendril.expose: name required");
    if (typeof fn !== "function") throw new TypeError("tendril.expose: fn must be a function");
    const old = exposed.get(name);
    const taken = new Set([...exposed.values()].filter((e) => e.name !== name).map((e) => e.toolName));
    taken.add(ASK_AGENT.name);
    const entry: Exposed = { name, toolName: old?.toolName ?? toolNameFor(name, taken), opts: { ...(opts || {}) }, fn };
    exposed.set(name, entry);
    changed();
    return () => { if (exposed.get(name) === entry) { exposed.delete(name); changed(); } };
  }

  function changed() {
    emit("voice:exposed", { names: [...exposed.keys()] });
    session?.updateTools(toolDefs());
  }

  function entries(): PhraseEntry<{ builtin?: string; exposed?: Exposed }>[] {
    const list: PhraseEntry<{ builtin?: string; exposed?: Exposed }>[] = BUILTINS.map((b) => ({ key: { builtin: b.name }, phrases: b.phrases }));
    for (const e of exposed.values()) if (e.opts.phrases?.length) list.push({ key: { exposed: e }, phrases: e.opts.phrases });
    return list;
  }

  async function handleUtterance(text: string, _via: "voice" | "text"): Promise<boolean> {
    const t = (text || "").trim();
    if (!t) return false;

    // 1. Built-ins (always win) and exposed phrases.
    const builtinHit = matchPhrase(t, entries().filter((x) => x.key.builtin));
    const m = builtinHit ?? matchPhrase(t, entries().filter((x) => x.key.exposed));
    if (m) {
      if (m.key.builtin) {
        runBuiltin(m.key.builtin);
        sendVoiceEvent(t, m.key.builtin, {}, true);
        return true;
      }
      const e = m.key.exposed!;
      try {
        const result = await e.fn(m.args);
        sendVoiceEvent(t, e.name, m.args, true);
        if (typeof result === "string" && result.trim()) speak(result.trim());
        return true;
      } catch (err) {
        console.warn(`[tendril voice] ${e.name} failed:`, err);
        // fall through: let the model or the agent deal with it
      }
    }

    // 2. Realtime model.
    if (!canRealtime()) return false;
    let mine: { text: string; resolve: (v: boolean) => void; done: boolean } | null = null;
    setState("thinking");
    try {
      const s = await ensureSession(false);
      if (!s) return false;
      resolvePending(false); // supersede an earlier utterance still waiting
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { if (mine && !mine.done) { mine.done = true; resolve(false); } }, UTTERANCE_TIMEOUT_MS);
        mine = { text: t, resolve: (v) => { clearTimeout(timer); resolve(v); }, done: false };
        pending = mine;
        s.sendText(t, { modality: _via === "text" ? "text" : "audio" });
      });
    } finally {
      if (pending === mine) pending = null;
      scheduleIdleClose();
      setState(restState());
    }
  }

  function startRecognition(): boolean {
    const Ctor = SR();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = prefs().language || (typeof navigator !== "undefined" ? navigator.language : "en-US");
    rec.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (!r.isFinal) continue;
        const text = String(r[0]?.transcript || "").trim();
        if (!text) continue;
        emit("voice:heard", { text });
        void handleUtterance(text, "voice").then((handled) => {
          if (!handled) { emit("voice:passed", { text }); return core.instruction(text, "voice"); }
        }).catch((e) => console.warn("[tendril voice]", e));
      }
    };
    rec.onerror = (ev: any) => {
      if (ev?.error === "not-allowed" || ev?.error === "service-not-allowed" || ev?.error === "audio-capture") stop();
    };
    // Browsers end continuous recognition after silence; restart while live.
    rec.onend = () => {
      if (live && recognition === rec) setTimeout(() => { if (live && recognition === rec) { try { rec.start(); } catch {} } }, 250);
    };
    recognition = rec;
    rec.start();
    return true;
  }

  async function start(): Promise<void> {
    if (live || !available()) return;
    live = true;
    setState("listening");
    if (canRealtime()) {
      const s = await ensureSession(true);
      if (!live) { if (s?.mic) s.close(); return; }
      if (s?.mic) { clearTimeout(idleTimer); return; }
    }
    try {
      if (!startRecognition()) { live = false; setState(restState()); }
    } catch (e) {
      console.warn("[tendril voice] speech recognition failed:", e);
      live = false;
      recognition = null;
      setState(restState());
    }
  }

  function stop(): void {
    live = false;
    const rec = recognition;
    recognition = null;
    try { rec?.stop(); } catch {}
    if (session?.mic) { const s = session; session = null; s.close(); }
    if (current !== "thinking") setState("idle");
  }

  // Mute model audio when the user turns audio off.
  try {
    core.state?.on?.(() => session?.setAudioOut(prefs().audio !== false));
  } catch {}

  return {
    expose,
    start,
    stop,
    get state(): VoiceState { return available() ? current : "unavailable"; },
    handleUtterance,
  };
}
