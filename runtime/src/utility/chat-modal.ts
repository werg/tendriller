import type {
  PagePersonEntry,
  RuntimeApi,
  RuntimeChatActivity,
  RuntimeChatAttachment,
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
  delivered: "Saved locally",
  seen: "Seen by agent",
  thinking: "Thinking…",
  answered: "Answered",
  error: "Failed",
};

/** Normalize 64-char hex or 32-byte base64url/base64 Ed25519 public key to lowercase 64-char hex. */
function normalizeKeyHex(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(trimmed)) {
    try {
      const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(padded);
      if (bin.length !== 32) return null;
      let hex = "";
      for (let i = 0; i < 32; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
      return hex;
    } catch { return null; }
  }
  return null;
}

interface RetainedPendingSend {
  operationId: string;
  text: string;
  via: "text" | "voice";
  to: string[];
  createdAt: number;
}

export interface TalkDockState {
  unreadCount: number;
  glowing: boolean;
  recording: boolean;
  working: boolean;
  wakeActive: boolean;
  speaking: boolean;
  audioLevel: number;
  presenceStatus: "online" | "busy" | "offline" | "stopped" | "unknown";
  statusChip: string;
  errorMessage: string;
  talkBackAndWake: boolean;
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
  toggleDockVoice(): void;
  dismissVoiceError(): void;
  upgradeToTalkBackAndWake(): void;
  focusInput(): void;
  scrollToBottom(): void;
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
  const pendingSendKey = `tendril:utility-chat-pending:${pageId}`;
  const prefsKey = `tendril:utility-chat-voice:${pageId}`;

  let retainedPending: RetainedPendingSend | null = null;
  try {
    const rawPending = sessionStorage.getItem(pendingSendKey);
    if (rawPending) {
      const parsed = JSON.parse(rawPending) as Partial<RetainedPendingSend>;
      if (typeof parsed.operationId === "string" && parsed.operationId && typeof parsed.text === "string" && parsed.text.trim()) {
        retainedPending = {
          operationId: parsed.operationId,
          text: parsed.text.trim(),
          via: parsed.via === "voice" ? "voice" : "text",
          to: Array.isArray(parsed.to) ? parsed.to.filter((x): x is string => typeof x === "string") : [],
          createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
        };
      }
    }
  } catch { /* ignore */ }
  const persistPending = (next: RetainedPendingSend | null) => {
    retainedPending = next;
    try {
      if (next) sessionStorage.setItem(pendingSendKey, JSON.stringify(next));
      else sessionStorage.removeItem(pendingSendKey);
    } catch { /* ignore */ }
  };

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
  let outputState: "idle" | "loading" | "ready" | "error" | "speaking" = "idle";
  let outputDetail = "";
  let speaking = false;
  let audioLevel = 0;
  let holdRecordingActive = false;
  let micHolding = false;
  let pendingWakeArm = false;
  let keepWakeAfterSpeech = false;
  let wakeRearmTimer: ReturnType<typeof setTimeout> | null = null;
  let handsFreeTimer: ReturnType<typeof setTimeout> | null = null;
  const speechQueue: string[] = [];
  const spokenIds = new Set<string>();
  let pumpingSpeech = false;
  let providerSeeded = false;

  // Staged image attachments + lazy P2P ObjectURL cache (all revoked on dispose)
  interface PendingImage {
    id: string;
    file: File;
    previewUrl: string;
    name: string;
    mime: string;
    size: number;
  }
  const MAX_PENDING_IMAGES = 6;
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  let pendingImages: PendingImage[] = [];
  const imageUrlCache = new Map<string, string>();
  const ownedObjectUrls = new Set<string>();
  const imageLoadsInflight = new Map<string, Promise<string | null>>();
  const createManagedUrl = (blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    ownedObjectUrls.add(url);
    return url;
  };
  const revokeManagedUrl = (url: string) => {
    if (!ownedObjectUrls.delete(url)) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  };

  // Auto-wired Chronolog session state (used when api.application is available & no custom chat provider registered)
  let sessionMessages: RuntimeChatMessage[] = [];
  let sessionActivity: RuntimeChatActivity[] = [];
  let sessionStreams: RuntimeChatStream[] = [];
  const optimistic = new Map<string, RuntimeChatMessage>();
  const ownOperationIds = new Set<string>();
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

