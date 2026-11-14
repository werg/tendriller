// The one always-present control (PLAN §7, §13 features 3/6/8, §14).
// Rendered into a Shadow DOM on a fixed, zero-size host so it never affects page layout.
//
// Bus events this module listens to (from core): connect, disconnect, welcome, presence,
// say, instruction_echo, role, state.
// Bus events it handles for other modules:
//   control:go_back   {version?}  → rollback (owner only); replies with control:go_back_result {ok, version?, error?}
//   control:open / control:close  → open or close the sheet
// Bus events it emits: control:sensors_stopped {count}, control:go_back_result.

import type { Core, ControlApi, Presence, TranscriptEntry } from "../types";
import { registry } from "../registry";
import { CSS } from "./styles";
import { h, clear, icon, relTime } from "./dom";
import { installSensorWrappers, type SensorKind, type SensorTracker } from "./sensors";
import { installAudioUnlock, playCue, haptic, type Cue } from "./feedback";
import { SpeechCapture } from "./speech";
import { qrSvg } from "./qr";

type Pos = "bottom-right" | "bottom-left" | "top-right" | "top-left";
type View = "connecting" | "offline" | "pending" | "listening" | "working" | "done" | "scheduled" | "not_responding" | "away" | "no_agent";
interface Prefs { text_size?: "normal" | "large" | "x-large"; contrast?: "normal" | "high"; audio?: boolean; language?: string; mode?: string }
interface Line extends TranscriptEntry { local?: boolean }

const TRANSCRIPT_MAX = 6;
const DONE_MS = 8000;
const MAX_REATTACH = 5;
const SENSOR_LABEL: Record<SensorKind, string> = { camera: "Camera", microphone: "Microphone", screen: "Screen sharing", location: "Location", motion: "Motion sensors" };
const LANGS = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "pl-PL"];

let mounted: ControlApi | null = null;

export function mountControl(core: Core): ControlApi {
  if (mounted) return mounted;
  const sensors = installSensorWrappers();
  const c = new Control(core, sensors);
  mounted = c.api;
  return mounted;
}

class Control {
  api: ControlApi;
  private host!: HTMLElement;
  private root!: HTMLDivElement;
  private ui: Record<string, HTMLElement> = {};
  private ready = false;
  private open = false;
  private hiddenByPage = false;
  private pos: Pos = "bottom-right";
  private view: View = "connecting";
  private prevPresenceState: string | null = null;
  private doneUntil = 0;
  private doneTimer: any = 0;
  private lines: Line[] = [];
  private budget: { page_streak?: number } = {};
  private lastSendAt = 0;
  private lastWithheld = 0;
  private bubbleTimer: any = 0;
  private bubbleText = "";
  private pageErrors = 0;
  private reattaches = 0;
  private capture: SpeechCapture | null = null;
  private guestPoll: number | null = null;
  private hintMsg = "";
  private noticeSig = "";
  private transcriptSig = "";
  private sensorSig = "";
  private firstPublicVisit = false;

  constructor(private core: Core, private sensors: SensorTracker) {
    try {
      const key = `tendril:${core.config.id}:seen-notice`;
      this.firstPublicVisit = localStorage.getItem(key) !== "1";
      localStorage.setItem(key, "1");
    } catch { this.firstPublicVisit = true; }
    this.api = {
      hide: () => { this.hiddenByPage = true; this.render(); },
      show: () => { this.hiddenByPage = false; this.render(); },
      position: (p) => { if (["bottom-right", "bottom-left", "top-right", "top-left"].includes(p)) { this.pos = p; this.render(); } },
    };
    this.lines = (core.transcript || []).slice(-TRANSCRIPT_MAX).map((l) => ({ ...l }));
    this.lastWithheld = core.presence?.withheld ?? 0;
    this.prevPresenceState = core.presence?.state ?? null;
    this.subscribe();
    sensors.onChange(() => { this.renderSensors(); this.reportSensorUse(); });
    window.addEventListener("error", () => { this.pageErrors++; this.renderNotices(); });
    window.addEventListener("unhandledrejection", () => { this.pageErrors++; this.renderNotices(); });
    if (document.body) this.build();
    else document.addEventListener("DOMContentLoaded", () => this.build(), { once: true });
  }

  // ---------- derived ----------
  private get role(): string { return this.core.device?.role || "owner"; }
  private get pending(): boolean { return !!this.core.device?.pending; }
  private get isOwner(): boolean { return this.role === "owner" && !this.pending; }
  private get canInput(): boolean { return this.role !== "display"; }
  private get prefs(): Prefs {
    try { return (this.core.state?.get("_prefs") as Prefs) || {}; } catch { return {}; }
  }
  private get lang(): string { return this.prefs.language || navigator.language || "en-US"; }
  private get displayMode(): boolean {
    return this.role === "display" || location.hash === "#display" || this.prefs.mode === "display";
  }
  private get audioOn(): boolean { return this.prefs.audio !== false; }
  private get reducedMotion(): boolean { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; }

  private computeView(): View {
    if (!this.core.connected) return this.core.presence || this.lines.length ? "offline" : "connecting";
    if (this.pending) return "pending";
    if (Date.now() < this.doneUntil) return "done";
    const s = this.core.presence?.state as string | undefined;
    if (!s) return "connecting";
    if (s === "done") return "done";
    if (s === "idle") return "listening";
    return (["listening", "working", "scheduled", "not_responding", "away", "no_agent"].includes(s) ? s : "listening") as View;
  }

