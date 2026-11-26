import type {
  PagePersonEntry,
  RuntimeApi,
  RuntimeChatActivity,
  RuntimeChatMessage,
  RuntimeChatStream,
} from "../../../contract/index.mjs";
import { btn, clearChildren, el, handleColor, iconEl, renderMentionText, setData } from "./dom";

type VoiceModule = typeof import("../voice/index");
type VoiceAdapter = ReturnType<VoiceModule["createVoice"]>;

const LANGUAGES = [
  ["en-US", "English"], ["de-DE", "Deutsch"], ["fr-FR", "Français"],
  ["es-ES", "Español"], ["it-IT", "Italiano"], ["nl-NL", "Nederlands"], ["pl-PL", "Polski"],
] as const;

const STATUS_LABELS: Record<NonNullable<RuntimeChatMessage["status"]>, string> = {
  sending: "Sending…",
  delivered: "Delivered",
  seen: "Seen",
  thinking: "Thinking…",
  answered: "Answered",
  error: "Failed",
};

export interface TalkDockState {
  unreadCount: number;
  glowing: boolean;
  recording: boolean;
  working: boolean;
  wakeActive: boolean;
  speaking: boolean;
  audioLevel: number;
  presenceStatus: "online" | "busy" | "offline" | "unknown";
  statusChip: string;
}

export interface ChatModalController {
  readonly headerExtra: HTMLElement;
  readonly headerTitle: HTMLElement;
  readonly headerSub: HTMLElement;
  readonly body: HTMLElement;
  onOpen(): void;
  onClose(): void;
  startHoldVoice(): void;
  finishHoldVoice(): void;
  cancelHoldVoice(): void;
  focusInput(): void;
  getDockState(): TalkDockState;
  dispose(): void;
}

export interface ChatModalCallbacks {
  onDockStateChange(state: TalkDockState): void;
  onOpenAgentsModal(): void;
  onOpenVoiceModal(): void;
  onRequestOpen(): void;
}

/**
 * Unified Assistant Chat Modal + Hold-to-Talk Voice Engine + Auto Chronolog Session Bridge.
 * Zero eager network fetches and zero eager voice/mic loads until explicit user interaction.
 */