  const presenceSummary = (): { status: "online" | "busy" | "offline" | "stopped" | "unknown"; label: string } => {
    const custom = chatSnap()?.presence;
    const roster = rosterSnap();
    if (roster.agents.length === 0) {
      if (custom) return { status: custom.status, label: custom.label ?? (custom.status === "online" ? "Online" : "Ready") };
      return { status: api.application?.available ? "online" : "unknown", label: api.application?.available ? "Session ready" : "No agents yet" };
    }
    const primary = roster.agents.find(a => a.id === roster.primary_agent_id || a.is_primary) ?? roster.agents[0]!;
    const target = currentTarget();
    const focused = (target && target !== "*") ? (roster.agents.find(a => a.id === target || a.public_key === target) ?? primary) : primary;
    const liveOf = (a: typeof primary) => {
      const hexKey = normalizeKeyHex(a.public_key);
      return (hexKey ? roster.live?.[hexKey] : undefined) ?? roster.live?.[a.public_key] ?? roster.live?.[a.id];
    };
    const stateOf = (a: typeof primary): "online" | "busy" | "offline" | "stopped" | "unknown" => {
      if (a.kind === "hosted-mcp") return "online";
      const live = liveOf(a);
      if (live?.state === "online" || live?.state === "busy" || live?.state === "offline" || live?.state === "stopped" || live?.state === "unknown") {
        return live.state;
      }
      // Absent worker presence is distinct from confirmed offline status.
      return "unknown";
    };
    const st = stateOf(focused);
    const focusedLive = liveOf(focused);
    const othersOnline = roster.agents.filter(a => a.id !== focused.id && ["online", "busy"].includes(stateOf(a))).length;
    const word = focusedLive?.detail
      ? focusedLive.detail
      : st === "online" ? "Online"
        : st === "busy" ? "Thinking…"
          : st === "stopped" ? "Stopped"
            : st === "offline" ? "Offline"
              : "Status unknown";
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
    const willSend = autoSendVoice && Boolean(api.chat?.hasProvider || api.application?.available);
    if (rec) statusChip = holdRecordingActive
      ? (willSend ? "Listening… release to send" : "Dictating… release to review")
      : (willSend ? "Listening… tap mic to send" : "Dictating… tap mic to review");
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
      errorMessage: voiceError,
      talkBackAndWake: Boolean(autoSpeak && (keepWakeAfterSpeech || pendingWakeArm || wakeActive)),
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
  const speakToggleBtn = btn("", "voice-out-pill");
  speakToggleBtn.setAttribute("aria-label", "Toggle spoken replies");
  speakToggleBtn.setAttribute("aria-pressed", String(autoSpeak));
  speakToggleBtn.title = "Toggle spoken agent replies";
  speakToggleBtn.append(iconEl(autoSpeak ? "speakerOn" : "speakerOff"), el("span", autoSpeak ? "Voice on" : "Voice"));
  const configBtn = btn("", "btn icon-only");
  configBtn.setAttribute("aria-label", "Voice and chat settings");
  configBtn.setAttribute("aria-pressed", "false");
  configBtn.title = "Voice, wake word & handle";
  configBtn.append(iconEl("settings"));
  headerExtra.append(stopSpeakBtn, speakToggleBtn, configBtn);

  // ── Modal Body ────────────────────────────────────────────────────────
  const body = el("div", undefined, "modal-body chat-body");

  // Prominent Spoken Replies (Voice Generation) quick bar — visible when voice output is active, loading, or errored
  const voiceOutBar = el("div", undefined, "voice-out-bar");
  voiceOutBar.hidden = true;
  const voiceEngineSeg = el("div", undefined, "voice-engine-seg");
  voiceEngineSeg.setAttribute("role", "group");
  voiceEngineSeg.setAttribute("aria-label", "Spoken reply voice engine");
  const engineBrowserBtn = btn("Browser");
  engineBrowserBtn.setAttribute("aria-pressed", String(voiceOutputEngine === "browser"));
  const engineNeuralBtn = btn("Neural (~65 MB)");
  engineNeuralBtn.setAttribute("aria-pressed", String(voiceOutputEngine === "neural"));
  voiceEngineSeg.append(engineBrowserBtn, engineNeuralBtn);
  const voiceOutWakeBtn = btn("Wake word", "voice-wake-pill");
  voiceOutWakeBtn.setAttribute("aria-pressed", "false");
  voiceOutWakeBtn.title = "Listen for on-device wake phrase after replies";
  const voiceOutMsg = el("span", "", "voice-out-bar-msg");
  voiceOutMsg.setAttribute("role", "status");
  const voiceOutRetryBtn = btn("Retry", "btn sm");
  voiceOutRetryBtn.hidden = true;
  voiceOutBar.append(voiceEngineSeg, voiceOutWakeBtn, voiceOutMsg, voiceOutRetryBtn);

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

  const voiceModeField = el("div", undefined, "field");
  voiceModeField.append(el("label", "After speaking"));
  const voiceModeSeg = el("div", undefined, "seg");
  voiceModeSeg.setAttribute("role", "radiogroup");
  voiceModeSeg.setAttribute("aria-label", "Voice input mode");
  const modeSendBtn = btn("Send immediately");
  modeSendBtn.setAttribute("role", "radio");
  modeSendBtn.setAttribute("aria-checked", String(autoSendVoice));
  modeSendBtn.setAttribute("aria-selected", String(autoSendVoice));
  const modeDraftBtn = btn("Review in box");
  modeDraftBtn.setAttribute("role", "radio");
  modeDraftBtn.setAttribute("aria-checked", String(!autoSendVoice));
  modeDraftBtn.setAttribute("aria-selected", String(!autoSendVoice));
  voiceModeSeg.append(modeSendBtn, modeDraftBtn);
  voiceModeField.append(voiceModeSeg);

  const handsFreeWrap = el("label", undefined, "switch-row");
  const handsFreeCopy = el("div", undefined, "switch-copy");
  handsFreeCopy.append(el("strong", "Hands-free loop"), el("span", "Listen again after each spoken reply"));
  const handsFreeCheck = el("input", undefined, "switch-input");
  handsFreeCheck.type = "checkbox"; handsFreeCheck.checked = handsFreeLoop;
  handsFreeWrap.append(handsFreeCopy, handsFreeCheck);

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

  configPanel.append(voiceModeField, langAndTts, handsFreeWrap, wakeBox, handleField);

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
  const statusActions = el("div", undefined, "chat-status-actions");
  const statusRetry = btn("Try again", "btn sm primary");
  statusRetry.hidden = true;
  const statusCancel = btn("Cancel", "btn sm");
  statusCancel.hidden = true;
  const statusDismiss = btn("Dismiss", "btn sm");
  statusDismiss.hidden = true;
  statusActions.append(statusRetry, statusCancel, statusDismiss);
  statusStrip.append(statusText, statusActions);

  // Composer (unified, context-adaptive single-action bar — zero dead buttons)
  const composer = el("div", undefined, "chat-composer");
  const mentionMenu = el("div", undefined, "mention-menu");
  mentionMenu.setAttribute("role", "listbox");
  mentionMenu.setAttribute("aria-label", "Mention an agent or person");
  mentionMenu.hidden = true;

  const pendingAttTray = el("div", undefined, "pending-attachments");
  pendingAttTray.hidden = true;

  const imageInput = el("input");
  imageInput.type = "file";
  imageInput.accept = "image/*";
  imageInput.multiple = true;
  imageInput.hidden = true;

  const composerRow = el("div", undefined, "composer-row");
  const attachBtn = btn("", "attach-btn");
  attachBtn.setAttribute("aria-label", "Attach image");
  attachBtn.title = "Attach image (or paste/drop)";
  attachBtn.append(iconEl("image"));

  const textarea = el("textarea", undefined, "composer-input");
  textarea.rows = 1; textarea.maxLength = 8000; textarea.value = "";
  textarea.placeholder = "Message or tap mic…";
  textarea.setAttribute("aria-label", "Message");
  try {
    const saved = sessionStorage.getItem(draftKey);
    if (saved) textarea.value = saved;
  } catch { /* ignore */ }

  const micBtn = btn("", "mic-btn primary-mic");
  micBtn.setAttribute("aria-label", "Tap or hold to speak");
  micBtn.title = "Tap to speak · Hold to talk";
  micBtn.append(iconEl("mic"));

  const sendBtn = btn("", "send-btn");
  sendBtn.setAttribute("aria-label", "Send message");
  sendBtn.title = "Send message";
  sendBtn.append(iconEl("send"));
  sendBtn.hidden = true;
  composerRow.append(imageInput, attachBtn, textarea, micBtn, sendBtn);

  // Live voice capture bar (replaces composerRow while recording/transcribing)
  const voiceBar = el("div", undefined, "voice-bar");
  voiceBar.hidden = true;
  const voiceCancelBtn = btn("", "voice-cancel-btn");
  voiceCancelBtn.setAttribute("aria-label", "Cancel voice input");
  voiceCancelBtn.title = "Cancel";
  voiceCancelBtn.append(iconEl("close"));

  const voiceWaveWrap = el("div", undefined, "voice-wave-wrap");
  const voiceDot = el("span", undefined, "rec-pulse");
  const voiceMeter = el("span", undefined, "voice-meter");
  voiceMeter.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 5; i++) voiceMeter.append(el("i"));
  const voiceBarLabel = el("span", "Listening…", "voice-bar-label");
  voiceWaveWrap.append(voiceDot, voiceMeter, voiceBarLabel);

  const voiceUpgradeBtn = btn("+ Talk back & wake", "voice-upgrade-btn");
  voiceUpgradeBtn.setAttribute("aria-pressed", "false");
  voiceUpgradeBtn.title = "Switch to spoken replies and on-device wake word in the same go";

  const voiceFinishBtn = btn("", "voice-finish-btn");
  voiceFinishBtn.setAttribute("aria-label", "Stop and send voice message");
  voiceFinishBtn.append(iconEl("send"), el("span", "Send"));
  voiceBar.append(voiceCancelBtn, voiceWaveWrap, voiceUpgradeBtn, voiceFinishBtn);

  composer.append(mentionMenu, pendingAttTray, composerRow, voiceBar);

  body.append(voiceOutBar, rosterPanel, configPanel, feed, activityDetails, statusStrip, composer);

  // ── Voice Engine (Strictly Lazy!) ─────────────────────────────────────
  const clearHandsFree = () => {
    if (handsFreeTimer !== null) { clearTimeout(handsFreeTimer); handsFreeTimer = null; }
  };
  const clearWakeRearm = () => {
    if (wakeRearmTimer !== null) { clearTimeout(wakeRearmTimer); wakeRearmTimer = null; }
  };
  const armModelWakeSoon = (delayMs: number) => {
    clearWakeRearm();
    if (disposed || !keepWakeAfterSpeech) return;
    wakeRearmTimer = setTimeout(() => {
      wakeRearmTimer = null;
      if (disposed || !keepWakeAfterSpeech || speaking || captureState === "recording" || captureState === "working") return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const active = !["off", "paused", "error"].includes(wakeState);
      if (active) return;
      void ensureVoice().then(v => {
        if (disposed || !keepWakeAfterSpeech || speaking || captureState === "recording" || captureState === "working") return;
        v.language(speechLang);
        return v.startWake({ phrase: wakePhrase, mode: wakeMode });
      }).catch(err => {
        if (!disposed) {
          voiceError = err instanceof Error ? err.message : "Could not start wake word.";
          renderControls();
          emitDockState();
        }
      });
    }, delayMs);
  };

  const primeBrowserSpeech = () => {
    try {
      if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return;
      window.speechSynthesis.resume?.();
      // Unlock speechSynthesis synchronously within the user gesture (Safari/iOS/Chrome)
      const primer = new SpeechSynthesisUtterance("");
      primer.volume = 0;
      window.speechSynthesis.speak(primer);
    } catch { /* ignore */ }
  };

  const pumpSpeech = () => {
    if (disposed || speaking || pumpingSpeech || speechQueue.length === 0) return;
    const next = speechQueue.shift();
    if (!next) return;
    pumpingSpeech = true;
    void (async () => {
      try {
        const v = await ensureVoice();
        if (disposed || !autoSpeak) { speechQueue.length = 0; return; }
        const ok = v.muted ? await v.enableOutput(voiceOutputEngine) : true;
        if (ok && !disposed && autoSpeak) v.speak(next);
        else speechQueue.length = 0;
      } catch (err) {
        if (!disposed) {
          voiceError = err instanceof Error ? err.message : "Could not play spoken reply.";
          renderControls();
        }
        speechQueue.length = 0;
      } finally {
        pumpingSpeech = false;
        if (!disposed && !speaking && speechQueue.length > 0 && autoSpeak) pumpSpeech();
      }
    })();
  };