  private describe(v: View): { label: string; detail: string } {
    const p = this.core.presence;
    const heard = p?.last_seen ? `Last heard from ${relTime(p.last_seen, this.lang)}` : "";
    switch (v) {
      case "connecting": return { label: "Connecting", detail: "Connecting to the agent…" };
      case "offline": return { label: "Offline", detail: "No connection. What you send is kept and delivered when the connection returns." };
      case "pending": return { label: "Waiting for approval", detail: "An owner device needs to approve this one." };
      case "listening": return { label: "Listening", detail: p?.text && p.text.toLowerCase() !== "listening" ? p.text : "The agent is ready." };
      case "working": return { label: "Working", detail: p?.text && p.text.toLowerCase() !== "working" ? p.text : "The agent is working on it." };
      case "done": return { label: "Done", detail: p?.text && !/^(done|listening)$/i.test(p.text) ? p.text : "The agent has finished." };
      case "scheduled": {
        const n = p?.schedule_minutes;
        return { label: n ? `Checks every ${n} min` : "Checks on a schedule", detail: [heard, "Messages wait until the agent's next check."].filter(Boolean).join(". ") };
      }
      case "not_responding": return { label: "Not responding", detail: "The agent was asked but hasn't checked in yet. Your messages are kept." };
      case "away": return { label: "Away", detail: heard || p?.text || "The agent hasn't checked in for a while." };
      case "no_agent": return { label: "No agent", detail: (heard ? `No agent attached. ${heard}.` : "No agent attached yet.") + " What you send is saved for later." };
    }
  }

  // ---------- events ----------
  private subscribe() {
    const bus = this.core.bus;
    const on = (t: string, fn: (p: any) => void) => { try { bus.on(t, fn); } catch { /* ignore */ } };
    on("connect", () => this.render());
    on("disconnect", () => this.render());
    on("welcome", (w: any) => {
      if (w?.budget) this.budget = { ...w.budget };
      const tr: TranscriptEntry[] = this.core.transcript?.length ? this.core.transcript : (w?.transcript || []);
      const locals = this.lines.filter((l) => l.local);
      this.lines = [...tr.map((l) => ({ ...l })), ...locals].slice(-TRANSCRIPT_MAX);
      this.prevPresenceState = (w?.presence || this.core.presence)?.state ?? this.prevPresenceState;
      this.lastWithheld = (w?.presence || this.core.presence)?.withheld ?? this.lastWithheld;
      this.applyPrefs();
      this.render();
      this.reportSensorUse();
    });
    on("presence", (p: Presence) => this.onPresence(p || this.core.presence));
    on("say", (m: any) => { if (m?.text) this.addLine({ ts: m.ts || Date.now(), from: "agent", text: String(m.text) }); });
    on("instruction_echo", (m: any) => { if (m?.text) this.addLine({ ts: m.ts || Date.now(), from: "user", text: String(m.text) }); });
    on("role", () => { this.applyPrefs(); this.render(); });
    on("control:go_back", (m: any) => { void this.goBack(m?.version); });
    on("control:open", () => this.setOpen(true));
    on("control:close", () => this.setOpen(false));
    try { this.core.state?.on(() => { this.applyPrefs(); this.render(); }); } catch { /* ignore */ }
  }

  private onPresence(p: Presence | null) {
    const prev = this.prevPresenceState;
    const now = p?.state ?? null;
    this.prevPresenceState = now;
    if (prev !== now) {
      if (now === "working") { this.doneUntil = 0; this.cue("working"); }
      else if ((prev === "working" && now && !["not_responding", "no_agent"].includes(now)) || (now as string) === "done") {
        this.doneUntil = Date.now() + DONE_MS;
        clearTimeout(this.doneTimer);
        this.doneTimer = setTimeout(() => this.render(), DONE_MS + 20);
        this.cue("done");
      } else this.doneUntil = 0;
    }
    const w = p?.withheld ?? 0;
    if (w > this.lastWithheld && Date.now() - this.lastSendAt < 8000) this.showBubble("The agent will see this at its next check.", true);
    this.lastWithheld = w;
    this.render();
  }

  private cue(c: Cue) {
    if (this.audioOn) { try { playCue(c); } catch { /* ignore */ } }
    if (!this.reducedMotion) haptic(c);
  }

  private addLine(l: Line) {
    if (l.from === "user") {
      const i = this.lines.findIndex((x) => x.local && x.text === l.text);
      if (i >= 0) { this.lines[i] = { ...l }; this.renderTranscript(); return; }
    }
    if (this.lines.some((x) => !x.local && x.from === l.from && x.text === l.text && Math.abs(x.ts - l.ts) < 2000)) return;
    this.lines.push(l);
    this.lines = this.lines.slice(-TRANSCRIPT_MAX);
    this.renderTranscript();
    if (l.from === "agent") {
      if (!this.open) this.showBubble(l.text, false, "Agent");
    }
  }

  // ---------- build ----------
  private build() {
    if (this.ready) return;
    this.ready = true;
    installAudioUnlock();
    this.host = document.createElement("tendril-control");
    this.host.setAttribute("style", "all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483600!important;display:block!important;overflow:visible!important;contain:none!important;");
    this.host.setAttribute("data-tendril", "control");
    const shadow = this.host.attachShadow({ mode: "open" });
    shadow.appendChild(h("style", { text: CSS }));
    this.root = h("div", { class: "root" });
    shadow.appendChild(this.root);
    this.buildDock();
    this.buildSheet();
    this.root.appendChild(this.ui.live = h("div", { class: "sr", role: "status", "aria-live": "polite", "aria-atomic": "true" }));
    document.body.appendChild(this.host);
    this.watchRemoval();
    this.capture = new SpeechCapture({
      onConsent: () => this.confirmSpeechDownload(),
      onInterim: (t) => this.showInterim(t),
      onFinal: (t) => { this.showInterim(""); void this.submit(t, "voice"); },
      onState: (on) => this.renderMic(on),
      onError: (m) => { this.showInterim(""); this.showBubble(m, true); },
    }, this.sensors, () => this.lang, this.core.config.base, this.core.config.features.speech);
    this.view = this.computeView();
    this.applyPrefs();
    this.render();
    // Keep relative times ("last heard …") fresh.
    setInterval(() => { if (this.view === "away" || this.view === "no_agent" || this.view === "scheduled") this.render(); }, 60000);
  }