export function createChatModal(api: RuntimeApi, callbacks: ChatModalCallbacks): ChatModalController {
  const pageId = api.identity?.page || api.identity?.base || "page";
  const draftKey = `tendril:utility-chat-draft:${pageId}`;
  const prefsKey = `tendril:utility-chat-voice:${pageId}`;

  let disposed = false;
  let isOpen = false;
  let rosterOpen = false;
  let configOpen = false;
  let sending = false;
  let agentsFetched = false;

  // Local voice quick-config state (only written on user change; never touches localStorage on boot)
  let autoSendVoice = true;
  let autoSpeak = false;
  let handsFreeLoop = false;
  let voiceOutputEngine: "browser" | "neural" = "browser";
  let wakePhrase = "Listen computer";
  let wakeMode: "model" | "local" | "browser" = "model";
  let speechLang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  try {
    const saved = localStorage.getItem(prefsKey);
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, unknown>;
      if (typeof parsed.autoSendVoice === "boolean") autoSendVoice = parsed.autoSendVoice;
      if (typeof parsed.autoSpeak === "boolean") autoSpeak = parsed.autoSpeak;
      if (typeof parsed.handsFreeLoop === "boolean") handsFreeLoop = parsed.handsFreeLoop;
      if (parsed.voiceOutputEngine === "browser" || parsed.voiceOutputEngine === "neural") voiceOutputEngine = parsed.voiceOutputEngine;
      if (typeof parsed.wakePhrase === "string" && parsed.wakePhrase.trim().length >= 3) wakePhrase = parsed.wakePhrase.trim();
      if (parsed.wakeMode === "model" || parsed.wakeMode === "local" || parsed.wakeMode === "browser") wakeMode = parsed.wakeMode;
      if (typeof parsed.speechLang === "string" && parsed.speechLang) speechLang = parsed.speechLang;
    }
  } catch { /* ignore */ }
  const saveVoicePrefs = () => {
    try {
      localStorage.setItem(prefsKey, JSON.stringify({ autoSendVoice, autoSpeak, handsFreeLoop, voiceOutputEngine, wakePhrase, wakeMode, speechLang }));
    } catch { /* ignore */ }
  };

  // Lazy voice adapter (never imported until trusted click/hold)
  let voiceModulePromise: Promise<VoiceModule> | null = null;
  let voice: VoiceAdapter | null = null;
  let captureState: "idle" | "working" | "recording" | "error" = "idle";
  let wakeState = "off";
  let voiceDetail = "";
  let voiceError = "";
  let speaking = false;
  let audioLevel = 0;
  let holdRecordingActive = false;
  let handsFreeTimer: ReturnType<typeof setTimeout> | null = null;
  const speechQueue: string[] = [];
  const spokenIds = new Set<string>();

  // Auto-wired Chronolog session state (used when api.application is available & no custom chat provider registered)
  let sessionMessages: RuntimeChatMessage[] = [];
  let sessionActivity: RuntimeChatActivity[] = [];
  let sessionStreams: RuntimeChatStream[] = [];
  const optimistic = new Map<string, RuntimeChatMessage>();
  let sessionAbort: AbortController | null = null;
  let sessionUnread = 0;
  let sessionSeeded = false;
  const seenSessionIds = new Set<string>();
  let localTarget: string | null | "*" = null;
  let localUserHandle = "you";
  let sessionFeedStarted = false;

  // Mention autocomplete state
  type MentionCandidate = { handle: string; kind: "agent" | "person" | "all"; badge?: string; meta?: string };
  let mentionMatches: MentionCandidate[] = [];
  let mentionIndex = 0;
  let mentionStart = -1;

  const rosterSnap = () => api.agents?.snapshot?.() ?? { primary_agent_id: null, agents: [], live: {} };
  const chatSnap = () => api.chat?.snapshot?.() ?? null;

  const currentUserHandle = () => {
    const fromStore = chatSnap()?.userHandle;
    if (fromStore && fromStore !== "you") return fromStore;
    const fromRoster = rosterSnap().viewer?.handle;
    if (fromRoster) return fromRoster;
    return localUserHandle;
  };

  const currentPeople = (): readonly PagePersonEntry[] => {
    const fromStore = chatSnap()?.people;
    if (fromStore && fromStore.length > 0) return fromStore;
    return rosterSnap().people ?? [];
  };

  const currentTarget = () => chatSnap()?.targetId ?? localTarget;
  const setTarget = (next: string | null | "*") => {
    localTarget = next;
    api.chat?.setTarget?.(next);
    renderRoster();
  };

  const effectiveMessages = (): readonly RuntimeChatMessage[] => {
    const snap = chatSnap();
    if (snap && (snap.connected || snap.messages.length > 0)) return snap.messages;
    const merged = [...sessionMessages];
    for (const item of optimistic.values()) {
      if (!merged.some(m => m.id === item.id)) merged.push(item);
    }
    return merged;
  };

  const effectiveStreams = (): readonly RuntimeChatStream[] => {
    const snap = chatSnap();
    if (snap && (snap.connected || snap.streams.length > 0)) return snap.streams;
    return sessionStreams;
  };

  const effectiveActivity = (): readonly RuntimeChatActivity[] => {
    const snap = chatSnap();
    if (snap && (snap.connected || snap.activity.length > 0)) return snap.activity;
    return sessionActivity;
  };

  const unreadCount = () => (chatSnap()?.unreadCount ?? 0) + sessionUnread;

  const presenceSummary = (): { status: "online" | "busy" | "offline" | "unknown"; label: string } => {
    const custom = chatSnap()?.presence;
    const roster = rosterSnap();
    if (roster.agents.length === 0) {
      if (custom) return { status: custom.status, label: custom.label ?? (custom.status === "online" ? "Online" : "Ready") };
      return { status: api.application?.available ? "online" : "unknown", label: api.application?.available ? "Session ready" : "No agents yet" };
    }
    const primary = roster.agents.find(a => a.id === roster.primary_agent_id || a.is_primary) ?? roster.agents[0]!;
    const target = currentTarget();
    const focused = (target && target !== "*") ? (roster.agents.find(a => a.id === target || a.public_key === target) ?? primary) : primary;
    const stateOf = (a: typeof primary): "online" | "busy" | "offline" | "unknown" => {
      if (a.kind === "hosted-mcp") return "online";
      const live = roster.live?.[a.public_key] ?? roster.live?.[a.id];
      return live?.state === "online" || live?.state === "busy" || live?.state === "offline" ? live.state : "offline";
    };
    const st = stateOf(focused);
    const othersOnline = roster.agents.filter(a => a.id !== focused.id && ["online", "busy"].includes(stateOf(a))).length;
    const word = st === "online" ? "Online" : st === "busy" ? "Thinking…" : "Offline";
    return {
      status: st,
      label: `@${focused.handle}${focused.id === roster.primary_agent_id ? " · Primary" : ""} · ${word}${othersOnline > 0 ? ` · +${othersOnline} online` : ""}`,
    };
  };

  const getDockState = (): TalkDockState => {
    const unread = unreadCount();
    const wakeActive = !["off", "paused", "error"].includes(wakeState);
    const rec = captureState === "recording";
    const work = captureState === "working";
    const pres = presenceSummary().status;
    let statusChip = "";
    if (rec) statusChip = holdRecordingActive ? "Listening… release to send" : "Listening…";
    else if (work) statusChip = voiceDetail || "Transcribing…";
    else if (wakeActive) statusChip = `Wake word: “${wakePhrase}”`;
    return {
      unreadCount: unread,
      glowing: !isOpen && unread > 0,
      recording: rec,
      working: work,
      wakeActive,
      speaking,
      audioLevel,
      presenceStatus: pres,
      statusChip,
    };
  };

  const emitDockState = () => {
    if (!disposed) callbacks.onDockStateChange(getDockState());
  };

  // ── Header elements exposed to the modal host ─────────────────────────
  const headerTitle = el("h2", "Assistant"); headerTitle.tabIndex = -1;
  const presenceBtn = btn("", "chat-presence-btn");
  presenceBtn.setAttribute("aria-expanded", "false");
  const presenceDot = el("span", undefined, "pdot");
  const presenceText = el("span", "Ready");
  presenceBtn.append(presenceDot, presenceText);
  const headerSub = presenceBtn;

  const headerExtra = el("div", undefined, "row");
  const stopSpeakBtn = btn("Stop", "btn sm danger");
  stopSpeakBtn.hidden = true;
  const speakToggleBtn = btn("", "btn icon-only");
  speakToggleBtn.setAttribute("aria-label", "Toggle spoken replies");
  speakToggleBtn.setAttribute("aria-pressed", String(autoSpeak));
  speakToggleBtn.title = "Spoken replies";
  speakToggleBtn.append(iconEl(autoSpeak ? "speakerOn" : "speakerOff"));
  const configBtn = btn("", "btn icon-only");
  configBtn.setAttribute("aria-label", "Voice and chat settings");
  configBtn.setAttribute("aria-pressed", "false");
  configBtn.title = "Voice, wake word & handle";
  configBtn.append(iconEl("settings"));
  headerExtra.append(stopSpeakBtn, speakToggleBtn, configBtn);

  // ── Modal Body ────────────────────────────────────────────────────────
  const body = el("div", undefined, "modal-body chat-body");

  // Roster popover (agents + people)
  const rosterPanel = el("div", undefined, "chat-subpanel");
  rosterPanel.hidden = true;

  // Quick Config drawer (handle, voice, wake word, spoken output)
  const configPanel = el("div", undefined, "chat-subpanel");
  configPanel.hidden = true;

  const handleField = el("div", undefined, "field");
  const handleLabel = el("label", "Your chat @handle");
  const handleRow = el("div", undefined, "row");
  const handleInput = el("input", undefined, "input");
  handleInput.type = "text"; handleInput.maxLength = 32; handleInput.placeholder = "e.g. alex";
  handleInput.setAttribute("aria-label", "Your chat handle");
  handleInput.style.flex = "1";
  const handleSaveBtn = btn("Save", "btn sm");
  handleRow.append(handleInput, handleSaveBtn);
  handleField.append(handleLabel, handleRow);

  const voiceQuickGrid = el("div", undefined, "quick-grid");
  const autoSendWrap = el("label", undefined, "switch-row");
  const autoSendCopy = el("div", undefined, "switch-copy");
  autoSendCopy.append(el("strong", "Instant voice send"), el("span", "Send right after hold-to-talk"));
  const autoSendCheck = el("input", undefined, "switch-input");
  autoSendCheck.type = "checkbox"; autoSendCheck.checked = autoSendVoice;
  autoSendWrap.append(autoSendCopy, autoSendCheck);

  const handsFreeWrap = el("label", undefined, "switch-row");
  const handsFreeCopy = el("div", undefined, "switch-copy");
  handsFreeCopy.append(el("strong", "Hands-free loop"), el("span", "Listen again after reply"));
  const handsFreeCheck = el("input", undefined, "switch-input");
  handsFreeCheck.type = "checkbox"; handsFreeCheck.checked = handsFreeLoop;
  handsFreeWrap.append(handsFreeCopy, handsFreeCheck);
  voiceQuickGrid.append(autoSendWrap, handsFreeWrap);

  const langAndTts = el("div", undefined, "quick-grid");
  const langField = el("div", undefined, "field");
  langField.append(el("label", "Speech language"));
  const langSelect = el("select", undefined, "select");
  langSelect.setAttribute("aria-label", "Speech language");
  for (const [val, text] of LANGUAGES) {
    const opt = el("option", text); opt.value = val; langSelect.append(opt);
  }
  if (!LANGUAGES.some(([tag]) => tag.toLowerCase() === speechLang.toLowerCase())) {
    const opt = el("option", speechLang); opt.value = speechLang; langSelect.append(opt);
  }
  langSelect.value = LANGUAGES.find(([tag]) => tag.toLowerCase() === speechLang.toLowerCase())?.[0] ?? speechLang;
  langField.append(langSelect);

  const ttsField = el("div", undefined, "field");
  ttsField.append(el("label", "Spoken reply voice"));
  const ttsSelect = el("select", undefined, "select");
  ttsSelect.setAttribute("aria-label", "Voice output engine");
  const ttsBrowserOpt = el("option", "Browser voice (instant)"); ttsBrowserOpt.value = "browser";
  const ttsNeuralOpt = el("option", "Neural voice (~65 MB)"); ttsNeuralOpt.value = "neural";
  ttsSelect.append(ttsBrowserOpt, ttsNeuralOpt);
  ttsSelect.value = voiceOutputEngine;
  ttsField.append(ttsSelect);
  langAndTts.append(langField, ttsField);

  const wakeBox = el("div", undefined, "card-box");
  const wakeTop = el("div", undefined, "row-between");
  const wakeStatusPill = el("span", "Off", "pill");
  wakeTop.append(el("strong", "Wake word (on-device)"), wakeStatusPill);
  const wakeFields = el("div", undefined, "quick-grid");
  const wakePhraseField = el("div", undefined, "field");
  wakePhraseField.append(el("label", "Wake phrase"));
  const wakePhraseInput = el("input", undefined, "input");
  wakePhraseInput.type = "text"; wakePhraseInput.maxLength = 64; wakePhraseInput.value = wakePhrase;
  wakePhraseInput.setAttribute("aria-label", "Wake phrase");
  wakePhraseField.append(wakePhraseInput);

  const wakeModeField = el("div", undefined, "field");
  wakeModeField.append(el("label", "Wake engine"));
  const wakeModeSelect = el("select", undefined, "select");
  wakeModeSelect.setAttribute("aria-label", "Wake engine");
  for (const [v, l] of [["model", "On-device Whistle (~18 MB)"], ["local", "Browser on-device"], ["browser", "Browser speech"]] as const) {
    const o = el("option", l); o.value = v; wakeModeSelect.append(o);
  }
  wakeModeSelect.value = wakeMode;
  wakeModeField.append(wakeModeSelect);
  wakeFields.append(wakePhraseField, wakeModeField);

  const wakeActions = el("div", undefined, "row");
  const wakeToggleBtn = btn("Start wake word", "btn sm primary");
  const fullVoiceBtn = btn("Full voice studio", "btn sm");
  wakeActions.append(wakeToggleBtn, fullVoiceBtn);
  wakeBox.append(wakeTop, el("p", "Listens only while this page is visible. Ambient audio stays on this device.", "muted"), wakeFields, wakeActions);

  configPanel.append(handleField, voiceQuickGrid, langAndTts, wakeBox);

  // Feed
  const feed = el("div", undefined, "chat-feed");
  feed.setAttribute("role", "log");
  feed.setAttribute("aria-live", "polite");

  // Agent activity backchannel
  const activityDetails = el("details", undefined, "chat-activity");
  activityDetails.hidden = true;
  const activitySummary = el("summary", "Agent activity (0)");
  const activityList = el("ul");
  activityDetails.append(activitySummary, activityList);

  // Status strip
  const statusStrip = el("div", undefined, "chat-status");
  statusStrip.hidden = true;
  const statusText = el("span");
  const statusCancel = btn("Cancel", "btn sm");
  statusCancel.hidden = true;
  statusStrip.append(statusText, statusCancel);

  // Composer
  const composer = el("div", undefined, "chat-composer");
  const mentionMenu = el("div", undefined, "mention-menu");
  mentionMenu.setAttribute("role", "listbox");
  mentionMenu.setAttribute("aria-label", "Mention an agent or person");
  mentionMenu.hidden = true;

  const targetRow = el("div", undefined, "row-between");
  const targetChip = btn("To: Primary ▾", "chip");
  const userPill = el("span", "", "pill");
  targetRow.append(targetChip, userPill);

  const composerRow = el("div", undefined, "composer-row");
  const textarea = el("textarea", undefined, "composer-input");
  textarea.rows = 1; textarea.maxLength = 8000; textarea.value = "";
  textarea.placeholder = "Message @agent or hold mic…";
  textarea.setAttribute("aria-label", "Message");
  try {
    const saved = sessionStorage.getItem(draftKey);
    if (saved) textarea.value = saved;
  } catch { /* ignore */ }

  const micBtn = btn("", "mic-btn");
  micBtn.setAttribute("aria-label", "Tap or hold to speak");
  micBtn.title = "Tap or press-and-hold to speak";
  micBtn.append(iconEl("assistant"));

  const sendBtn = btn("", "send-btn");
  sendBtn.setAttribute("aria-label", "Send message");
  sendBtn.append(iconEl("send"), el("span", "Send"));
  composerRow.append(textarea, micBtn, sendBtn);
  composer.append(mentionMenu, targetRow, composerRow);

  body.append(rosterPanel, configPanel, feed, activityDetails, statusStrip, composer);

  // ── Voice Engine (Strictly Lazy!) ─────────────────────────────────────
  const clearHandsFree = () => {
    if (handsFreeTimer !== null) { clearTimeout(handsFreeTimer); handsFreeTimer = null; }
  };

  const pumpSpeech = () => {
    if (disposed || speaking || speechQueue.length === 0 || !voice) return;
    const next = speechQueue.shift();
    if (!next) return;
    void (voice.muted ? voice.enableOutput(voiceOutputEngine) : Promise.resolve(true)).then(ok => {
      if (ok && !disposed && voice) voice.speak(next);
      else speechQueue.length = 0;
    });
  };

  const ensureVoice = async (): Promise<VoiceAdapter> => {
    if (voice) return voice;
    if (!voiceModulePromise) {
      const url = api.assetUrl("voice.mjs");
      voiceModulePromise = import(/* @vite-ignore */ url) as Promise<VoiceModule>;
    }
    const mod = await voiceModulePromise;
    if (disposed) throw new Error("Disposed");
    if (!voice) {
      voice = mod.createVoice(api, {
        consentMode: "auto",
        autoOutput: autoSpeak ? voiceOutputEngine : false,
        transcript(text) {
          if (disposed || !text.trim()) return;
          holdRecordingActive = false;
          voiceError = "";
          const canSendNow = Boolean(api.chat?.hasProvider || api.application?.available);
          if (autoSendVoice && canSendNow) {
            void sendMessage(text.trim(), "voice");
          } else {
            textarea.value = [textarea.value.trim(), text.trim()].filter(Boolean).join(" ");
            autoResize();
            try { sessionStorage.setItem(draftKey, textarea.value); } catch { /* ignore */ }
            if (!isOpen) callbacks.onRequestOpen();
            renderControls();
            textarea.focus();
          }
          emitDockState();
        },
        level(lvl) {
          if (disposed) return;
          audioLevel = lvl;
          micBtn.style.setProperty?.("--level", lvl.toFixed(3));
          emitDockState();
        },
        status(st) {
          if (disposed) return;
          if (st.kind === "capture") {
            captureState = (st.state === "recording" || st.state === "working" || st.state === "error") ? st.state : "idle";
            if (captureState !== "recording") holdRecordingActive = false;
            voiceDetail = st.message || (st.state === "recording" ? "Listening…" : "");
            if (st.state === "error") voiceError = st.message || "Voice input failed. You can type instead.";
          } else if (st.kind === "wake") {
            wakeState = st.state;
            if (st.state === "error") voiceError = st.message || "Wake word could not start.";
          } else if (st.kind === "output") {
            const wasSpeaking = speaking;
            speaking = Boolean(st.speaking);
            if (speaking) clearHandsFree();
            if (wasSpeaking && !speaking && st.completed === true) {
              if (speechQueue.length > 0 && autoSpeak) pumpSpeech();
              else if (handsFreeLoop && isOpen && document.visibilityState === "visible") {
                clearHandsFree();
                handsFreeTimer = setTimeout(() => {
                  handsFreeTimer = null;
                  if (!disposed && handsFreeLoop && isOpen && voice && !voice.listening && document.visibilityState === "visible") {
                    void voice.startCapture();
                  }
                  renderControls();
                }, 550);
              }
            }
          }
          renderControls();
          emitDockState();
        },
      });
      voice.language(speechLang);
    }
    return voice;
  };

  const startHoldVoice = () => {
    if (disposed) return;
    clearHandsFree();
    voiceError = "";
    holdRecordingActive = true;
    captureState = "working";
    voiceDetail = "Preparing microphone…";
    renderControls();
    emitDockState();
    void ensureVoice().then(v => {
      if (disposed || !holdRecordingActive) return;
      if (v.speaking) v.stop();
      return v.startCapture();
    }).catch(err => {
      holdRecordingActive = false;
      captureState = "error";
      voiceError = err instanceof Error ? err.message : "Could not start voice input.";
      renderControls();
      emitDockState();
    });
  };

  const finishHoldVoice = () => {
    if (!holdRecordingActive && captureState !== "recording") return;
    holdRecordingActive = false;
    if (captureState === "recording") voice?.finishCapture();
    else voice?.cancelCapture();
    emitDockState();
  };

  const cancelHoldVoice = () => {
    holdRecordingActive = false;
    clearHandsFree();
    voice?.cancelCapture();
    captureState = "idle";
    voiceDetail = "";
    renderControls();
    emitDockState();
  };

  // ── Auto Chronolog Session Bridge (zero-config when application installed) ──
  const parseAddressing = (text: string) => {
    const roster = rosterSnap();
    const byHandle = new Map(roster.agents.map(a => [a.handle.toLowerCase(), a]));
    const to: string[] = [];
    let broadcast = false;
    for (const m of text.matchAll(/(?:^|[\s([{"'])@([a-z][a-z0-9_-]{1,31})\b/gi)) {
      const h = (m[1] ?? "").toLowerCase();
      if (h === "all" || h === "everyone") { broadcast = true; break; }
      const hit = byHandle.get(h);
      if (hit && !to.includes(hit.public_key)) to.push(hit.public_key);
    }
    if (broadcast) return ["*"];
    if (to.length > 0) return to;
    const tgt = currentTarget();
    if (tgt === "*") return ["*"];
    if (tgt) {
      const chosen = roster.agents.find(a => a.id === tgt || a.public_key === tgt);
      if (chosen && chosen.id !== roster.primary_agent_id && !chosen.is_primary) return [chosen.public_key];
    }
    return [];
  };

  const refreshSessionFeed = async () => {
    if (disposed || !api.application?.available || api.chat?.hasProvider) return;
    try {
      const backend = api.application.backend;
      const view = await backend.readView();
      try {
        const allEvents: Array<{ id: string; operationId: string; author: string; authorTimestampMs: string; topic: string; payload: any }> = [];
        let cursor: string | undefined;
        for (let i = 0; i < 32; i++) {
          const batch = await view.readEvents({ topics: ["agent/message", "agent/receipt"], limit: 128, ...(cursor ? { cursor } : {}) });
          allEvents.push(...(batch.events as ReadonlyArray<typeof allEvents[number]>));
          if (!batch.hasMore || !batch.cursor || batch.cursor === cursor) break;
          cursor = batch.cursor;
        }
        const roster = rosterSnap();
        const byKey = new Map(roster.agents.map(a => [a.public_key, a]));
        const msgs: RuntimeChatMessage[] = [];
        const acts: RuntimeChatActivity[] = [];
        const receipts = new Map<string, string[]>();
        for (const ev of allEvents) {
          if (ev.topic === "agent/receipt" && ev.payload) {
            const k = `${ev.payload.messageAuthor}:${ev.payload.messageOperationId}`;
            const arr = receipts.get(k) ?? [];
            arr.push(String(ev.payload.state ?? "seen"));
            receipts.set(k, arr);
          }
        }
        let newlyArrived = 0;
        for (const ev of allEvents) {
          if (ev.topic !== "agent/message") continue;
          const p = ev.payload ?? {};
          const atMs = /^\d+$/.test(String(ev.authorTimestampMs ?? "")) ? Number(ev.authorTimestampMs) : undefined;
          const agent = byKey.get(ev.author);
          const toList: string[] = Array.isArray(p.to) ? p.to : [];
          const toHandles = toList.map(t => t === "*" ? "*" : (byKey.get(t)?.handle ?? t.slice(0, 8)));
          const id = ev.operationId || `${ev.author}:${ev.id}`;
          if (p.channel === "agents") {
            acts.push({ id, senderHandle: agent?.handle ?? ev.author.slice(0, 8), toHandles, text: String(p.text ?? ""), at: atMs });
            continue;
          }
          const isAgent = Boolean(agent);
          const isSelf = !isAgent && optimistic.has(id);
          const rStates = receipts.get(`${ev.author}:${ev.operationId}`) ?? [];
          const status = rStates.includes("done") ? "answered" : rStates.includes("thinking") ? "thinking" : rStates.includes("seen") ? "seen" : "delivered";
          if (!seenSessionIds.has(id)) {
            seenSessionIds.add(id);
            if (sessionSeeded && !isOpen && isAgent) newlyArrived++;
            if (isAgent && autoSpeak && sessionSeeded && String(p.text ?? "").trim() && !spokenIds.has(id)) {
              spokenIds.add(id);
              speechQueue.push(String(p.text).trim());
              pumpSpeech();
            } else if (isAgent) {
              spokenIds.add(id);
            }
          }
          msgs.push({
            id,
            role: isAgent ? "agent" : "user",
            text: String(p.text ?? ""),
            at: atMs,
            status: isAgent ? undefined : status,
            senderHandle: isAgent ? agent!.handle : (typeof p.senderHandle === "string" && p.senderHandle ? p.senderHandle : currentUserHandle()),
            senderRole: isAgent ? "agent" : (roster.viewer?.role === "guest" ? "guest" : "owner"),
            isSelf: !isAgent && (isSelf || !p.senderHandle || p.senderHandle === currentUserHandle()),
            isPrimary: isAgent ? (agent!.id === roster.primary_agent_id || agent!.is_primary) : undefined,
            toHandles: toHandles.length ? toHandles : undefined,
          });
          optimistic.delete(id);
        }
        sessionSeeded = true;
        sessionMessages = msgs;
        sessionActivity = acts;
        if (newlyArrived > 0) sessionUnread += newlyArrived;
        renderMessages();
        renderActivity();
        emitDockState();
      } finally {
        await view.release();
      }
    } catch { /* ignore transient read failures */ }
  };

  const attachAutoSession = () => {
    if (disposed || sessionFeedStarted || !api.application?.available) return;
    sessionFeedStarted = true;
    sessionAbort = new AbortController();
    const signal = sessionAbort.signal;
    void refreshSessionFeed();
    void (async () => {
      try {
        for await (const _change of api.application.backend.changes({ signal })) {
          if (disposed || signal.aborted) break;
          await refreshSessionFeed();
        }
      } catch { /* closed */ }
    })();
    if (api.signals?.available) {
      void (async () => {
        try {
          const liveStreams = new Map<string, RuntimeChatStream>();
          for await (const frame of api.signals.subscribe({ topics: ["agent/stream"], mode: "all", signal })) {
            const val = frame.payload as { handle?: string; text?: string; done?: boolean } | null;
            if (!val || typeof val !== "object") continue;
            if (val.done || !String(val.text ?? "").trim()) liveStreams.delete(frame.authorId);
            else {
              const agent = rosterSnap().agents.find(a => a.public_key === frame.authorId);
              liveStreams.set(frame.authorId, { id: frame.authorId, senderHandle: val.handle || agent?.handle, text: String(val.text).slice(0, 8000) });
            }
            sessionStreams = [...liveStreams.values()];
            renderMessages();
          }
        } catch { /* closed */ }
      })();
    }
  };

  const sendMessage = async (text: string, via: "text" | "voice") => {
    const trimmed = text.trim();
    if (!trimmed || sending || disposed) return;
    closeMentionMenu();
    sending = true;
    voiceError = "";
    if (via === "text") {
      textarea.value = "";
      autoResize();
      try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
    }
    renderControls();
    try {
      const target = currentTarget();
      const to = parseAddressing(trimmed);
      if (api.chat?.hasProvider) {
        await api.chat.send({ text: trimmed, via, target, to });
      } else if (api.application?.available) {
        const operationId = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toHandles = to.map(t => t === "*" ? "*" : (rosterSnap().agents.find(a => a.public_key === t)?.handle ?? t.slice(0, 8)));
        optimistic.set(operationId, {
          id: operationId,
          role: "user",
          text: trimmed,
          at: Date.now(),
          status: "sending",
          senderHandle: currentUserHandle(),
          senderRole: rosterSnap().viewer?.role === "guest" ? "guest" : "owner",
          isSelf: true,
          toHandles: toHandles.length ? toHandles : undefined,
        });
        renderMessages();
        const backend = api.application.backend;
        await backend.submit({
          operationId,
          program: {
            version: 3,
            steps: [{ op: "emit", topic: "agent/message", payload: { channel: "chat", to, text: trimmed.slice(0, 8000) } }],
          },
        });
        const pending = optimistic.get(operationId);
        if (pending) {
          optimistic.set(operationId, { ...pending, status: "delivered" });
          renderMessages();
        }
        await refreshSessionFeed();
      } else {
        throw new Error("No app session is connected yet. Your text is kept in the draft box.");
      }
    } catch (err) {
      if (!disposed) {
        voiceError = err instanceof Error ? err.message : "Could not send message.";
        if (via === "text" && !textarea.value) {
          textarea.value = trimmed;
          autoResize();
          try { sessionStorage.setItem(draftKey, trimmed); } catch { /* ignore */ }
        }
      }
    } finally {
      sending = false;
      renderControls();
    }
  };

  // ── Mention Autocomplete (ALL agents + ALL users + @all) ──────────────
  const allMentionCandidates = (): MentionCandidate[] => {
    const out: MentionCandidate[] = [];
    const seen = new Set<string>();
    const roster = rosterSnap();
    for (const a of roster.agents) {
      const h = a.handle.toLowerCase();
      if (seen.has(h)) continue;
      seen.add(h);
      out.push({
        handle: a.handle,
        kind: "agent",
        badge: a.id === roster.primary_agent_id || a.is_primary ? "Primary" : a.kind === "hosted-mcp" ? "MCP" : "Agent",
        meta: a.bio || undefined,
      });
    }
    for (const p of currentPeople()) {
      const h = p.handle.toLowerCase();
      if (seen.has(h)) continue;
      seen.add(h);
      out.push({
        handle: p.handle,
        kind: "person",
        badge: p.is_self ? "You" : p.role === "owner" ? "Owner" : "Guest",
        meta: "Person",
      });
    }
    const selfHandle = currentUserHandle();
    if (selfHandle && !seen.has(selfHandle.toLowerCase())) {
      seen.add(selfHandle.toLowerCase());
      out.push({ handle: selfHandle, kind: "person", badge: "You", meta: "Person" });
    }
    if (out.length > 1) {
      out.push({ handle: "all", kind: "all", badge: "Broadcast", meta: "Everyone on this page" });
    }
    return out;
  };

  const closeMentionMenu = () => {
    mentionMatches = [];
    mentionStart = -1;
    mentionMenu.hidden = true;
    clearChildren(mentionMenu);
  };

  const applyMention = (handle: string) => {
    if (mentionStart < 0) return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, mentionStart);
    const after = textarea.value.slice(caret);
    const inserted = `@${handle} `;
    textarea.value = before + inserted + after;
    const nextPos = before.length + inserted.length;
    textarea.setSelectionRange?.(nextPos, nextPos);
    closeMentionMenu();
    autoResize();
    renderControls();
    textarea.focus();
  };

  const updateMentionMenu = () => {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(before);
    if (!match) { closeMentionMenu(); return; }
    const query = (match[1] ?? "").toLowerCase();
    const candidates = allMentionCandidates().filter(item => item.handle.toLowerCase().startsWith(query));
    if (candidates.length === 0) { closeMentionMenu(); return; }
    mentionStart = caret - (match[1]?.length ?? 0) - 1;
    mentionMatches = candidates;
    mentionIndex = Math.min(mentionIndex, candidates.length - 1);
    clearChildren(mentionMenu);
    candidates.forEach((item, idx) => {
      const opt = btn("", "mention-opt");
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(idx === mentionIndex));
      const dot = el("span", undefined, "pdot");
      dot.style.background = item.kind === "all" ? "var(--t-accent)" : handleColor(item.handle, item.kind === "person");
      opt.append(dot, el("strong", `@${item.handle}`));
      if (item.badge) opt.append(el("span", item.badge, item.kind === "person" ? "pill" : "pill accent"));
      if (item.meta) opt.append(el("span", item.meta, "m-meta"));
      opt.addEventListener("mousedown", e => { e.preventDefault(); applyMention(item.handle); });
      opt.addEventListener("click", () => applyMention(item.handle));
      mentionMenu.append(opt);
    });
    mentionMenu.hidden = false;
  };

  // ── Rendering ─────────────────────────────────────────────────────────
  const autoResize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(132, Math.max(42, textarea.scrollHeight || 42))}px`;
  };

  const renderRoster = () => {
    if (disposed) return;
    const roster = rosterSnap();
    const pres = presenceSummary();
    setData(presenceDot, "status", pres.status);
    presenceText.textContent = pres.label;
    headerTitle.textContent = chatSnap()?.title || "Assistant";

    const target = currentTarget();
    const primary = roster.agents.find(a => a.id === roster.primary_agent_id || a.is_primary) ?? null;
    if (roster.agents.length === 0) {
      targetChip.textContent = "Participants ▾";
    } else if (target === "*") {
      targetChip.textContent = "To: @all ▾";
    } else if (target) {
      const hit = roster.agents.find(a => a.id === target || a.public_key === target);
      targetChip.textContent = hit ? `To: @${hit.handle}${hit.id === primary?.id ? " (Primary)" : ""} ▾` : "To: Primary ▾";
    } else if (primary) {
      targetChip.textContent = `To: @${primary.handle} (Primary) ▾`;
    } else {
      targetChip.textContent = "To: @mention an agent ▾";
    }
    userPill.textContent = `@${currentUserHandle()}`;
    handleInput.value = currentUserHandle();

    rosterPanel.hidden = !rosterOpen;
    presenceBtn.setAttribute("aria-expanded", String(rosterOpen));
    if (!rosterOpen) return;
    clearChildren(rosterPanel);

    // Agents section
    const agentsHead = el("div", undefined, "row-between");
    agentsHead.append(el("strong", `Agents (${roster.agents.length})`), (() => {
      const addBtn = btn("+ Add agent", "btn sm");
      addBtn.addEventListener("click", () => callbacks.onOpenAgentsModal());
      return addBtn;
    })());
    rosterPanel.append(agentsHead);
    if (roster.agents.length === 0) {
      rosterPanel.append(el("p", "No agents on this page yet. Add one to chat with models here.", "muted"));
    } else {
      for (const agent of roster.agents) {
        const row = el("div", undefined, "row-between");
        const left = el("div", undefined, "row");
        const dot = el("span", undefined, "pdot");
        const live = roster.live?.[agent.public_key] ?? roster.live?.[agent.id];
        setData(dot, "status", agent.kind === "hosted-mcp" ? "online" : (live?.state ?? "offline"));
        const name = el("strong", `@${agent.handle}`);
        left.append(dot, name);
        if (agent.id === primary?.id) left.append(el("span", "Primary", "pill accent"));
        if (agent.kind === "hosted-mcp") left.append(el("span", "MCP", "pill"));
        const right = el("div", undefined, "row");
        const msgBtn = btn(target === agent.id ? "Targeted" : "Message", "btn sm");
        msgBtn.disabled = target === agent.id;
        msgBtn.addEventListener("click", () => {
          setTarget(agent.id);
          rosterOpen = false;
          renderRoster();
          textarea.focus();
        });
        right.append(msgBtn);
        if (roster.can_manage && agent.id !== primary?.id) {
          const priBtn = btn("Make primary", "btn sm");
          priBtn.addEventListener("click", async () => {
            priBtn.disabled = true;
            try { await api.agents?.setPrimary?.(agent.id); setTarget(null); }
            catch (err) { voiceError = err instanceof Error ? err.message : "Could not update primary."; renderControls(); }
            finally { if (!disposed) priBtn.disabled = false; }
          });
          right.append(priBtn);
        }
        row.append(left, right);
        rosterPanel.append(row);
      }
      if (roster.agents.length > 1) {
        const allRow = el("div", undefined, "row-between");
        allRow.append(el("span", "Broadcast to every agent", "muted"));
        const allBtn = btn(target === "*" ? "Targeting @all" : "Message @all", "btn sm");
        allBtn.disabled = target === "*";
        allBtn.addEventListener("click", () => {
          setTarget("*");
          rosterOpen = false;
          renderRoster();
          textarea.focus();
        });
        allRow.append(allBtn);
        rosterPanel.append(allRow);
      }
    }

    // People section
    const people = currentPeople();
    const peopleList: PagePersonEntry[] = people.length > 0
      ? [...people]
      : [{ id: "self", handle: currentUserHandle(), role: roster.viewer?.role === "guest" ? "guest" : "owner", is_self: true }];
    rosterPanel.append(el("div", undefined, "divider"), el("strong", `People (${peopleList.length})`));
    for (const person of peopleList) {
      const row = el("div", undefined, "row-between");
      const left = el("div", undefined, "row");
      const dot = el("span", undefined, "pdot");
      dot.style.background = handleColor(person.handle, true);
      left.append(dot, el("strong", `@${person.handle}`), el("span", person.is_self ? "You" : person.role === "owner" ? "Owner" : "Guest", "pill"));
      const mentionBtn = btn("Mention", "btn sm");
      mentionBtn.addEventListener("click", () => {
        textarea.value = `${textarea.value ? textarea.value + " " : ""}@${person.handle} `;
        rosterOpen = false;
        renderRoster();
        autoResize();
        renderControls();
        textarea.focus();
      });
      row.append(left, mentionBtn);
      rosterPanel.append(row);
    }
  };

  const renderMessages = () => {
    if (disposed) return;
    const nearBottom = (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 72;
    clearChildren(feed);
    const msgs = effectiveMessages();
    const streams = effectiveStreams();
    if (msgs.length === 0 && streams.length === 0) {
      const empty = el("div", undefined, "chat-empty");
      empty.append(
        iconEl("sparkles"),
        el("strong", "Start a conversation"),
        el("p", "Type a message, use @handle to mention any agent or person, or press and hold the mic button to talk immediately.", "muted"),
      );
      feed.append(empty);
      return;
    }
    for (const msg of msgs) {
      const isSelf = msg.role === "user" && msg.isSelf !== false;
      const cls = msg.role === "system" ? "chat-msg system" : isSelf ? "chat-msg self" : "chat-msg other";
      const row = el("article", undefined, cls);
      if (msg.role !== "system") {
        const isUser = msg.role === "user";
        const displayHandle = msg.senderHandle || (isUser ? currentUserHandle() : "agent");
        const tag = el("span", undefined, "handle-tag");
        tag.style.setProperty?.("--h-color", handleColor(displayHandle, isUser));
        tag.append(el("span", `@${displayHandle}`));
        const roleChip = msg.isPrimary ? "Primary" : isSelf ? "You" : msg.senderRole === "owner" ? "Owner" : msg.senderRole === "guest" ? "Guest" : "";
        if (roleChip) tag.append(el("span", roleChip, "handle-role"));
        row.append(tag);
      }
      const bubble = el("div", undefined, "chat-bubble");
      if (typeof document.createTextNode === "function") renderMentionText(bubble, msg.text);
      else bubble.textContent = msg.text;
      row.append(bubble);
      const metaParts: string[] = [];
      if (msg.toHandles?.length) metaParts.push(`to ${msg.toHandles.map(h => h === "*" ? "@all" : `@${h}`).join(", ")}`);
      if (msg.at) metaParts.push(new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (msg.status && STATUS_LABELS[msg.status]) metaParts.push(STATUS_LABELS[msg.status]);
      if (metaParts.length) row.append(el("span", metaParts.join(" · "), "chat-meta"));
      feed.append(row);
    }
    for (const stream of streams) {
      if (!stream.text?.trim()) continue;
      const row = el("article", undefined, "chat-msg other streaming");
      const tag = el("span", undefined, "handle-tag");
      tag.style.setProperty?.("--h-color", handleColor(stream.senderHandle, false));
      tag.append(el("span", stream.senderHandle ? `@${stream.senderHandle}` : "@agent"), el("span", "Streaming", "handle-role"));
      const bubble = el("div", stream.text, "chat-bubble");
      row.append(tag, bubble, el("span", "Thinking…", "chat-meta"));
      feed.append(row);
    }
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  };

  const renderActivity = () => {
    const items = effectiveActivity();
    activityDetails.hidden = items.length === 0;
    activitySummary.textContent = `Agent activity (${items.length})`;
    clearChildren(activityList);
    for (const item of items.slice(-30)) {
      const li = el("li");
      const toStr = item.toHandles?.length ? ` → ${item.toHandles.map(h => h === "*" ? "@all" : `@${h}`).join(", ")}` : "";
      li.append(el("strong", `@${item.senderHandle}${toStr}`), el("div", item.text));
      activityList.append(li);
    }
  };

  const renderControls = () => {
    if (disposed) return;
    stopSpeakBtn.hidden = !speaking;
    speakToggleBtn.setAttribute("aria-pressed", String(autoSpeak));
    clearChildren(speakToggleBtn);
    speakToggleBtn.append(iconEl(autoSpeak ? "speakerOn" : "speakerOff"));
    configBtn.setAttribute("aria-pressed", String(configOpen));
    configPanel.hidden = !configOpen;

    setData(micBtn, "state", captureState);
    clearChildren(micBtn);
    micBtn.append(iconEl(captureState === "recording" ? "stop" : "assistant"));
    micBtn.setAttribute("aria-label", captureState === "recording" ? "Finish recording" : "Tap or hold to speak");
    sendBtn.disabled = sending || !(textarea.value ?? "").trim();

    const wakeActive = !["off", "paused", "error"].includes(wakeState);
    wakeStatusPill.textContent = wakeActive ? (wakeState === "detected" ? "Detected!" : "Listening") : wakeState === "error" ? "Error" : "Off";
    wakeStatusPill.className = wakeActive ? "pill ok" : wakeState === "error" ? "pill danger" : "pill";
    wakeToggleBtn.textContent = wakeActive ? "Stop wake word" : "Start wake word";

    if (voiceError) {
      statusStrip.hidden = false;
      statusStrip.className = "chat-status error";
      statusText.textContent = voiceError;
      statusCancel.hidden = true;
    } else if (handsFreeTimer !== null) {
      statusStrip.hidden = false;
      statusStrip.className = "chat-status";
      statusText.textContent = "Listening for follow-up…";
      statusCancel.hidden = false;
    } else if (captureState === "recording" || captureState === "working") {
      statusStrip.hidden = false;
      statusStrip.className = "chat-status";
      statusText.textContent = voiceDetail || (captureState === "recording" ? "Listening… tap Stop when done" : "Processing locally…");
      statusCancel.hidden = false;
    } else {
      statusStrip.hidden = true;
    }
  };

  // ── Event Wiring ──────────────────────────────────────────────────────
  presenceBtn.addEventListener("click", () => {
    rosterOpen = !rosterOpen;
    if (rosterOpen) configOpen = false;
    renderRoster();
    renderControls();
  });
  targetChip.addEventListener("click", () => {
    rosterOpen = !rosterOpen;
    if (rosterOpen) configOpen = false;
    renderRoster();
    renderControls();
  });
  configBtn.addEventListener("click", () => {
    configOpen = !configOpen;
    if (configOpen) rosterOpen = false;
    renderRoster();
    renderControls();
  });
  handleSaveBtn.addEventListener("click", () => {
    const cleaned = handleInput.value.trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 32);
    if (cleaned.length < 2) {
      voiceError = "Handle must be at least 2 characters (a-z, 0-9, _, -).";
      renderControls();
      return;
    }
    voiceError = "";
    localUserHandle = cleaned;
    api.chat?.setUserHandle?.(cleaned);
    renderRoster();
    renderMessages();
    renderControls();
  });
  autoSendCheck.addEventListener("change", () => { autoSendVoice = autoSendCheck.checked; saveVoicePrefs(); });
  handsFreeCheck.addEventListener("change", () => {
    handsFreeLoop = handsFreeCheck.checked;
    if (!handsFreeLoop) clearHandsFree();
    else if (!autoSpeak) {
      autoSpeak = true;
      void ensureVoice().then(v => v.enableOutput(voiceOutputEngine)).catch(() => {});
    }
    saveVoicePrefs();
    renderControls();
  });
  langSelect.addEventListener("change", () => {
    speechLang = langSelect.value;
    voice?.language(speechLang);
    saveVoicePrefs();
  });
  ttsSelect.addEventListener("change", () => {
    voiceOutputEngine = ttsSelect.value === "neural" ? "neural" : "browser";
    saveVoicePrefs();
    if (autoSpeak && voice) void voice.enableOutput(voiceOutputEngine).catch(() => {});
  });
  speakToggleBtn.addEventListener("click", async () => {
    if (autoSpeak) {
      autoSpeak = false;
      handsFreeLoop = false;
      handsFreeCheck.checked = false;
      speechQueue.length = 0;
      clearHandsFree();
      voice?.mute();
      speaking = false;
    } else {
      try {
        const v = await ensureVoice();
        autoSpeak = await v.enableOutput(voiceOutputEngine);
      } catch (err) {
        voiceError = err instanceof Error ? err.message : "Could not enable spoken replies.";
      }
    }
    saveVoicePrefs();
    renderControls();
    emitDockState();
  });
  stopSpeakBtn.addEventListener("click", () => {
    speechQueue.length = 0;
    clearHandsFree();
    voice?.stop();
    speaking = false;
    renderControls();
    emitDockState();
  });
  wakeToggleBtn.addEventListener("click", async () => {
    const active = !["off", "paused", "error"].includes(wakeState);
    if (active) {
      voice?.stopWake();
      wakeState = "off";
      renderControls();
      emitDockState();
      return;
    }
    const phrase = wakePhraseInput.value.trim().replace(/\s+/g, " ");
    if (phrase.length < 3 || phrase.split(" ").length < 2) {
      voiceError = "Choose a wake phrase with at least two words (e.g. Listen computer).";
      renderControls();
      return;
    }
    wakePhrase = phrase;
    wakeMode = (wakeModeSelect.value === "local" || wakeModeSelect.value === "browser") ? wakeModeSelect.value : "model";
    saveVoicePrefs();
    voiceError = "";
    try {
      const v = await ensureVoice();
      v.language(speechLang);
      await v.startWake({ phrase: wakePhrase, mode: wakeMode });
    } catch (err) {
      voiceError = err instanceof Error ? err.message : "Could not start wake word.";
    }
    renderControls();
    emitDockState();
  });
  fullVoiceBtn.addEventListener("click", () => callbacks.onOpenVoiceModal());
  statusCancel.addEventListener("click", cancelHoldVoice);

  // Composer Mic tap-or-hold
  let micHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let micHolding = false;
  let suppressMicClick = false;
  const toggleMic = () => {
    clearHandsFree();
    voiceError = "";
    if (voice?.speaking) voice.stop();
    if (captureState === "recording") { voice?.finishCapture(); return; }
    if (captureState === "working") { voice?.cancelCapture(); return; }
    captureState = "working";
    voiceDetail = "Preparing microphone…";
    renderControls();
    void ensureVoice().then(v => v.startCapture()).catch(err => {
      captureState = "error";
      voiceError = err instanceof Error ? err.message : "Voice input could not start.";
      renderControls();
    });
  };
  micBtn.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    micHolding = false;
    suppressMicClick = false;
    if (captureState === "idle" || captureState === "error") {
      micHoldTimer = setTimeout(() => {
        micHoldTimer = null;
        micHolding = true;
        suppressMicClick = true;
        toggleMic();
      }, 300);
    }
  });
  const endMicPtr = (e: PointerEvent) => {
    if (micHoldTimer !== null) { clearTimeout(micHoldTimer); micHoldTimer = null; }
    if (micHolding) {
      micHolding = false;
      if (e.type === "pointercancel") voice?.cancelCapture();
      else if (captureState === "recording") voice?.finishCapture();
      else voice?.cancelCapture();
    }
  };
  micBtn.addEventListener("pointerup", endMicPtr);
  micBtn.addEventListener("pointercancel", endMicPtr);
  micBtn.addEventListener("click", (e: MouseEvent) => {
    if (suppressMicClick && e.detail !== 0) { suppressMicClick = false; return; }
    suppressMicClick = false;
    toggleMic();
  });

  // Composer typing & mention navigation
  textarea.addEventListener("input", () => {
    autoResize();
    updateMentionMenu();
    try {
      if (textarea.value) sessionStorage.setItem(draftKey, textarea.value);
      else sessionStorage.removeItem(draftKey);
    } catch { /* ignore */ }
    renderControls();
  });
  textarea.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!mentionMenu.hidden && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionMatches.length; updateMentionMenu(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length; updateMentionMenu(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionMatches[mentionIndex]!.handle); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMentionMenu(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendMessage(textarea.value, "text");
    }
  });
  sendBtn.addEventListener("click", () => { void sendMessage(textarea.value, "text"); });

  // Reactive subscriptions (zero network work!)
  const offAgents = api.agents?.onChange?.(() => {
    if (disposed) return;
    renderRoster();
    renderMessages();
    emitDockState();
  }) ?? (() => {});
  const offChat = api.chat?.onChange?.(() => {
    if (disposed) return;
    if (isOpen && (api.chat?.snapshot?.().unreadCount ?? 0) > 0) {
      api.chat?.clearUnread?.();
      return;
    }
    renderRoster();
    renderMessages();
    renderActivity();
    emitDockState();
  }) ?? (() => {});
  const offAppReady = api.on?.("application_ready", () => attachAutoSession()) ?? (() => {});
  if (api.application?.available) attachAutoSession();

  renderRoster();
  renderMessages();
  renderActivity();
  renderControls();

  return {
    headerExtra,
    headerTitle,
    headerSub,
    body,
    onOpen() {
      isOpen = true;
      sessionUnread = 0;
      api.chat?.clearUnread?.();
      if (!agentsFetched && api.identity?.base && api.agents?.refresh) {
        agentsFetched = true;
        void api.agents.refresh().catch(() => { agentsFetched = false; });
      }
      renderRoster();
      renderMessages();
      renderActivity();
      renderControls();
      emitDockState();
      feed.scrollTop = feed.scrollHeight;
    },
    onClose() {
      isOpen = false;
      rosterOpen = false;
      configOpen = false;
      closeMentionMenu();
      clearHandsFree();
      renderRoster();
      renderControls();
      emitDockState();
    },
    startHoldVoice,
    finishHoldVoice,
    cancelHoldVoice,
    focusInput() { textarea.focus(); },
    getDockState,
    dispose() {
      disposed = true;
      clearHandsFree();
      if (micHoldTimer !== null) clearTimeout(micHoldTimer);
      sessionAbort?.abort();
      offAgents();
      offChat();
      offAppReady();
      voice?.dispose();
    },
  };
}