  const speakNow = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || disposed) return;
    primeBrowserSpeech();
    speechQueue.length = 0;
    voice?.stop();
    speaking = false;
    void (async () => {
      try {
        const v = await ensureVoice();
        if (disposed) return;
        const ok = v.muted ? await v.enableOutput(voiceOutputEngine) : true;
        if (ok && !disposed) v.speak(trimmed);
      } catch (err) {
        if (!disposed) {
          voiceError = err instanceof Error ? err.message : "Could not play spoken reply.";
          renderControls();
        }
      }
    })();
  };

  const syncProviderSpeech = (msgs: readonly RuntimeChatMessage[]) => {
    if (!providerSeeded) {
      providerSeeded = true;
      for (const m of msgs) {
        if (m.role === "agent") spokenIds.add(m.id);
      }
      return;
    }
    for (const m of msgs) {
      if (m.role !== "agent" || spokenIds.has(m.id)) continue;
      spokenIds.add(m.id);
      if (autoSpeak && m.text.trim()) {
        speechQueue.push(m.text.trim());
        pumpSpeech();
      }
    }
  };

  const restoreDraftWithoutOverwrite = (text: string) => {
    const piece = text.trim();
    if (!piece) return;
    const current = (textarea.value ?? "").trim();
    if (!current) textarea.value = piece;
    else if (!current.includes(piece)) textarea.value = `${current}\n${piece}`;
    autoResize();
    try { sessionStorage.setItem(draftKey, textarea.value); } catch { /* ignore */ }
  };

  const formatSendError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    const code = (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string")
      ? (err as { code: string }).code : "";
    if (/ENDPOINT_CLOSED/i.test(raw) || /ENDPOINT_CLOSED/i.test(code)) {
      return "Page session endpoint closed before delivery could be confirmed. Your message is preserved in the box below — wait for reconnection or reload before retrying.";
    }
    return raw ? `${raw} Your message is preserved in the box below.` : "Could not confirm message delivery. Your message is preserved in the box below.";
  };

  const describeDeclared = async (backend: typeof api.application.backend): Promise<{
    hasCommandList: boolean;
    hasAgentMessage: boolean;
    hasQueryList: boolean;
    hasAgentFeed: boolean;
  }> => {
    try {
      const desc = typeof backend.describe === "function" ? await Promise.resolve(backend.describe()) : null;
      if (desc && typeof desc === "object") {
        const toNames = (val: unknown): string[] | null => {
          if (Array.isArray(val)) return val.map(item => typeof item === "string" ? item : String((item as { name?: unknown })?.name ?? "")).filter(Boolean);
          if (val && typeof val === "object") return Object.keys(val);
          return null;
        };
        const commands = toNames((desc as { commands?: unknown }).commands);
        const queries = toNames((desc as { queries?: unknown }).queries);
        return {
          hasCommandList: commands !== null,
          hasAgentMessage: commands !== null && commands.includes("agentMessage"),
          hasQueryList: queries !== null,
          hasAgentFeed: queries !== null && queries.includes("agentFeed"),
        };
      }
    } catch { /* ignore describe errors and fall back cleanly */ }
    return { hasCommandList: false, hasAgentMessage: false, hasQueryList: false, hasAgentFeed: false };
  };

  const readDeclaredFeed = async (backend: typeof api.application.backend): Promise<{
    messages: Array<{
      author: string;
      operationId: string;
      eventId?: string;
      atMs?: number | null;
      channel?: string;
      to?: string[];
      text?: string;
      inReplyTo?: { author?: string; operationId?: string };
      replyToUser?: boolean;
      senderHandle?: string;
    }>;
    activity: Array<{
      author: string;
      operationId: string;
      eventId?: string;
      atMs?: number | null;
      to?: string[];
      text?: string;
      inReplyTo?: { author?: string; operationId?: string };
    }>;
    receipts: Record<string, Array<{ author?: string; state?: string }>>;
  } | null> => {
    if (typeof backend.query !== "function") return null;
    const declared = await describeDeclared(backend);
    if (declared.hasQueryList && !declared.hasAgentFeed) return null;
    try {
      const res = await backend.query("agentFeed", null);
      const val = res && typeof res === "object" && "value" in (res as Record<string, unknown>)
        ? (res as { value: unknown }).value
        : res;
      if (val && typeof val === "object" && Array.isArray((val as Record<string, unknown>).messages) && Array.isArray((val as Record<string, unknown>).activity)) {
        const obj = val as Record<string, unknown>;
        return {
          messages: obj.messages as Array<any>,
          activity: obj.activity as Array<any>,
          receipts: (obj.receipts && typeof obj.receipts === "object" ? obj.receipts : {}) as Record<string, Array<{ author?: string; state?: string }>>,
        };
      }
    } catch { /* query not declared or transiently unavailable; fall back to readEvents */ }
    return null;
  };

  const isOperationStoredLocally = async (operationId: string): Promise<boolean> => {
    if (!api.application?.available || !operationId) return false;
    try {
      const backend = api.application.backend;
      if (typeof backend.operations?.get === "function") {
        const stored = await Promise.resolve(backend.operations.get(operationId)).catch(() => null);
        if (stored) {
          const inspected = typeof stored.inspect === "function"
            ? await Promise.resolve(stored.inspect()).catch(() => null)
            : null;
          if (!inspected || inspected.stored !== false) return true;
        }
      }
      const declaredFeed = await readDeclaredFeed(backend);
      if (declaredFeed) {
        if (declaredFeed.messages.some(m => m.operationId === operationId) || declaredFeed.activity.some(a => a.operationId === operationId)) {
          return true;
        }
      }
      const view = await backend.readView();
      try {
        let cursor: string | undefined;
        for (let i = 0; i < 32; i++) {
          const batch = await view.readEvents({ topics: ["agent/message"], limit: 128, ...(cursor ? { cursor } : {}) });
          if (batch.events.some(ev => ev.operationId === operationId)) return true;
          if (!batch.hasMore || !batch.cursor || batch.cursor === cursor) break;
          cursor = batch.cursor;
        }
        return false;
      } finally {
        await view.release();
      }
    } catch {
      return false;
    }
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
          const trimmed = text.trim();
          if (disposed || !trimmed) return;
          holdRecordingActive = false;
          voiceError = "";
          const canSendNow = Boolean(api.chat?.hasProvider || api.application?.available);
          if (autoSendVoice && canSendNow && !sending) {
            void sendMessage(trimmed, "voice");
          } else {
            restoreDraftWithoutOverwrite(trimmed);
            if (sending) voiceError = "Voice transcript kept in the box while the previous message finishes.";
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
          voiceBar.style.setProperty?.("--level", lvl.toFixed(3));
          emitDockState();
        },
        status(st) {
          if (disposed) return;
          if (st.kind === "capture") {
            captureState = (st.state === "recording" || st.state === "working" || st.state === "error") ? st.state : "idle";
            if (captureState !== "recording") holdRecordingActive = false;
            voiceDetail = st.message || (st.state === "recording" ? "Listening…" : "");
            if (st.state === "error") {
              voiceError = st.message || "Voice input failed. You can type instead.";
              pendingWakeArm = false;
            } else if (captureState === "idle" && pendingWakeArm) {
              pendingWakeArm = false;
              armModelWakeSoon(350);
            }
          } else if (st.kind === "wake") {
            wakeState = st.state;
            if (st.state === "error") {
              voiceError = st.message || "Wake word could not start.";
              keepWakeAfterSpeech = false;
              pendingWakeArm = false;
            } else if (st.state === "off") {
              keepWakeAfterSpeech = false;
              pendingWakeArm = false;
            }
          } else if (st.kind === "output") {
            const wasSpeaking = speaking;
            speaking = Boolean(st.speaking);
            if (st.state === "loading" || st.state === "ready" || st.state === "error" || st.state === "speaking" || st.state === "idle") {
              outputState = st.state;
            }
            if (typeof st.message === "string" && st.message) outputDetail = st.message;
            if (speaking) { clearHandsFree(); clearWakeRearm(); }
            if (wasSpeaking && !speaking && st.completed === true) {
              if (speechQueue.length > 0 && autoSpeak) pumpSpeech();
              else if (keepWakeAfterSpeech && document.visibilityState === "visible") {
                armModelWakeSoon(450);
              } else if (handsFreeLoop && isOpen && document.visibilityState === "visible") {
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
    // Never wipe out a visible voice recognition error when the user releases the button.
    if (captureState === "error") {
      emitDockState();
      return;
    }
    if (captureState === "recording") voice?.finishCapture();
    else voice?.cancelCapture();
    emitDockState();
  };

  const cancelHoldVoice = () => {
    holdRecordingActive = false;
    pendingWakeArm = false;
    clearHandsFree();
    clearWakeRearm();
    const wakeActive = !["off", "paused", "error"].includes(wakeState);
    if (wakeActive) {
      keepWakeAfterSpeech = false;
      voice?.stopWake();
      wakeState = "off";
    }
    voice?.cancelCapture();
    captureState = "idle";
    voiceDetail = "";
    renderControls();
    emitDockState();
  };

  const dismissVoiceError = () => {
    voiceError = "";
    if (captureState === "error") captureState = "idle";
    if (outputState === "error") { outputState = "idle"; outputDetail = ""; }
    renderControls();
    emitDockState();
  };

  const upgradeToTalkBackAndWake = () => {
    if (disposed) return;
    const wakeActive = !["off", "paused", "error"].includes(wakeState);
    const alreadyUpgraded = autoSpeak && (keepWakeAfterSpeech || pendingWakeArm || wakeActive);
    if (alreadyUpgraded) {
      pendingWakeArm = false;
      keepWakeAfterSpeech = false;
      clearWakeRearm();
      if (wakeActive) {
        voice?.stopWake();
        wakeState = "off";
      }
      renderControls();
      emitDockState();
      return;
    }
    // Synchronously unlock browser speech inside the user gesture.
    primeBrowserSpeech();
    for (const m of effectiveMessages()) {
      if (m.role === "agent") spokenIds.add(m.id);
    }
    autoSpeak = true;
    wakeMode = "model";
    wakeModeSelect.value = "model";
    keepWakeAfterSpeech = true;
    voiceError = "";
    saveVoicePrefs();

    const currentlyCapturing = captureState === "recording" || captureState === "working";
    if (currentlyCapturing) {
      // Keep the active single-talk recording uninterrupted; enable spoken replies now and arm model wake word as soon as capture finishes.
      pendingWakeArm = true;
      renderControls();
      emitDockState();
      void ensureVoice().then(async v => {
        if (disposed || !autoSpeak) return;
        const ok = await v.enableOutput(voiceOutputEngine);
        if (!ok && !disposed) {
          voiceError = "Spoken replies were not enabled.";
          renderControls();
          emitDockState();
        }
      }).catch(err => {
        if (!disposed) {
          voiceError = err instanceof Error ? err.message : "Could not enable spoken replies.";
          renderControls();
          emitDockState();
        }
      });
    } else {
      pendingWakeArm = false;
      renderControls();
      emitDockState();
      void ensureVoice().then(async v => {
        if (disposed) return;
        const ok = await v.enableOutput(voiceOutputEngine);
        if (!ok && !disposed) {
          voiceError = "Spoken replies were not enabled.";
          renderControls();
          emitDockState();
          return;
        }
        if (disposed || !keepWakeAfterSpeech) return;
        v.language(speechLang);
        await v.startWake({ phrase: wakePhrase, mode: "model" });
      }).catch(err => {
        if (!disposed) {
          keepWakeAfterSpeech = false;
          voiceError = err instanceof Error ? err.message : "Could not switch to talk-back and wake word mode.";
          renderControls();
          emitDockState();
        }
      });
    }
  };

  const toggleDockVoice = () => {
    if (disposed) return;
    clearHandsFree();
    voiceError = "";
    if (voice?.speaking) voice.stop();
    if (captureState === "recording") {
      holdRecordingActive = false;
      voice?.finishCapture();
      emitDockState();
      return;
    }
    if (captureState === "working") {
      cancelHoldVoice();
      return;
    }
    holdRecordingActive = false;
    captureState = "working";
    voiceDetail = "Preparing microphone…";
    renderControls();
    emitDockState();
    void ensureVoice().then(v => {
      if (disposed || captureState !== "working") return;
      if (v.speaking) v.stop();
      return v.startCapture();
    }).catch(err => {
      captureState = "error";
      voiceError = err instanceof Error ? err.message : "Could not start voice input.";
      renderControls();
      emitDockState();
    });
  };

  // ── Auto Chronolog Session Bridge (zero-config when application installed) ──
  const parseAddressing = (text: string) => {
    const roster = rosterSnap();
    const byHandle = new Map(roster.agents.map(a => [a.handle.toLowerCase(), a]));
    const to: string[] = [];
    let broadcast = false;
    const addAgentKey = (rawKey: string | undefined) => {
      const normalized = normalizeKeyHex(rawKey);
      if (normalized && !to.includes(normalized)) to.push(normalized);
    };
    for (const m of text.matchAll(/(?:^|[\s([{"'])@([a-z][a-z0-9_-]{1,31})\b/gi)) {
      const h = (m[1] ?? "").toLowerCase();
      if (h === "all" || h === "everyone") { broadcast = true; break; }
      const hit = byHandle.get(h);
      if (hit) addAgentKey(hit.public_key);
    }
    if (broadcast) return ["*"];
    if (to.length > 0) return to;
    const tgt = currentTarget();
    if (tgt === "*") return ["*"];
    if (tgt) {
      const tgtHex = normalizeKeyHex(tgt);
      const chosen = roster.agents.find(a => a.id === tgt || a.public_key === tgt || (tgtHex && normalizeKeyHex(a.public_key) === tgtHex));
      if (chosen && chosen.id !== roster.primary_agent_id && !chosen.is_primary) {
        addAgentKey(chosen.public_key);
        return to;
      }
    }
    return [];
  };

  const refreshSessionFeed = async () => {
    if (disposed || !api.application?.available || api.chat?.hasProvider) return;
    try {
      const backend = api.application.backend;
      const roster = rosterSnap();
      const byKey = new Map<string, (typeof roster.agents)[number]>();
      for (const a of roster.agents) {
        byKey.set(a.public_key, a);
        const hexKey = normalizeKeyHex(a.public_key);
        if (hexKey) byKey.set(hexKey, a);
      }
      const selfPublicKey = normalizeKeyHex(backend.identity?.publicKey);
      const msgs: RuntimeChatMessage[] = [];
      const acts: RuntimeChatActivity[] = [];
      let newlyArrived = 0;

      const formatToHandles = (toList: readonly string[]) => toList.map(t => {
        if (t === "*") return "*";
        const hexT = normalizeKeyHex(t) ?? t;
        return byKey.get(hexT)?.handle ?? byKey.get(t)?.handle ?? t.slice(0, 8);
      });

      const parseAttachments = (rawList: unknown, rawData: unknown): RuntimeChatAttachment[] | undefined => {
        if (!Array.isArray(rawList) || rawList.length === 0) return undefined;
        let refsById: Record<string, unknown> = {};
        if (typeof rawData === "string" && rawData.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(rawData) as { attachmentRefs?: Record<string, unknown> };
            if (parsed && typeof parsed.attachmentRefs === "object" && parsed.attachmentRefs) {
              refsById = parsed.attachmentRefs;
            }
          } catch { /* ignore non-JSON data */ }
        }
        const out: RuntimeChatAttachment[] = [];
        for (const raw of rawList) {
          if (!raw || typeof raw !== "object") continue;
          const a = raw as Record<string, unknown>;
          if (typeof a.contentId !== "string" || !a.contentId) continue;
          const ref = refsById[a.contentId];
          out.push({
            contentId: a.contentId,
            name: typeof a.name === "string" && a.name ? a.name : "image",
            mime: typeof a.mime === "string" && a.mime ? a.mime : "application/octet-stream",
            ...(typeof a.size === "number" ? { size: a.size } : {}),
            ...(ref !== undefined ? { ref } : {}),
          });
        }
        return out.length ? out : undefined;
      };

      const declaredFeed = await readDeclaredFeed(backend);
      if (declaredFeed) {
        const allItems = [...declaredFeed.messages, ...declaredFeed.activity];
        const answeredKeys = new Set<string>();
        for (const item of allItems) {
          if (item.inReplyTo?.author && item.inReplyTo?.operationId && item.author !== item.inReplyTo.author) {
            answeredKeys.add(`${item.inReplyTo.author}:${item.inReplyTo.operationId}`);
          }
        }
        for (const item of declaredFeed.activity) {
          const authorHex = normalizeKeyHex(item.author) ?? item.author;
          const agent = byKey.get(authorHex) ?? byKey.get(item.author);
          const id = item.operationId || `${item.author}:${item.eventId ?? ""}`;
          acts.push({
            id,
            senderHandle: agent?.handle ?? item.author.slice(0, 8),
            toHandles: formatToHandles(Array.isArray(item.to) ? item.to : []),
            text: String(item.text ?? ""),
            at: typeof item.atMs === "number" ? item.atMs : undefined,
          });
        }
        for (const item of declaredFeed.messages) {
          const authorHex = normalizeKeyHex(item.author) ?? item.author;
          const agent = byKey.get(authorHex) ?? byKey.get(item.author);
          const toHandles = formatToHandles(Array.isArray(item.to) ? item.to : []);
          const id = item.operationId || `${item.author}:${item.eventId ?? ""}`;
          const isOwn = optimistic.has(id) || ownOperationIds.has(id) || (selfPublicKey !== null && authorHex === selfPublicKey && !agent);
          const isAgent = Boolean(agent) || item.replyToUser === true || (Boolean(item.inReplyTo) && !isOwn);
          const isSelf = !isAgent && isOwn;
          const refKey = `${item.author}:${item.operationId}`;
          const rStates = (declaredFeed.receipts[refKey] ?? [])
            .filter(r => !r.author || r.author !== item.author)
            .map(r => String(r.state ?? "seen"));
          const status = (answeredKeys.has(refKey) || rStates.includes("done")) ? "answered"
            : rStates.includes("thinking") ? "thinking"
              : rStates.includes("seen") ? "seen"
                : "delivered";
          const wasSeen = seenSessionIds.has(id);
          if (!wasSeen) {
            seenSessionIds.add(id);
            if (sessionSeeded && !isOpen && isAgent) newlyArrived++;
          }
          if (isAgent && !spokenIds.has(id)) {
            spokenIds.add(id);
            if (!wasSeen && autoSpeak && sessionSeeded && String(item.text ?? "").trim()) {
              speechQueue.push(String(item.text).trim());
              pumpSpeech();
            }
          }
          const itemAttachments = parseAttachments((item as any).attachments, (item as any).data);
          msgs.push({
            id,
            role: isAgent ? "agent" : "user",
            text: String(item.text ?? ""),
            at: typeof item.atMs === "number" ? item.atMs : undefined,
            status: isAgent ? undefined : status,
            senderHandle: isAgent ? (agent?.handle ?? (item.author ? item.author.slice(0, 8) : "agent")) : (typeof item.senderHandle === "string" && item.senderHandle ? item.senderHandle : currentUserHandle()),
            senderRole: isAgent ? "agent" : (roster.viewer?.role === "guest" ? "guest" : "owner"),
            isSelf: !isAgent && (isSelf || !item.senderHandle || item.senderHandle === currentUserHandle()),
            isPrimary: isAgent && agent ? (agent.id === roster.primary_agent_id || agent.is_primary) : undefined,
            toHandles: toHandles.length ? toHandles : undefined,
            ...(itemAttachments ? { attachments: itemAttachments } : {}),
          });
          optimistic.delete(id);
        }
      } else {
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
          const receipts = new Map<string, string[]>();
          const answeredKeys = new Set<string>();
          for (const ev of allEvents) {
            if (ev.topic === "agent/receipt" && ev.payload) {
              if (ev.author && ev.author === ev.payload.messageAuthor) continue;
              const k = `${ev.payload.messageAuthor}:${ev.payload.messageOperationId}`;
              const arr = receipts.get(k) ?? [];
              arr.push(String(ev.payload.state ?? "seen"));
              receipts.set(k, arr);
            } else if (ev.topic === "agent/message" && ev.payload?.inReplyTo?.author && ev.payload?.inReplyTo?.operationId) {
              if (ev.author !== ev.payload.inReplyTo.author) {
                answeredKeys.add(`${ev.payload.inReplyTo.author}:${ev.payload.inReplyTo.operationId}`);
              }
            }
          }
          for (const ev of allEvents) {
            if (ev.topic !== "agent/message") continue;
            const p = ev.payload ?? {};
            const atMs = /^\d+$/.test(String(ev.authorTimestampMs ?? "")) ? Number(ev.authorTimestampMs) : undefined;
            const authorHex = normalizeKeyHex(ev.author) ?? ev.author;
            const agent = byKey.get(authorHex) ?? byKey.get(ev.author);
            const toHandles = formatToHandles(Array.isArray(p.to) ? p.to : []);
            const id = ev.operationId || `${ev.author}:${ev.id}`;
            if (p.channel === "agents") {
              acts.push({ id, senderHandle: agent?.handle ?? ev.author.slice(0, 8), toHandles, text: String(p.text ?? ""), at: atMs });
              continue;
            }
            const isOwn = optimistic.has(id) || ownOperationIds.has(id) || (selfPublicKey !== null && authorHex === selfPublicKey && !agent);
            const isAgent = Boolean(agent) || p.replyToUser === true || (Boolean(p.inReplyTo) && !isOwn);
            const isSelf = !isAgent && isOwn;
            const refKey = `${ev.author}:${ev.operationId}`;
            const rStates = receipts.get(refKey) ?? [];
            const status = (answeredKeys.has(refKey) || rStates.includes("done")) ? "answered"
              : rStates.includes("thinking") ? "thinking"
                : rStates.includes("seen") ? "seen"
                  : "delivered";
            const wasSeen = seenSessionIds.has(id);
            if (!wasSeen) {
              seenSessionIds.add(id);
              if (sessionSeeded && !isOpen && isAgent) newlyArrived++;
            }
            if (isAgent && !spokenIds.has(id)) {
              spokenIds.add(id);
              if (!wasSeen && autoSpeak && sessionSeeded && String(p.text ?? "").trim()) {
                speechQueue.push(String(p.text).trim());
                pumpSpeech();
              }
            }
            const eventAttachments = parseAttachments(p.attachments, p.data);
            msgs.push({
              id,
              role: isAgent ? "agent" : "user",
              text: String(p.text ?? ""),
              at: atMs,
              status: isAgent ? undefined : status,
              senderHandle: isAgent ? (agent?.handle ?? (ev.author ? ev.author.slice(0, 8) : "agent")) : (typeof p.senderHandle === "string" && p.senderHandle ? p.senderHandle : currentUserHandle()),
              senderRole: isAgent ? "agent" : (roster.viewer?.role === "guest" ? "guest" : "owner"),
              isSelf: !isAgent && (isSelf || !p.senderHandle || p.senderHandle === currentUserHandle()),
              isPrimary: isAgent && agent ? (agent.id === roster.primary_agent_id || agent.is_primary) : undefined,
              toHandles: toHandles.length ? toHandles : undefined,
              ...(eventAttachments ? { attachments: eventAttachments } : {}),
            });
            optimistic.delete(id);
          }
        } finally {
          await view.release();
        }
      }

      const wasSeeded = sessionSeeded;
      sessionSeeded = true;
      sessionMessages = msgs;
      sessionActivity = acts;
      // Reconcile any pending send retained from before a reload or closed endpoint
      if (retainedPending && !sending) {
        if (msgs.some(m => m.id === retainedPending!.operationId) || await isOperationStoredLocally(retainedPending.operationId)) {
          persistPending(null);
        } else if (!wasSeeded) {
          restoreDraftWithoutOverwrite(retainedPending.text);
          if (!voiceError) voiceError = "Previous message was not confirmed before reload — kept in the box to review or retry.";
          renderControls();
        }
      }
      if (newlyArrived > 0) sessionUnread += newlyArrived;
      renderMessages();
      renderActivity();
      emitDockState();
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
              const authorHex = normalizeKeyHex(frame.authorId) ?? frame.authorId;
              const agent = rosterSnap().agents.find(a => a.public_key === frame.authorId || normalizeKeyHex(a.public_key) === authorHex);
              liveStreams.set(frame.authorId, { id: frame.authorId, senderHandle: val.handle || agent?.handle, text: String(val.text).slice(0, 8000) });
            }
            sessionStreams = [...liveStreams.values()];
            renderMessages();
          }
        } catch { /* closed */ }
      })();
    }
  };

  // ── Staged Image Attachments & Lazy P2P Loader ────────────────────────
  const renderPendingAttachments = () => {
    if (disposed) return;
    clearChildren(pendingAttTray);
    pendingAttTray.hidden = pendingImages.length === 0;
    for (const item of pendingImages) {
      const wrap = el("div", undefined, "pending-thumb");
      const img = el("img");
      img.src = item.previewUrl;
      img.alt = item.name;
      const rm = btn("×", "pending-thumb-rm");
      rm.setAttribute("aria-label", `Remove ${item.name}`);
      rm.title = `Remove ${item.name}`;
      rm.addEventListener("click", () => removePendingImage(item.id));
      wrap.append(img, rm);
      pendingAttTray.append(wrap);
    }
  };

  const removePendingImage = (id: string) => {
    const idx = pendingImages.findIndex(item => item.id === id);
    if (idx < 0) return;
    const [removed] = pendingImages.splice(idx, 1);
    if (removed) revokeManagedUrl(removed.previewUrl);
    renderPendingAttachments();
    renderControls();
  };

  const stageImageFiles = (list: Iterable<File> | FileList | null | undefined) => {
    if (!list || disposed) return;
    let added = 0;
    let rejectedReason = "";
    for (const file of Array.from(list)) {
      if (!file) continue;
      if (file.type && !file.type.startsWith("image/")) {
        rejectedReason = "Only image files can be attached to chat messages.";
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejectedReason = `${file.name || "Image"} is larger than 25 MB.`;
        continue;
      }
      if (pendingImages.length >= MAX_PENDING_IMAGES) {
        rejectedReason = `You can attach up to ${MAX_PENDING_IMAGES} images per message.`;
        break;
      }
      const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = createManagedUrl(file);
      pendingImages.push({
        id,
        file,
        previewUrl,
        name: file.name || `image-${pendingImages.length + 1}.png`,
        mime: file.type || "image/png",
        size: file.size,
      });
      added++;
    }
    if (rejectedReason) voiceError = rejectedReason;
    else if (added > 0 && voiceError) voiceError = "";
    renderPendingAttachments();
    renderControls();
  };

  const resolveAttachmentUrl = (att: RuntimeChatAttachment): string | null => {
    if (att.previewUrl) return att.previewUrl;
    const cached = imageUrlCache.get(att.contentId);
    if (cached) return cached;
    if (!api.application?.available || imageLoadsInflight.has(att.contentId)) return null;
    const content = api.application.backend.content;
    if (!content || (typeof content.get !== "function" && typeof content.getBlob !== "function")) return null;
    const loader = (async (): Promise<string | null> => {
      try {
        let bytes: Uint8Array | null = null;
        if (typeof content.get === "function") {
          bytes = await content.get(att.ref ?? att.contentId);
        } else if (typeof content.getBlob === "function") {
          const got: unknown = await content.getBlob(att.contentId);
          bytes = got instanceof Uint8Array
            ? got
            : (got && typeof got === "object" && "bytes" in got && (got as { bytes?: unknown }).bytes instanceof Uint8Array)
              ? (got as { bytes: Uint8Array }).bytes
              : null;
        }
        if (!bytes || disposed) return null;
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const url = createManagedUrl(new Blob([copy], { type: att.mime || "image/png" }));
        imageUrlCache.set(att.contentId, url);
        if (!disposed) renderMessages();
        return url;
      } catch {
        return null;
      } finally {
        imageLoadsInflight.delete(att.contentId);
      }
    })();
    imageLoadsInflight.set(att.contentId, loader);
    return null;
  };

  const sendMessage = async (text: string, via: "text" | "voice") => {
    const trimmed = text.trim();
    const staged = via === "text" ? [...pendingImages] : [];
    if ((!trimmed && staged.length === 0) || disposed) return;
    if (sending) {
      if (via === "voice") {
        restoreDraftWithoutOverwrite(trimmed);
        voiceError = "Voice transcript kept in the box while the previous message finishes.";
        if (!isOpen) callbacks.onRequestOpen();
        renderControls();
      }
      return;
    }
    closeMentionMenu();
    sending = true;
    voiceError = "";
    const messageText = trimmed || (staged.length === 1 ? "Sent an image" : `Sent ${staged.length} images`);
    const target = currentTarget();
    const to = parseAddressing(messageText);
    const samePending = staged.length === 0
      && retainedPending
      && retainedPending.text === messageText
      && JSON.stringify(retainedPending.to) === JSON.stringify(to);
    const operationId = samePending
      ? retainedPending!.operationId
      : (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // Persist the exact intent & operationId BEFORE submission so endpoint closure or reload never loses it.
    if (staged.length === 0) {
      persistPending({ operationId, text: messageText, via, to, createdAt: samePending ? retainedPending!.createdAt : Date.now() });
    }

    if (via === "text") {
      textarea.value = "";
      autoResize();
      try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
      if (staged.length > 0) {
        pendingImages = [];
        renderPendingAttachments();
      }
    }
    renderControls();
    try {
      if (api.chat?.hasProvider) {
        await api.chat.send({
          text: messageText,
          via,
          target,
          to,
          ...(staged.length > 0 ? { files: staged.map(s => s.file) } : {}),
        });
        for (const item of staged) revokeManagedUrl(item.previewUrl);
        persistPending(null);
      } else if (api.application?.available) {
        // Before retrying a retained operationId, inspect the local store so we never duplicate an already-stored write.
        if (samePending && await isOperationStoredLocally(operationId)) {
          persistPending(null);
          await refreshSessionFeed();
          return;
        }
        const backend = api.application.backend;
        const uploadedAttachments: RuntimeChatAttachment[] = [];
        const attachmentRefs: Record<string, unknown> = {};
        if (staged.length > 0) {
          const content = backend.content;
          if (!content || (typeof content.put !== "function" && typeof content.putBlob !== "function")) {
            throw new Error("This page session does not support image attachments yet.");
          }
          const visibility = backend.genesis?.privateLog === false ? "public" : "private";
          for (const item of staged) {
            const bytes = new Uint8Array(await item.file.arrayBuffer());
            let contentId: string;
            let ref: unknown;
            if (typeof content.put === "function") {
              const stored = await content.put(bytes, { visibility, mediaType: item.mime, deduplicate: true }) as { id?: string; hash?: string } | null;
              ref = stored;
              contentId = stored?.id || stored?.hash || item.id;
            } else {
              const stored = await content.putBlob!(bytes) as { contentId?: string } | string | null;
              contentId = typeof stored === "string" ? stored : (stored?.contentId || item.id);
              ref = contentId;
            }
            imageUrlCache.set(contentId, item.previewUrl);
            attachmentRefs[contentId] = ref;
            uploadedAttachments.push({
              contentId,
              name: item.name,
              mime: item.mime,
              size: item.size,
              previewUrl: item.previewUrl,
              ref,
            });
          }
        }
        ownOperationIds.add(operationId);
        const roster = rosterSnap();
        const toHandles = to.map(t => {
          if (t === "*") return "*";
          const hit = roster.agents.find(a => a.public_key === t || normalizeKeyHex(a.public_key) === t);
          return hit?.handle ?? t.slice(0, 8);
        });
        optimistic.set(operationId, {
          id: operationId,
          role: "user",
          text: messageText,
          at: Date.now(),
          status: "sending",
          senderHandle: currentUserHandle(),
          senderRole: roster.viewer?.role === "guest" ? "guest" : "owner",
          isSelf: true,
          toHandles: toHandles.length ? toHandles : undefined,
          ...(uploadedAttachments.length > 0 ? { attachments: uploadedAttachments } : {}),
        });
        renderMessages();
        const payload: Record<string, unknown> = {
          channel: "chat" as const,
          to,
          text: messageText.slice(0, 8000),
        };
        if (uploadedAttachments.length > 0) {
          payload.attachments = uploadedAttachments.map(({ contentId, name, mime, size }) => ({
            contentId,
            name,
            mime,
            ...(typeof size === "number" ? { size } : {}),
          }));
          const serializedRefs = JSON.stringify({ attachmentRefs });
          if (serializedRefs.length <= 16384) payload.data = serializedRefs;
        }
        const declared = await describeDeclared(backend);
        if (typeof backend.command === "function" && (declared.hasAgentMessage || !declared.hasCommandList)) {
          await backend.command("agentMessage", payload, { operationId });
        } else if (typeof backend.events?.publish === "function") {
          await backend.events.publish("agent/message", payload, { operationId });
        } else {
          await backend.submit({
            operationId,
            updates: [{ topic: "agent/message", input: payload }],
          });
        }
        persistPending(null);
        const pending = optimistic.get(operationId);
        if (pending) {
          optimistic.set(operationId, { ...pending, status: "delivered" });
          renderMessages();
        }
        await refreshSessionFeed();
      } else {
        throw new Error("No app session is connected yet.");
      }
    } catch (err) {
      optimistic.delete(operationId);
      if (!disposed) {
        // If the operation was actually accepted locally before the error, confirm instead of duplicating.
        if (!api.chat?.hasProvider && await isOperationStoredLocally(operationId)) {
          persistPending(null);
          await refreshSessionFeed();
        } else {
          voiceError = formatSendError(err);
          if (trimmed) restoreDraftWithoutOverwrite(trimmed);
          if (staged.length > 0) {
            pendingImages = [...staged, ...pendingImages].slice(0, MAX_PENDING_IMAGES);
            renderPendingAttachments();
          }
          if (!isOpen) callbacks.onRequestOpen();
          renderMessages();
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
    const target = currentTarget();
    const primary = roster.agents.find(a => a.id === roster.primary_agent_id || a.is_primary) ?? null;
    if (target === "*" && roster.agents.length > 0) {
      presenceText.textContent = `To @all · ${roster.agents.length} agents ▾`;
      textarea.placeholder = "Message @all…";
    } else if (roster.agents.length > 0) {
      presenceText.textContent = `${pres.label} ▾`;
      const focused = (target && target !== "*")
        ? (roster.agents.find(a => a.id === target || a.public_key === target) ?? primary)
        : primary;
      textarea.placeholder = focused ? `Message @${focused.handle}…` : "Message @agent…";
    } else {
      presenceText.textContent = `${pres.label} ▾`;
      textarea.placeholder = "Message or tap mic…";
    }
    headerTitle.textContent = chatSnap()?.title || "Assistant";
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
        const liveKey = normalizeKeyHex(agent.public_key);
        const live = (liveKey ? roster.live?.[liveKey] : undefined) ?? roster.live?.[agent.public_key] ?? roster.live?.[agent.id];
        const agentState = agent.kind === "hosted-mcp" ? "online" : (live?.state ?? "unknown");
        setData(dot, "status", agentState);
        const name = el("strong", `@${agent.handle}`);
        left.append(dot, name);
        if (agent.id === primary?.id) left.append(el("span", "Primary", "pill accent"));
        if (agent.kind === "hosted-mcp") left.append(el("span", "MCP", "pill"));
        else {
          const stateText = live?.detail
            ? live.detail
            : agentState === "online" ? "Online"
              : agentState === "busy" ? "Thinking…"
                : agentState === "stopped" ? "Stopped"
                  : agentState === "offline" ? "Offline"
                    : "Status unknown";
          left.append(el("span", stateText, "pill"));
        }
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
      if (msg.attachments?.length) {
        const attWrap = el("div", undefined, "chat-attachments");
        for (const att of msg.attachments) {
          const isImg = att.mime?.startsWith("image/");
          const url = isImg ? resolveAttachmentUrl(att) : null;
          if (isImg && url) {
            const link = el("a", undefined, "chat-img-link");
            link.href = url;
            link.target = "_blank";
            link.rel = "noopener";
            link.title = att.name;
            const img = el("img");
            img.src = url;
            img.alt = att.name;
            link.append(img);
            attWrap.append(link);
          } else {
            const chip = el("span", undefined, "chat-att-chip");
            chip.append(iconEl("image"), el("span", att.name || "Image"));
            attWrap.append(chip);
          }
        }
        bubble.append(attWrap);
      }
      row.append(bubble);
      const metaParts: string[] = [];
      if (msg.toHandles?.length) metaParts.push(`to ${msg.toHandles.map(h => h === "*" ? "@all" : `@${h}`).join(", ")}`);
      if (msg.at) metaParts.push(new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (msg.status && STATUS_LABELS[msg.status]) metaParts.push(STATUS_LABELS[msg.status]);
      if (metaParts.length || (msg.role === "agent" && msg.text.trim())) {
        const metaRow = el("span", metaParts.join(" · "), "chat-meta");
        if (msg.role === "agent" && msg.text.trim()) {
          const playBtn = btn("", "chat-play-btn");
          playBtn.setAttribute("aria-label", "Read reply aloud");
          playBtn.title = "Read aloud";
          playBtn.append(iconEl("speakerOn"));
          playBtn.addEventListener("click", () => speakNow(msg.text));
          metaRow.append(playBtn);
        }
        row.append(metaRow);
      }
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

  let lastVoiceFinishMode: "" | "send" | "draft" = "";
  const renderControls = () => {
    if (disposed) return;
    stopSpeakBtn.hidden = !speaking;
    speakToggleBtn.setAttribute("aria-pressed", String(autoSpeak));
    setData(speakToggleBtn, "state", outputState === "error" ? "error" : autoSpeak ? "on" : "off");
    clearChildren(speakToggleBtn);
    const speakLabel = !autoSpeak
      ? "Voice"
      : outputState === "loading"
        ? "Loading…"
        : voiceOutputEngine === "neural"
          ? "Neural"
          : "Voice on";
    speakToggleBtn.append(iconEl(autoSpeak ? "speakerOn" : "speakerOff"), el("span", speakLabel));

    const wakeActive = !["off", "paused", "error"].includes(wakeState);
    const upgraded = Boolean(autoSpeak && (keepWakeAfterSpeech || pendingWakeArm || wakeActive));
    const showVoiceOutBar = autoSpeak || outputState === "loading" || outputState === "error" || wakeActive;
    voiceOutBar.hidden = !showVoiceOutBar;
    if (showVoiceOutBar) {
      setData(voiceOutBar, "state", outputState === "error" ? "error" : outputState === "loading" ? "loading" : "ready");
      engineBrowserBtn.setAttribute("aria-pressed", String(voiceOutputEngine === "browser"));
      engineNeuralBtn.setAttribute("aria-pressed", String(voiceOutputEngine === "neural"));
      voiceOutWakeBtn.setAttribute("aria-pressed", String(wakeActive || pendingWakeArm || keepWakeAfterSpeech));
      voiceOutWakeBtn.textContent = wakeActive
        ? `Wake: “${wakePhrase}”`
        : pendingWakeArm
          ? "Wake queued"
          : "Wake word";
      if (outputState === "error") {
        voiceOutMsg.textContent = outputDetail || "Neural voice failed to load; using browser voice.";
      } else if (outputState === "loading") {
        voiceOutMsg.textContent = outputDetail || "Loading neural voice (~65 MB)…";
      } else if (speaking) {
        voiceOutMsg.textContent = voiceOutputEngine === "neural" ? "Speaking with neural voice…" : "Speaking reply…";
      } else if (wakeActive) {
        voiceOutMsg.textContent = `Listening for “${wakePhrase}” · replies spoken`;
      } else {
        voiceOutMsg.textContent = voiceOutputEngine === "neural" ? "Agent replies spoken (neural)" : "Agent replies spoken aloud";
      }
      voiceOutRetryBtn.hidden = outputState !== "error";
    }

    configBtn.setAttribute("aria-pressed", String(configOpen));
    configPanel.hidden = !configOpen;

    modeSendBtn.setAttribute("aria-checked", String(autoSendVoice));
    modeSendBtn.setAttribute("aria-selected", String(autoSendVoice));
    modeDraftBtn.setAttribute("aria-checked", String(!autoSendVoice));
    modeDraftBtn.setAttribute("aria-selected", String(!autoSendVoice));

    const hasText = Boolean((textarea.value ?? "").trim());
    const hasContent = hasText || pendingImages.length > 0;
    const voiceBusy = captureState === "recording" || captureState === "working";
    const willInstantSend = autoSendVoice && Boolean(api.chat?.hasProvider || api.application?.available);

    composerRow.hidden = voiceBusy;
    voiceBar.hidden = !voiceBusy;

    if (!voiceBusy) {
      attachBtn.disabled = sending;
      micBtn.className = hasContent ? "mic-btn" : "mic-btn primary-mic";
      micBtn.setAttribute("aria-label", hasText ? "Dictate more" : "Tap or hold to speak");
      micBtn.title = hasText ? "Dictate into draft" : (willInstantSend ? "Tap or hold to speak (sends immediately)" : "Tap or hold to dictate into box");
      sendBtn.hidden = !hasContent;
      sendBtn.disabled = sending || !hasContent;
    } else {
      setData(voiceBar, "state", captureState);
      voiceMeter.hidden = captureState !== "recording";
      voiceDot.hidden = captureState !== "recording";
      voiceFinishBtn.hidden = captureState !== "recording";
      voiceUpgradeBtn.setAttribute("aria-pressed", String(upgraded));
      voiceUpgradeBtn.textContent = upgraded ? "Talk back + wake on" : "+ Talk back & wake";
      if (captureState === "recording") {
        const mode: "send" | "draft" = willInstantSend ? "send" : "draft";
        if (mode !== lastVoiceFinishMode) {
          lastVoiceFinishMode = mode;
          clearChildren(voiceFinishBtn);
          if (mode === "send") {
            voiceFinishBtn.className = "voice-finish-btn send-mode";
            voiceFinishBtn.setAttribute("aria-label", "Stop and send voice message");
            voiceFinishBtn.title = "Stop recording and send";
            voiceFinishBtn.append(iconEl("send"), el("span", "Send"));
          } else {
            voiceFinishBtn.className = "voice-finish-btn draft-mode";
            voiceFinishBtn.setAttribute("aria-label", "Stop dictating to draft");
            voiceFinishBtn.title = "Stop recording and review in box";
            voiceFinishBtn.append(iconEl("check"), el("span", "Done"));
          }
        }
        voiceBarLabel.textContent = (micHolding || holdRecordingActive)
          ? (willInstantSend ? "Release to send" : "Release to review")
          : (willInstantSend ? "Listening…" : "Dictating to box…");
      } else {
        voiceBarLabel.textContent = voiceDetail || "Transcribing locally…";
      }
    }

    wakeStatusPill.textContent = wakeActive ? (wakeState === "detected" ? "Detected!" : "Listening") : wakeState === "error" ? "Error" : "Off";
    wakeStatusPill.className = wakeActive ? "pill ok" : wakeState === "error" ? "pill danger" : "pill";
    wakeToggleBtn.textContent = wakeActive ? "Stop wake word" : "Start wake word";

    if (voiceError) {
      statusStrip.hidden = false;
      statusStrip.className = "chat-status error";
      statusStrip.setAttribute("role", "alert");
      statusText.textContent = voiceError;
      statusRetry.hidden = captureState !== "error";
      statusCancel.hidden = true;
      statusDismiss.hidden = false;
    } else if (handsFreeTimer !== null) {
      statusStrip.hidden = false;
      statusStrip.className = "chat-status";
      statusStrip.setAttribute("role", "status");
      statusText.textContent = "Listening for follow-up…";
      statusRetry.hidden = true;
      statusCancel.hidden = false;
      statusDismiss.hidden = true;
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
  const setVoiceMode = (instant: boolean) => {
    autoSendVoice = instant;
    saveVoicePrefs();
    renderControls();
    emitDockState();
  };
  modeSendBtn.addEventListener("click", () => setVoiceMode(true));
  modeDraftBtn.addEventListener("click", () => setVoiceMode(false));
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
  const setOutputEngine = async (engine: "browser" | "neural") => {
    voiceOutputEngine = engine;
    ttsSelect.value = engine;
    saveVoicePrefs();
    if (engine === "browser") primeBrowserSpeech();
    if (autoSpeak) {
      outputState = engine === "neural" ? "loading" : "ready";
      outputDetail = engine === "neural" ? "Loading neural voice (~65 MB)…" : "";
      renderControls();
      try {
        const v = await ensureVoice();
        const ok = await v.enableOutput(engine);
        if (!ok && !disposed) voiceError = "Spoken replies were not enabled.";
      } catch (err) {
        if (!disposed) {
          outputState = "error";
          outputDetail = err instanceof Error ? err.message : "Could not switch voice engine.";
          voiceError = outputDetail;
        }
      }
    }
    renderControls();
    emitDockState();
  };
  ttsSelect.addEventListener("change", () => {
    void setOutputEngine(ttsSelect.value === "neural" ? "neural" : "browser");
  });
  engineBrowserBtn.addEventListener("click", () => { void setOutputEngine("browser"); });
  engineNeuralBtn.addEventListener("click", () => { void setOutputEngine("neural"); });
  voiceOutWakeBtn.addEventListener("click", () => upgradeToTalkBackAndWake());
  voiceOutRetryBtn.addEventListener("click", () => { void setOutputEngine(voiceOutputEngine); });
  voiceUpgradeBtn.addEventListener("click", () => upgradeToTalkBackAndWake());

  // Image attachment picker, paste, and drag-and-drop
  attachBtn.addEventListener("click", () => { imageInput.click(); });
  imageInput.addEventListener("change", () => {
    stageImageFiles(imageInput.files);
    imageInput.value = "";
  });
  textarea.addEventListener("paste", (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      stageImageFiles(files);
    }
  });
  let dragDepth = 0;
  body.addEventListener("dragenter", (e: DragEvent) => {
    if (e.dataTransfer?.types && !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    body.classList?.add("drag-over");
  });
  body.addEventListener("dragover", (e: DragEvent) => {
    if (e.dataTransfer?.types && !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
  });
  body.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) body.classList?.remove("drag-over");
  });
  body.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    dragDepth = 0;
    body.classList?.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) stageImageFiles(files);
  });
  speakToggleBtn.addEventListener("click", async () => {
    if (autoSpeak) {
      autoSpeak = false;
      handsFreeLoop = false;
      handsFreeCheck.checked = false;
      keepWakeAfterSpeech = false;
      pendingWakeArm = false;
      speechQueue.length = 0;
      clearHandsFree();
      clearWakeRearm();
      voice?.mute();
      speaking = false;
      outputState = "idle";
      outputDetail = "";
    } else {
      // Unlock Web Speech synchronously in the click gesture before async dynamic import
      primeBrowserSpeech();
      // Mark already-displayed replies as seen so toggling on only speaks new replies
      for (const m of effectiveMessages()) {
        if (m.role === "agent") spokenIds.add(m.id);
      }
      voiceError = "";
      outputState = voiceOutputEngine === "neural" ? "loading" : "ready";
      outputDetail = voiceOutputEngine === "neural" ? "Loading neural voice (~65 MB)…" : "";
      renderControls();
      try {
        const v = await ensureVoice();
        autoSpeak = await v.enableOutput(voiceOutputEngine);
        if (!autoSpeak) voiceError = "Spoken replies were not enabled.";
      } catch (err) {
        outputState = "error";
        outputDetail = err instanceof Error ? err.message : "Could not enable spoken replies.";
        voiceError = outputDetail;
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
  statusRetry.addEventListener("click", () => toggleMic());
  statusCancel.addEventListener("click", cancelHoldVoice);
  statusDismiss.addEventListener("click", dismissVoiceError);

  // Composer Mic tap-or-hold + unified live Voice Bar actions
  let micHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressMicClick = false;
  const toggleMic = () => {
    clearHandsFree();
    voiceError = "";
    if (voice?.speaking) voice.stop();
    if (captureState === "recording") { voice?.finishCapture(); return; }
    if (captureState === "working") { cancelHoldVoice(); return; }
    captureState = "working";
    voiceDetail = "Preparing microphone…";
    renderControls();
    emitDockState();
    void ensureVoice().then(v => {
      if (disposed || captureState !== "working") return;
      return v.startCapture();
    }).catch(err => {
      captureState = "error";
      voiceError = err instanceof Error ? err.message : "Voice input could not start.";
      renderControls();
      emitDockState();
    });
  };
  const detachMicPtr = () => {
    window.removeEventListener("pointerup", endMicPtr);
    window.removeEventListener("pointercancel", endMicPtr);
  };
  const endMicPtr = (e: PointerEvent) => {
    detachMicPtr();
    if (micHoldTimer !== null) { clearTimeout(micHoldTimer); micHoldTimer = null; }
    if (micHolding) {
      micHolding = false;
      if (captureState === "error") {
        renderControls();
        return;
      }
      if (e.type === "pointercancel") cancelHoldVoice();
      else if (captureState === "recording") voice?.finishCapture();
      else cancelHoldVoice();
      renderControls();
    }
  };
  micBtn.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    micHolding = false;
    suppressMicClick = false;
    if (captureState === "idle" || captureState === "error") {
      window.addEventListener("pointerup", endMicPtr);
      window.addEventListener("pointercancel", endMicPtr);
      micHoldTimer = setTimeout(() => {
        micHoldTimer = null;
        micHolding = true;
        suppressMicClick = true;
        toggleMic();
      }, 300);
    }
  });
  micBtn.addEventListener("click", (e: MouseEvent) => {
    if (suppressMicClick && e.detail !== 0) { suppressMicClick = false; return; }
    suppressMicClick = false;
    toggleMic();
  });
  voiceCancelBtn.addEventListener("click", () => cancelHoldVoice());
  voiceFinishBtn.addEventListener("click", () => {
    micHolding = false;
    holdRecordingActive = false;
    if (captureState === "recording") voice?.finishCapture();
  });

  // Composer typing & mention navigation
  textarea.addEventListener("input", () => {
    autoResize();
    updateMentionMenu();
    if (retainedPending && textarea.value.trim() !== retainedPending.text) {
      persistPending(null);
    }
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
    if (sessionFeedStarted && !api.chat?.hasProvider) void refreshSessionFeed();
    renderRoster();
    renderMessages();
    emitDockState();
  }) ?? (() => {});
  const offChat = api.chat?.onChange?.(() => {
    if (disposed) return;
    const snap = api.chat?.snapshot?.();
    if (snap) syncProviderSpeech(snap.messages);
    if (isOpen && (snap?.unreadCount ?? 0) > 0) {
      api.chat?.clearUnread?.();
      return;
    }
    renderRoster();
    renderMessages();
    renderActivity();
    emitDockState();
  }) ?? (() => {});
  const initialChat = chatSnap();
  if (initialChat && initialChat.messages.length > 0) syncProviderSpeech(initialChat.messages);
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
    toggleDockVoice,
    dismissVoiceError,
    upgradeToTalkBackAndWake,
    focusInput() { textarea.focus(); },
    scrollToBottom() { feed.scrollTop = feed.scrollHeight; },
    getDockState,
    dispose() {
      disposed = true;
      clearHandsFree();
      clearWakeRearm();
      detachMicPtr();
      if (micHoldTimer !== null) clearTimeout(micHoldTimer);
      sessionAbort?.abort();
      offAgents();
      offChat();
      offAppReady();
      voice?.dispose();
      for (const url of [...ownedObjectUrls]) revokeManagedUrl(url);
      imageUrlCache.clear();
      pendingImages = [];
    },
  };
}