  private watchRemoval() {
    const check = () => {
      if (this.host.isConnected) return;
      if (this.reattaches >= MAX_REATTACH) { mo.disconnect(); return; }
      this.reattaches++;
      (document.body || document.documentElement).appendChild(this.host);
      if (document.body) mo.observe(document.body, { childList: true });
    };
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { childList: true });
    mo.observe(document.body, { childList: true });
  }

  private buildDock() {
    const u = this.ui;
    u.dock = h("div", { class: "dock" });
    u.bubble = h("div", { class: "bubble glass", hidden: true });
    u.sensorChip = h("div", { class: "chip sensors glass", hidden: true },
      u.sensorIcons = h("span", { class: "icons" }),
      u.sensorText = h("span", null),
      h("button", { type: "button", class: "btn stop small", onclick: () => this.stopSensors() }, icon("stop"), "Stop"),
    );
    u.presenceBtn = h("button", {
      type: "button", class: "presence", "aria-expanded": "false", "aria-controls": "tendril-sheet",
      onclick: () => this.setOpen(!this.open),
    },
      u.orb = h("span", { class: "orb" }),
      u.label = h("span", { class: "label" }),
      u.badge = h("span", { class: "badge", hidden: true }),
    );
    u.mic = this.makeMic("mic");
    u.pill = h("div", { class: "pill glass" }, u.presenceBtn, u.mic);
    u.dock.append(u.bubble, u.sensorChip, u.pill);
    this.root.appendChild(u.dock);
  }

  private makeMic(cls: string): HTMLButtonElement {
    const b = h("button", { type: "button", class: cls, "aria-pressed": "false", "aria-label": "Talk to the agent (hold, or tap to start and stop)" }, icon("mic"));
    let downAt = 0;
    let pointerHandled = false;
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.capture?.mode) return;
      pointerHandled = true;
      downAt = Date.now();
      if (this.capture.listening) return; // second tap stops (handled on up)
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      void this.capture.start(true);
    });
    const up = () => {
      if (!downAt || !this.capture) return;
      const held = Date.now() - downAt;
      const wasToggleStart = b.dataset.toggle === "1";
      downAt = 0;
      if (held > 400) { b.dataset.toggle = ""; this.capture.stop(); return; }
      // Short tap: first tap starts toggle mode, second tap stops.
      if (wasToggleStart) { b.dataset.toggle = ""; this.capture.stop(); }
      else b.dataset.toggle = "1";
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", () => { if (downAt) { downAt = 0; this.capture?.stop(); } });
    b.addEventListener("click", (e) => {
      if (pointerHandled) { pointerHandled = false; return; }
      // Keyboard and switch access: click toggles.
      e.preventDefault();
      if (!this.capture?.mode) return;
      if (this.capture.listening) this.capture.stop(); else void this.capture.start(false);
    });
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    return b;
  }

  private confirmSpeechDownload(): Promise<boolean> {
    return new Promise(resolve => {
      const dialog = h("div", { class: "speech-consent", role: "dialog", "aria-modal": "true", "aria-label": "Set up private speech" },
        h("div", { class: "speech-consent-card glass" },
          h("h2", { text: "Set up private speech" }),
          h("p", { text: "Download about 18 MB once to transcribe on this device. Audio stays here. You can always type instead." }),
          h("div", { class: "actions" },
            h("button", { type: "button", class: "btn primary", onclick: () => { dialog.remove(); resolve(true); } }, "Download and continue"),
            h("button", { type: "button", class: "btn", onclick: () => { dialog.remove(); resolve(false); } }, "Use typing"))));
      this.root.appendChild(dialog);
      (dialog.querySelector("button") as HTMLButtonElement).focus();
    });
  }

  private buildSheet() {
    const u = this.ui;
    u.sheet = h("section", { class: "sheet", id: "tendril-sheet", role: "dialog", "aria-modal": "false", "aria-labelledby": "tendril-title", hidden: true });
    u.sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); this.setOpen(false); } });
    u.headOrb = h("span", { class: "orb" });
    u.title = h("h2", { id: "tendril-title" });
    u.detail = h("p", null);
    u.sheet.append(h("div", { class: "head" },
      u.headOrb,
      h("div", { class: "titles" }, u.title, u.detail),
      h("button", { type: "button", class: "iconbtn", "aria-label": "Close", onclick: () => this.setOpen(false) }, icon("close")),
    ));
    u.notices = h("div", null);
    u.sheet.appendChild(u.notices);

    u.transcript = h("ol", { class: "log", role: "log", "aria-label": "Conversation", "aria-live": "off" });
    u.sheet.appendChild(u.transcript);

    // Composer
    u.text = h("textarea", { rows: "1", "aria-label": "Message to the agent", placeholder: "Type a message…", enterkeyhint: "send" }) as HTMLTextAreaElement;
    u.text.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendTyped(); }
    });
    u.text.addEventListener("input", () => { const t = u.text as HTMLTextAreaElement; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 200) + "px"; });
    u.sheetMic = this.makeMic("mic");
    u.composer = h("form", { class: "composer", onsubmit: (e: Event) => { e.preventDefault(); this.sendTyped(); } },
      u.text,
      h("button", { type: "submit", class: "btn primary send", "aria-label": "Send" }, icon("send")),
      u.sheetMic,
    );
    u.hint = h("div", { class: "hint" });
    u.sheet.append(u.composer, u.hint);

    u.sheetSensors = h("div", { class: "card warn", hidden: true });
    u.sheet.appendChild(u.sheetSensors);

    // Owner quick actions
    u.ownerActions = h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", onclick: () => void this.goBack() }, icon("undo"), "Go back"),
    );
    u.sheet.appendChild(u.ownerActions);

    u.ownerSections = h("div", null,
      this.section("versions", "Earlier versions", icon("undo"), (p) => this.loadVersions(p)),
      this.section("activity", "Activity record", icon("bell"), (p) => this.loadActivity(p)),
      this.section("devices", "Devices", icon("device"), (p) => this.loadDevices(p)),
      this.section("add", "Add a device", icon("device"), (p) => this.renderAddDevice(p)),
      this.section("adopt", "Connect an agent", icon("link"), (p) => this.renderAdopt(p)),
      this.section("agents", "Agents", icon("device"), (p) => void this.loadAgents(p)),
      this.section("guest-invites", "Guest invitations", icon("link"), (p) => void this.loadGuestInvites(p)),
      this.section("budget", "Wake limits", icon("scheduled"), (p) => this.renderBudget(p)),
      this.section("notify", "Notifications", icon("bell"), (p) => void this.renderNotify(p)),
    );
    u.sheet.appendChild(u.ownerSections);
    u.prefsSection = this.section("prefs", "Display and sound", icon("text"), (p) => this.renderPrefs(p));
    u.sheet.appendChild(u.prefsSection);
    u.sheet.appendChild(this.section("report", "Report this page", icon("bell"), (p) => {
      clear(p, h("p", { text: "If this page is deceptive, harmful, or abusive, send a report." }),
        h("a", { href: this.core.config.base + "_tendril/report", target: "_blank", rel: "noopener noreferrer" }, "Open report form"));
    }));
    u.sheet.appendChild(h("div", { class: "service-brand" },
      h("img", { src: this.core.config.base + "_tendril/brand/icon-64.png", alt: "", width: "28", height: "28", loading: "lazy" }),
      "Tendriller",
    ));
    this.root.appendChild(u.sheet);
  }

  private section(id: string, title: string, ic: HTMLElement, onOpen: (panel: HTMLElement) => void): HTMLDetailsElement {
    const panel = h("div", { class: "panel", id: `tendril-${id}` });
    const d = h("details", { "data-section": id }, h("summary", null, ic, title, icon("chevron", "icon chev")), panel);
    d.addEventListener("toggle", () => { if (d.open) onOpen(panel); });
    return d;
  }

  // ---------- render ----------
  private render() {
    if (!this.ready) return;
    const u = this.ui;
    const prevView = this.view;
    this.view = this.computeView();
    const { label, detail } = this.describe(this.view);
    this.root.dataset.pos = this.pos;
    this.root.dataset.role = this.role;
    this.root.dataset.display = String(this.displayMode);

    for (const o of [u.orb, u.headOrb]) {
      if (o.dataset.state !== this.view) { o.dataset.state = this.view; clear(o, icon(this.view)); }
    }
    u.label.textContent = label;
    u.title.textContent = label;
    u.detail.textContent = detail;
    u.badge.hidden = true;
    u.presenceBtn.setAttribute("aria-label", `Agent status: ${label}. ${this.open ? "Close" : "Open"} the control.`);
    if (prevView !== this.view) this.announce(`${label}. ${detail}`);

    // Visibility by role
    const micOk = this.canInput && !!this.capture?.mode;
    u.mic.hidden = !micOk || (this.displayMode && this.role !== "owner");
    u.sheetMic.hidden = !micOk;
    u.composer.hidden = !this.canInput;
    u.hint.hidden = !this.canInput;
    u.hint.textContent = this.hintMsg || (this.role === "guest" ? "You're a guest: your messages go to the page as data, not as instructions." : "");
    (u.text as HTMLTextAreaElement).placeholder = this.role === "guest" ? "Type a message (as a guest)…" : "Type a message…";
    u.ownerActions.hidden = !this.isOwner;
    u.ownerSections.hidden = !this.isOwner;
    u.prefsSection.hidden = this.role === "display";

    // Hidden by page: keep sensor indicator visible regardless (safety).
    u.pill.hidden = this.hiddenByPage;
    u.bubble.hidden = this.hiddenByPage || !this.bubbleText;
    if (this.hiddenByPage && this.open) this.setOpen(false);

    this.renderNotices();
    this.renderTranscript();
    this.renderSensors();
  }

  private renderNotices() {
    if (!this.ready) return;
    const n = this.ui.notices;
    const sig = JSON.stringify([this.isOwner, this.pageErrors > 0,
      this.core.config.features?.shared_by, this.displayMode, this.firstPublicVisit]);
    if (sig === this.noticeSig) return;
    this.noticeSig = sig;
    clear(n);
    if (this.displayMode) {
      n.appendChild(h("div", { class: "card", text: `Shared by ${this.core.config.features.shared_by || "a Tendriller user"}` }));
    }
    if (this.firstPublicVisit) {
      n.appendChild(h("div", { class: "card warn", text: "Made by an AI agent. Tendriller never asks for passwords in a page." }));
    }
    if (this.isOwner) {
      if (this.pageErrors > 0) {
        n.appendChild(h("div", { class: "card warn", role: "group", "aria-label": "Page problem" },
          h("h3", { text: "This page ran into a problem" }),
          h("p", { text: "If it isn't working, you can go back to the previous version." }),
          h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => void this.goBack() }, icon("undo"), "Go back")),
        ));
      }
    }
  }

  private renderTranscript() {
    if (!this.ready) return;
    const t = this.ui.transcript;
    const sig = JSON.stringify([this.canInput, this.lines]);
    if (sig === this.transcriptSig) return;
    this.transcriptSig = sig;
    clear(t);
    if (!this.lines.length) {
      t.appendChild(h("li", { class: "empty", text: this.canInput ? "Say or type what you'd like. Replies appear here." : "Messages from the agent appear here." }));
      return;
    }
    for (const l of this.lines) {
      t.appendChild(h("li", { class: l.from },
        h("span", { class: "who", text: l.from === "agent" ? "Agent" : (l.local ? "You (sending…)" : "You") }),
        l.text));
    }
  }

  private renderSensors() {
    if (!this.ready) return;
    const u = this.ui;
    const act = this.sensors.active();
    const names = act.map((k) => SENSOR_LABEL[k]);
    const text = names.length ? `${names.join(", ")} in use` : "";
    u.sensorChip.hidden = !act.length;
    clear(u.sensorIcons, ...act.map((k) => icon(k)));
    u.sensorText.textContent = text;
    const stopBtn = u.sensorChip.querySelector("button")!;
    stopBtn.setAttribute("aria-label", `Stop ${names.join(", ") || "sensors"}`);
    clear(u.sheetSensors);
    u.sheetSensors.hidden = !act.length;
    if (act.length) {
      u.sheetSensors.append(
        h("h3", { text }),
        h("p", { text: "This page is using these sensors right now. Stop turns them all off." }),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn stop", onclick: () => this.stopSensors() }, icon("stop"), "Stop all sensors")),
      );
    }
    const sig = act.join(",");
    if (sig !== this.sensorSig) {
      this.sensorSig = sig;
      this.announce(act.length ? text : "No sensors in use");
    }
  }

  private reportSensorUse() {
    if (!this.core.connected) return;
    this.core.raw({ t: "sensor_usage", active: this.sensors.active() });
  }

  private renderMic(on: boolean) {
    for (const b of [this.ui.mic, this.ui.sheetMic]) {
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", on ? "Listening. Release or tap to send" : "Talk to the agent (hold, or tap to start and stop)");
      if (!on) b.dataset.toggle = "";
    }
    if (on) this.showInterim("Listening…");
  }

  private showInterim(t: string) {
    if (!this.ready) return;
    if (this.open) {
      this.hintMsg = t;
      this.render();
    } else {
      this.bubbleText = t;
      clear(this.ui.bubble, t);
      this.ui.bubble.hidden = !t || this.hiddenByPage;
    }
  }

  private showBubble(text: string, announce: boolean, who?: string) {
    if (!this.ready) return;
    if (announce) this.announce(text);
    if (this.open) {
      this.hintMsg = text;
      this.render();
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => { this.hintMsg = ""; this.render(); }, 6000);
      return;
    }
    this.bubbleText = text;
    clear(this.ui.bubble, who ? h("span", { class: "who", text: who }) : null, text);
    this.ui.bubble.hidden = this.hiddenByPage;
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => { this.bubbleText = ""; this.ui.bubble.hidden = true; }, Math.min(12000, 4000 + text.length * 60));
  }

  private announce(text: string) {
    const live = this.ui.live;
    if (!live) return;
    live.textContent = "";
    // Re-set on the next frame so repeated messages are announced again.
    setTimeout(() => { live.textContent = text; }, 30);
  }

  private setOpen(v: boolean) {
    if (!this.ready || v === this.open) return;
    if (v && this.hiddenByPage) return;
    this.open = v;
    const u = this.ui;
    u.sheet.hidden = !v;
    u.presenceBtn.setAttribute("aria-expanded", String(v));
    if (v) {
      this.bubbleText = "";
      u.bubble.hidden = true;
      this.render();
      // Don't pop up the on-screen keyboard on touch devices; focus the sheet's first button there.
      const fine = !!window.matchMedia?.("(pointer: fine)").matches;
      const first = this.canInput && fine ? u.text : (u.sheet.querySelector("button") as HTMLElement);
      setTimeout(() => first?.focus({ preventScroll: true } as any), 0);
    } else {
      this.render();
      u.presenceBtn.focus({ preventScroll: true } as any);
    }
  }

  // ---------- prefs ----------
  private applyPrefs() {
    const p = this.prefs;
    const size = p.text_size === "large" || p.text_size === "x-large" ? p.text_size : "normal";
    const contrast = p.contrast === "high" ? "high" : "normal";
    const de = document.documentElement;
    if (de.dataset.tendrilTextSize !== size) de.dataset.tendrilTextSize = size;
    if (de.dataset.tendrilContrast !== contrast) de.dataset.tendrilContrast = contrast;
    if (this.root) { this.root.dataset.size = size; this.root.dataset.contrast = contrast; }
  }

  private setPref(key: keyof Prefs, value: unknown) {
    try { this.core.state.set(["_prefs", key], value); } catch { /* ignore */ }
    this.applyPrefs();
  }

  private renderPrefs(panel: HTMLElement) {
    const p = this.prefs;
    const size = p.text_size || "normal";
    const seg = (name: string, legend: string, options: [string, string][], current: string, set: (v: string) => void) =>
      h("fieldset", null, h("legend", { text: legend }), h("div", { class: "seg" },
        options.map(([v, l]) => h("label", null,
          h("input", { type: "radio", name, value: v, checked: v === current, onchange: () => set(v) }),
          h("span", { text: l })))));
    const langSel = h("select", { id: "tendril-lang", onchange: (e: Event) => this.setPref("language", (e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    const langs = Array.from(new Set([this.lang, ...(navigator.languages || []), ...LANGS]));
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([this.lang], { type: "language" }); } catch { /* ignore */ }
    for (const l of langs) {
      let n = l;
      try { n = names?.of(l) || l; } catch { /* ignore */ }
      langSel.appendChild(h("option", { value: l, text: n === l ? l : `${n} (${l})` }));
    }
    langSel.value = this.lang;
    clear(panel,
      seg("tendril-size", "Text size", [["normal", "Normal"], ["large", "Large"], ["x-large", "Larger"]], size, (v) => this.setPref("text_size", v)),
      h("label", { class: "switch" },
        h("input", { type: "checkbox", checked: p.contrast === "high", onchange: (e: Event) => this.setPref("contrast", (e.target as HTMLInputElement).checked ? "high" : "normal") }),
        "High contrast"),
      h("label", { class: "switch" },
        h("input", { type: "checkbox", checked: p.audio !== false, onchange: (e: Event) => this.setPref("audio", (e.target as HTMLInputElement).checked) }),
        "Sounds and spoken replies"),
      h("div", { class: "field" }, h("label", { for: "tendril-lang", text: "Language" }), langSel),
      h("p", { class: "muted", text: "These settings are shared with the agent's page, which is asked to follow them." }),
    );
  }

  // ---------- sending ----------
  private sendTyped() {
    const t = this.ui.text as HTMLTextAreaElement;
    const text = t.value.trim();
    if (!text) return;
    t.value = "";
    t.style.height = "auto";
    void this.submit(text, "text");
  }

  private async submit(raw: string, via: "voice" | "text") {
    const text = raw.trim();
    if (!text || !this.canInput) return;
    this.lastSendAt = Date.now();
    this.lastWithheld = this.core.presence?.withheld ?? this.lastWithheld;
    this.lines.push({ ts: Date.now(), from: "user", text, local: true });
    this.lines = this.lines.slice(-TRANSCRIPT_MAX);
    this.renderTranscript();
    try {
      await this.core.instruction(text, via);
    } catch {
      this.showBubble("Couldn't send that. It will be retried when the connection returns.", true);
      return;
    }
    this.showBubble(this.ackText(via), true);
  }

  private ackText(via: "voice" | "text"): string {
    if (this.role === "guest") return "Sent to the page as a guest message.";
    if (!this.core.connected) return "Saved. It will be sent when the connection returns.";
    const s = this.core.presence?.state;
    if (s === "no_agent" || s === "away") return "Saved for later. No agent is attached right now.";
    if (s === "not_responding") return "Sent. The agent hasn't responded yet; it will see this when it checks in.";
    if (s === "scheduled") return "The agent will see this at its next check.";
    if ((this.core.presence?.withheld ?? 0) > this.lastWithheld) return "The agent will see this at its next check.";
    return via === "voice" ? "Passed to the agent." : "Sent.";
  }

  private stopSensors() {
    const n = this.sensors.stopAll();
    this.announce(n ? "All sensors stopped." : "No sensors were in use.");
    try { this.core.bus.emit("control:sensors_stopped", { count: n }); } catch { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent("tendril:sensors-stopped", { detail: { count: n } })); } catch { /* ignore */ }
    this.renderSensors();
  }

  // ---------- owner actions ----------
  private async req(msg: { t: string; [k: string]: any }): Promise<any> {
    const r = await this.core.request(msg);
    if (r && r.error) throw new Error(typeof r.error === "string" ? r.error : r.error.message || r.error.code || "error");
    return r;
  }

  private async goBack(version?: number) {
    if (!this.isOwner) {
      this.emitGoBack({ ok: false, error: "Only an owner device can go back." });
      return;
    }
    this.showBubble(version ? `Switching to version ${version}…` : "Going back to the previous version…", true);
    try {
      const r = await this.req(version ? { t: "rollback", version } : { t: "rollback" });
      const v = r?.version;
      this.showBubble(v ? `Showing version ${v}.` : "Went back.", true);
      this.emitGoBack({ ok: true, version: v });
    } catch (e: any) {
      const msg = /no.*version|nothing/i.test(String(e?.message)) ? "There is no earlier version to go back to." : `Couldn't go back: ${e?.message || "error"}`;
      this.showBubble(msg, true);
      this.emitGoBack({ ok: false, error: msg });
    }
  }

  private emitGoBack(r: object) { try { this.core.bus.emit("control:go_back_result", r); } catch { /* ignore */ } }

  private async loadVersions(panel: HTMLElement) {
    clear(panel, h("p", { class: "muted", text: "Loading…" }));
    try {
      const r = await this.req({ t: "versions" });
      const vs: any[] = r?.versions || [];
      const current = r?.current ?? this.core.config?.version;
      if (!vs.length) { clear(panel, h("p", { class: "muted", text: "No versions yet." })); return; }
      clear(panel,
        h("p", { text: "Pick a version to show it again. Newer versions are kept, so you can come back." }),
        h("ul", { class: "list" }, vs.map((v) => {
          const isCur = v.version === current;
          const status = v.status === "failed" ? "had a problem" : v.status === "pending" ? "new" : "worked";
          return h("li", null,
            h("span", { class: "grow" },
              `Version ${v.version}`, isCur ? h("span", { class: "tag", text: "showing now" }) : null,
              h("span", { class: "sub", text: [relTime(v.created_at, this.lang), status, v.message].filter(Boolean).join(" · ") })),
            isCur ? null : h("button", { type: "button", class: "btn small", "aria-label": `Show version ${v.version}`, onclick: () => void this.goBack(v.version) }, "Show"),
          );
        })),
      );
    } catch (e: any) {
      clear(panel, h("p", { class: "error", text: `Couldn't load versions: ${e?.message || "error"}` }));
    }
  }

  private async loadActivity(panel: HTMLElement) {
    clear(panel, h("p", { class: "muted", text: "Loading…" }));
    try {
      const r = await this.req({ t: "activity" });
      const entries: any[] = (r?.entries || []).slice().sort((a: any, b: any) => b.seq - a.seq);
      const base = this.core.config?.base || "";
      const list = h("ul", { class: "list" });
      for (const e of entries) {
        const li = h("li", null,
          e.blob ? h("img", { class: "thumb", src: `${base}_tendril/blob/${encodeURIComponent(e.blob)}`, alt: e.summary ? `Thumbnail: ${e.summary}` : "Thumbnail", loading: "lazy", onerror: (ev: Event) => { (ev.target as HTMLElement).hidden = true; } }) : null,
          h("span", { class: "grow" },
            e.summary || e.kind,
            e.source === "agent" ? h("span", { class: "tag", text: "reported by the agent" }) : null,
            h("span", { class: "sub", text: [relTime(e.ts, this.lang), e.kind].filter(Boolean).join(" · ") })),
          h("button", {
            type: "button", class: "btn small danger ghost", "aria-label": `Delete: ${e.summary || e.kind}`,
            onclick: async () => {
              try { await this.req({ t: "activity_delete", seq: e.seq }); li.remove(); this.announce("Entry deleted."); }
              catch (err: any) { this.announce(`Couldn't delete: ${err?.message || "error"}`); }
            },
          }, icon("trash")),
        );
        list.appendChild(li);
      }
      clear(panel,
        h("p", { text: "What this page sent to the agent, and what the agent did here. Kept 30 days." }),
        h("p", { class: "muted", text: "Deleting an entry removes it and its stored data from the server. It can't remove what the agent has already read." }),
        entries.length ? list : h("p", { class: "muted", text: "Nothing recorded yet." }),
      );
    } catch (e: any) {
      clear(panel, h("p", { class: "error", text: `Couldn't load the activity record: ${e?.message || "error"}` }));
    }
  }

  private async loadDevices(panel: HTMLElement) {
    clear(panel, h("p", { class: "muted", text: "Loading…" }));
    try {
      const r = await this.req({ t: "devices" });
      const ds: any[] = r?.devices || [];
      const me = this.core.device?.id;
      clear(panel, ds.length ? h("ul", { class: "list" }, ds.map((d) => h("li", null,
        icon("device"),
        h("span", { class: "grow" },
          d.name || d.id, d.id === me ? h("span", { class: "tag", text: "this device" }) : null,
          h("span", { class: "sub", text: [d.pending ? "waiting for approval" : roleName(d.role), d.connected ? "connected" : d.last_seen ? `seen ${relTime(d.last_seen, this.lang)}` : ""].filter(Boolean).join(" · ") })),
        null,
      ))) : h("p", { class: "muted", text: "No devices yet." }));
    } catch (e: any) {
      clear(panel, h("p", { class: "error", text: `Couldn't load devices: ${e?.message || "error"}` }));
    }
  }

  private renderAddDevice(panel: HTMLElement) {
    const out = h("div", { "aria-live": "polite" });
    const make = async (role: "guest" | "display") => {
      clear(out, h("p", { class: "muted", text: "Creating a link…" }));
      try {
        const r = await this.req({ t: "links", create: { role, label: `${roleName(role)} (added from this device)` } });
        const link = r?.created || (r?.links || []).slice(-1)[0];
        if (!link?.url) throw new Error("no link returned");
        const url = new URL(link.url, location.href).href;
        clear(out, h("div", { class: "qrbox" },
          qrSvg(url, `QR code for a ${roleName(role).toLowerCase()} link`),
          h("p", { text: `Point the other device's camera at this code to open the page as ${roleArticle(role)}.` }),
          h("div", { class: "url", text: url }),
          copyBtn(url, () => this.announce("Link copied.")),
          link.expires_at ? h("p", { class: "muted", text: `This link expires ${relTime(link.expires_at, this.lang)}.` }) : null,
        ));
      } catch (e: any) {
        clear(out, h("p", { class: "error", text: `Couldn't create a link: ${e?.message || "error"}` }));
      }
    };
    clear(panel,
      h("p", { text: "Open this page on another phone, tablet or big screen." }),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", "data-role": "display", onclick: () => void make("display") }, "Big screen (display)"),
        h("button", { type: "button", class: "btn", "data-role": "guest", onclick: () => void make("guest") }, "Guest"),
      ),
      out,
      h("p", { class: "muted", text: "This page's own address (sign-in required):" }),
      h("div", { class: "url", text: location.href }),
      copyBtn(location.href, () => this.announce("Link copied.")),
    );
  }

  private renderAdopt(panel: HTMLElement) {
    const out = h("div", { "aria-live": "polite" });
    clear(panel,
      h("p", { text: "Hand this page to a new agent session. You'll get a one-time code to give to the agent." }),
      h("button", {
        type: "button", class: "btn primary", "data-action": "adopt",
        onclick: async () => {
          clear(out, h("p", { class: "muted", text: "Getting a code…" }));
          try {
            const r = await this.req({ t: "adopt_code" });
            clear(out,
              h("div", { class: "code", "aria-label": `Code ${String(r.code).split("").join(" ")}`, text: r.code }),
              h("p", { text: "Give this code to your agent. It calls POST /api/adopt with the code to take over this page. The previous agent's access ends." }),
              copyBtn(String(r.code), () => this.announce("Code copied.")),
              r.expires_at ? h("p", { class: "muted", text: `The code works once and expires ${relTime(r.expires_at, this.lang)}.` }) : null,
            );
          } catch (e: any) {
            clear(out, h("p", { class: "error", text: `Couldn't get a code: ${e?.message || "error"}` }));
          }
        },
      }, "Get a code"),
      out,
    );
  }

  private async loadAgents(panel: HTMLElement): Promise<void> {
    clear(panel, h("p", { class: "muted", text: "Loading agents…" }));
    try {
      const base = this.core.config.base + "_tendril/agents";
      const res = await fetch(base, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { agents: { name: string; last_used: number | null }[]; webhook?: { url: string } | null };
      const entries = data.agents.map((agent) => h("li", null,
        icon("device"), h("span", { class: "grow" }, agent.name,
          h("span", { class: "sub", text: agent.last_used ? `Last used ${relTime(agent.last_used, this.lang)}` : "Not used yet" })),
        h("button", { type: "button", class: "btn small danger", onclick: async () => {
          const stopped = await fetch(`${base}/${encodeURIComponent(agent.name)}/disconnect`, { method: "POST", credentials: "same-origin" });
          if (stopped.ok) { this.announce(`${agent.name} disconnected.`); await this.loadAgents(panel); }
          else this.announce(`Couldn't disconnect ${agent.name}.`);
        } }, "Disconnect agent")));
      clear(panel,
        data.webhook ? h("p", { class: "muted", text: `Webhook: ${data.webhook.url}` }) : null,
        entries.length ? h("ul", { class: "list" }, entries) : h("p", { text: "No agents are connected. The page keeps working." }));
    } catch (e: any) {
      clear(panel, h("p", { class: "error", text: `Couldn't load agents: ${e?.message || "error"}` }));
    }
  }

  private async loadGuestInvites(panel: HTMLElement): Promise<void> {
    if (this.guestPoll !== null) window.clearTimeout(this.guestPoll);
    this.guestPoll = null;
    clear(panel, h("p", { class: "muted", text: "Loading invitations…" }));
    try {
      const base = this.core.config.base + "_tendril/guests";
      const res = await fetch(base, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { guests: { account_id: string; link_id: string; email: string | null }[] };
      clear(panel, data.guests.length ? h("ul", { class: "list" }, data.guests.map((guest) => h("li", null,
        icon("device"), h("span", { class: "grow", text: guest.email ?? guest.account_id }),
        h("button", { type: "button", class: "btn small primary", onclick: async () => {
          const approved = await fetch(`${base}/${encodeURIComponent(guest.account_id)}/${encodeURIComponent(guest.link_id)}/approve`, { method: "POST", credentials: "same-origin" });
          if (approved.ok) { this.announce("Guest approved."); await this.loadGuestInvites(panel); }
          else this.announce("Couldn't approve guest.");
        } }, "Approve"),
        h("button", { type: "button", class: "btn small", onclick: async () => {
          const declined = await fetch(`${base}/${encodeURIComponent(guest.account_id)}/${encodeURIComponent(guest.link_id)}/decline`, { method: "POST", credentials: "same-origin" });
          if (declined.ok) { this.announce("Invitation declined."); await this.loadGuestInvites(panel); }
          else this.announce("Couldn't decline invitation.");
        } }, "Decline")))) : h("p", { class: "muted", text: "No guests are waiting for approval." }));
    } catch (e: any) {
      clear(panel, h("p", { class: "error", text: `Couldn't load invitations: ${e?.message || "error"}` }));
    } finally {
      this.guestPoll = window.setTimeout(() => {
        if (panel.closest("details")?.open && this.host.isConnected) void this.loadGuestInvites(panel);
        else this.guestPoll = null;
      }, 5000);
    }
  }

  private renderBudget(panel: HTMLElement) {
    const max = this.budget.page_streak ?? 6;
    const input = h("input", { type: "number", id: "tendril-b-page", min: "0", max: String(max), value: String(max), inputmode: "numeric" }) as HTMLInputElement;
    const msg = h("p", { "aria-live": "polite", class: "muted" });
    clear(panel,
      h("p", { text: "Your own messages and taps always reach the agent. The page can wake it on its own only this many times in a row; anything you say or tap resets the count. Over the limit nothing is lost: the agent sees it at its next check. You can only lower this here." }),
      h("div", { class: "field" }, h("label", { for: "tendril-b-page", text: "Page wake-ups in a row" }), input),
      h("button", {
        type: "button", class: "btn", onclick: async () => {
          const n = Math.max(0, Math.min(max, Math.floor(Number(input.value))));
          try {
            await this.req({ t: "budget", page_streak: n });
            this.budget = { page_streak: n };
            msg.textContent = "Saved.";
            this.renderBudget(panel);
            this.announce("Wake limit saved.");
          } catch (e: any) { msg.textContent = `Couldn't save: ${e?.message || "error"}`; }
        },
      }, "Lower limit"),
      msg,
    );
  }


  private async renderNotify(panel: HTMLElement) {
    const push = registry.push;
    if (!push?.available) {
      clear(panel, h("p", { class: "muted", text: "Notifications aren't available here. On iPhone and iPad they work only after adding the page to the home screen." }));
      return;
    }
    let on = false;
    try { on = await push.subscribed(); } catch { /* ignore */ }
    const msg = h("p", { class: "muted", "aria-live": "polite" });
    const box = h("input", {
      type: "checkbox", checked: on, onchange: async () => {
        const want = (box as HTMLInputElement).checked;
        try {
          if (want) { const ok = await push.subscribe(); (box as HTMLInputElement).checked = ok; msg.textContent = ok ? "Notifications are on." : "Notifications were not allowed."; }
          else { await push.unsubscribe(); msg.textContent = "Notifications are off."; }
        } catch { (box as HTMLInputElement).checked = !want; msg.textContent = "Couldn't change notifications."; }
      },
    });
    clear(panel,
      h("label", { class: "switch" }, box, "Let the agent notify this device"),
      h("p", { class: "muted", text: "For example when a job needs your decision." }),
      msg,
    );
  }
}

function roleName(r: string): string {
  return r === "owner" ? "Owner" : r === "display" ? "Display" : r === "guest" ? "Guest" : r || "Device";
}
function roleArticle(r: string): string {
  return r === "owner" ? "another owner device (it may need approval)" : r === "display" ? "a display (read-only)" : "a guest";
}
function copyBtn(text: string, done: () => void): HTMLButtonElement {
  return h("button", {
    type: "button", class: "btn small", onclick: async () => {
      try { await navigator.clipboard.writeText(text); done(); } catch { /* ignore */ }
    },
  }, "Copy");
}
