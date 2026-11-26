import type { RuntimeApi } from "../../../contract/index.mjs";
import { createVoice, type VoiceConsentMode, type VoiceStatus } from "./index";
import { utilityBottom, utilityRight } from "../utility-layout";

export interface AgentChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  at?: number;
  status?: "sending" | "delivered" | "seen" | "thinking" | "answered" | "error";
  contextLabel?: string;
  senderHandle?: string;
  senderId?: string;
  isPrimary?: boolean;
  toHandles?: string[];
  actions?: Array<{ id: string; label: string; primary?: boolean }>;
}

export interface AgentChatStreamingEntry {
  id: string;
  senderHandle?: string;
  text: string;
}

export interface AgentChatActivityItem {
  id: string;
  senderHandle: string;
  toHandles?: string[];
  text: string;
  at?: number;
}

export interface AgentChatRosterItem {
  id: string;
  handle: string;
  bio?: string;
  publicKey: string;
  kind?: "workspace" | "hosted-mcp";
  isPrimary?: boolean;
  state: "online" | "busy" | "offline" | "stopped" | "unknown";
  enrolled?: boolean;
}

export interface AgentChatRosterState {
  primaryId: string | null;
  agents: readonly AgentChatRosterItem[];
  targetId?: string | null | "*";
  canSetPrimary?: boolean;
}

export interface AgentChatBanner {
  kind?: "warning" | "info";
  message: string;
  actions?: Array<{ id: string; label: string; primary?: boolean }>;
  onAction?(actionId: string): void | Promise<void>;
  onDismiss?(): void;
}

export interface AgentChatPresence {
  status: "online" | "busy" | "offline" | "unknown";
  label?: string;
}

export interface AgentChatContext {
  label: string;
  data?: unknown;
}

export interface AgentChatOptions {
  container?: HTMLElement;
  title?: string;
  placeholder?: string;
  messages?: AgentChatMessage[];
  onSend(input: { text: string; via: "text" | "voice"; context?: unknown; target?: string | null | "*" }): void | Promise<void>;
  onAction?(action: { messageId: string; actionId: string; label: string }): void | Promise<void>;
  onAttach?(file: File): void | Promise<void>;
  onSelectTarget?(target: string | null | "*"): void;
  onSetPrimary?(agentId: string | null): void | Promise<void>;
  /** Defaults to "auto" so 1-tap mic & speaker work immediately (browser permission is consent). */
  consentMode?: VoiceConsentMode;
  /** Send voice transcripts immediately (default true; user can toggle "Review voice"). */
  autoSendVoice?: boolean;
  /** Spoken reply engine ("browser" | "neural" | false). Defaults to "browser". */
  voiceOutput?: "browser" | "neural" | false;
  /** Automatically speak newly arriving agent replies. Defaults to false. */
  autoSpeak?: boolean;
  /** Re-open microphone after a spoken agent reply finishes (toggleable). Defaults to false. */
  handsFreeLoop?: boolean;
  language?: string;
  /** "embedded" fills container; "drawer" is a collapsible side/bottom sheet; "dock" adds a floating button. */
  layout?: "embedded" | "drawer" | "dock";
  open?: boolean;
  presence?: AgentChatPresence;
  /** Automatically prefill composer / attach files from OS Web Share Target payloads (default true). Never auto-sends. */
  consumeShares?: boolean;
}

export interface AgentChatHandle {
  readonly voice: ReturnType<typeof createVoice>;
  readonly element: HTMLElement;
  setMessages(messages: AgentChatMessage[]): void;
  setStreamingReply(text: string | null): void;
  setStreamingReplies(entries: AgentChatStreamingEntry[]): void;
  setRoster(roster: AgentChatRosterState): void;
  setActivity(items: AgentChatActivityItem[]): void;
  setBanner(banner: AgentChatBanner | null): void;
  setPresence(presence: AgentChatPresence): void;
  setContext(context: AgentChatContext | null): void;
  speak(text: string): void;
  stopSpeaking(): void;
  open(): void;
  close(): void;
  toggle(): void;
  focus(): void;
  dispose(): void;
}

const STATUS_LABELS: Record<NonNullable<AgentChatMessage["status"]>, string> = {
  sending: "Sending…",
  delivered: "Delivered",
  seen: "Seen",
  thinking: "Thinking…",
  answered: "Answered",
  error: "Failed",
};

const HANDLE_COLORS = [
  "#1e644a", "#2563eb", "#7c3aed", "#c2410c", "#0f766e", "#be123c", "#4338ca", "#047857",
];

function handleColor(handle?: string): string {
  if (!handle) return HANDLE_COLORS[0]!;
  let hash = 0;
  for (let i = 0; i < handle.length; i++) hash = ((hash << 5) - hash + handle.charCodeAt(i)) | 0;
  return HANDLE_COLORS[Math.abs(hash) % HANDLE_COLORS.length]!;
}

const HOLD_THRESHOLD_MS = 350;

export function mountAgentChat(runtime: RuntimeApi, options: AgentChatOptions): AgentChatHandle {
  if (typeof options?.onSend !== "function") throw new TypeError("mountAgentChat requires an onSend callback");

  const layout = options.layout ?? (options.container ? "embedded" : "dock");
  const consentMode: VoiceConsentMode = options.consentMode ?? "auto";
  const outputEngine: "browser" | "neural" | false = options.voiceOutput === false ? false : (options.voiceOutput ?? "browser");
  const draftKey = `tendril:chat-draft:${runtime.identity.page}`;

  const host = document.createElement("tendril-agent-chat");
  if (layout === "embedded") {
    host.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;min-height:320px;max-width:100%;";
  } else {
    host.style.cssText = `position:fixed;right:${utilityRight};bottom:calc(${utilityBottom} + var(--tendril-utility-height,54px) + 10px + var(--tendril-keyboard-height,0px));z-index:2147483645;display:flex;flex-direction:column;align-items:flex-end;pointer-events:none;`;
  }

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial;color-scheme:light dark;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:CanvasText}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,textarea,input{font:inherit;color:inherit}
    button{cursor:pointer;touch-action:manipulation;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:10px;background:Canvas;min-height:38px;padding:6px 11px;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .12s,border-color .12s,transform .1s}
    button:hover:not(:disabled){background:color-mix(in srgb,Canvas 90%,CanvasText)}
    button:disabled{opacity:.55;cursor:default}
    button:focus-visible,textarea:focus-visible{outline:2px solid Highlight;outline-offset:2px}
    .launcher{pointer-events:auto;min-height:46px;padding:0 16px;border-radius:999px;background:#1e644a;color:#fff;border-color:#1e644a;font-weight:650;box-shadow:0 6px 24px #0003}
    .launcher:hover:not(:disabled){background:#174d39}
    .shell{pointer-events:auto;position:relative;display:flex;flex-direction:column;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:16px;overflow:hidden;min-height:0}
    .shell.embedded{width:100%;height:100%;flex:1}
    .shell.drawer{width:min(420px,calc(100vw - 20px));height:min(640px,calc(var(--tendril-viewport-height,100dvh) - 110px));max-height:calc(var(--tendril-viewport-height,100dvh) - 24px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));box-shadow:0 10px 36px #0003;margin-bottom:8px}
    .header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent);background:color-mix(in srgb,Canvas 96%,CanvasText)}
    .title-group{display:flex;flex-direction:column;min-width:0;align-items:flex-start}
    .title{font-weight:700;font-size:15px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
    .presence-btn{border:0;background:transparent;padding:2px 4px;margin:-2px -4px;min-height:24px;border-radius:8px;justify-content:flex-start;max-width:100%}
    .presence{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pdot{width:8px;height:8px;border-radius:50%;background:#888;flex:none}
    .pdot[data-status="online"]{background:#1f8b4c}
    .pdot[data-status="busy"]{background:#d9822b}
    .pdot[data-status="offline"],.pdot[data-status="stopped"]{background:#b72222}
    .header-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end}
    .pill{min-height:32px;padding:4px 9px;font-size:12px;border-radius:999px;font-weight:600}
    .pill[aria-pressed="true"]{background:#1e644a;color:#fff;border-color:#1e644a}
    .stop-speak{background:#a32020;color:#fff;border-color:#a32020}
    .stop-speak:hover:not(:disabled){background:#881818}
    .close-btn{min-width:34px;min-height:34px;padding:0;border:0;font-size:20px;line-height:1}
    .roster-popover{border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent);background:color-mix(in srgb,Canvas 95%,CanvasText);padding:10px 12px;display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto}
    .roster-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
    .roster-info{display:flex;flex-direction:column;min-width:0}
    .roster-name{display:flex;align-items:center;gap:6px;font-weight:650}
    .roster-bio{opacity:.75;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .roster-btns{display:flex;gap:4px;flex:none}
    .roster-btns button{min-height:28px;padding:2px 8px;font-size:11px;border-radius:999px}
    .banner{padding:9px 12px;font-size:12px;display:flex;flex-direction:column;gap:7px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent);background:color-mix(in srgb,#d9822b 14%,Canvas)}
    .banner[data-kind="info"]{background:color-mix(in srgb,#1e644a 12%,Canvas)}
    .banner-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
    .banner-actions{display:flex;flex-wrap:wrap;gap:6px}
    .banner-actions button{min-height:30px;padding:3px 10px;font-size:12px;border-radius:999px}
    .banner-actions button.primary{background:#1e644a;color:#fff;border-color:#1e644a}
    .banner-dismiss{border:0;min-width:26px;min-height:26px;padding:0;font-size:16px;background:transparent}
    .feed{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px;display:flex;flex-direction:column;gap:10px}
    .empty{margin:auto;text-align:center;max-width:280px;opacity:.75;font-size:13px;padding:18px 8px}
    .msg{display:flex;flex-direction:column;max-width:88%;gap:3px}
    .msg.user{align-self:flex-end;align-items:flex-end}
    .msg.agent{align-self:flex-start;align-items:flex-start}
    .msg.system{align-self:center;align-items:center;max-width:96%}
    .sender-tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--agent-color,#1e644a) 14%,Canvas);color:var(--agent-color,#1e644a)}
    .sender-tag .p-chip{font-size:10px;font-weight:600;opacity:.85}
    .bubble{padding:9px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
    .msg.user .bubble{background:#1e644a;color:#fff;border-bottom-right-radius:4px}
    .msg.agent .bubble{background:color-mix(in srgb,Canvas 91%,CanvasText);border:1px solid color-mix(in srgb,CanvasText 10%,transparent);border-bottom-left-radius:4px}
    .msg.system .bubble{background:transparent;font-size:12px;opacity:.75;padding:3px 8px}
    .msg.streaming .bubble{border-style:dashed}
    .ctx-badge{font-size:11px;opacity:.85;margin-bottom:2px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,CanvasText 10%,transparent)}
    .meta{font-size:11px;opacity:.7;display:flex;gap:6px;align-items:center}
    .msg-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
    .msg-actions button{min-height:32px;padding:4px 10px;font-size:12px;border-radius:999px}
    .msg-actions button.primary{background:#1e644a;color:#fff;border-color:#1e644a}
    .activity-drawer{border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent);background:color-mix(in srgb,Canvas 96%,CanvasText);font-size:12px}
    .activity-drawer summary{cursor:pointer;padding:7px 12px;font-weight:600;opacity:.85;user-select:none}
    .activity-list{list-style:none;margin:0;padding:0 12px 10px;display:flex;flex-direction:column;gap:6px;max-height:150px;overflow-y:auto}
    .activity-item{padding:6px 8px;border-radius:8px;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);font-size:12px}
    .activity-head{font-weight:650;font-size:11px;opacity:.85;margin-bottom:2px}
    .status-strip{padding:6px 12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;background:color-mix(in srgb,Canvas 93%,CanvasText);border-top:1px solid color-mix(in srgb,CanvasText 10%,transparent)}
    .status-strip.error{color:#b72222;font-weight:600}
    .ctx-bar{padding:6px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;background:color-mix(in srgb,#1e644a 12%,Canvas);border-top:1px solid color-mix(in srgb,CanvasText 10%,transparent)}
    .ctx-bar button{min-height:26px;padding:2px 8px;font-size:12px;border-radius:999px}
    .consent-bar{padding:10px 12px;background:color-mix(in srgb,Highlight 10%,Canvas);border-top:1px solid Highlight;display:flex;flex-direction:column;gap:8px;font-size:12px}
    .consent-actions{display:flex;gap:6px}
    .consent-actions .primary{background:#1e644a;color:#fff;border-color:#1e644a}
    .composer{position:relative;padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent);display:flex;flex-direction:column;gap:6px;background:Canvas}
    .target-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .target-chip{min-height:26px;padding:2px 9px;font-size:11px;font-weight:650;border-radius:999px;background:color-mix(in srgb,Canvas 92%,CanvasText)}
    .mention-menu{position:absolute;left:10px;right:10px;bottom:100%;margin-bottom:4px;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:12px;box-shadow:0 8px 24px #0003;padding:4px;display:flex;flex-direction:column;gap:2px;z-index:10;max-height:180px;overflow-y:auto}
    .mention-opt{justify-content:flex-start;border:0;border-radius:8px;min-height:34px;padding:5px 9px;font-size:12px;text-align:left}
    .mention-opt[aria-selected="true"]{background:color-mix(in srgb,#1e644a 18%,Canvas)}
    .mention-opt .m-bio{opacity:.7;font-size:11px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}
    .composer-row{display:flex;align-items:flex-end;gap:6px}
    textarea{flex:1;min-width:0;min-height:42px;max-height:140px;padding:9px 11px;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);border-radius:12px;background:Canvas;resize:none;line-height:1.35}
    .icon-btn{min-width:42px;min-height:42px;padding:0;border-radius:12px;flex:none;position:relative}
    .mic-btn{--level:0;background:color-mix(in srgb,Canvas 92%,CanvasText);font-weight:700}
    .mic-btn[data-state="recording"]{background:#b72222;color:#fff;border-color:#b72222;box-shadow:0 0 0 calc(3px + var(--level) * 9px) color-mix(in srgb,#b72222 30%,transparent)}
    .mic-btn[data-state="working"]{background:#d9822b;color:#fff;border-color:#d9822b}
    .send-btn{min-height:42px;padding:0 14px;border-radius:12px;background:#1e644a;color:#fff;border-color:#1e644a;font-weight:650;flex:none}
    .send-btn:hover:not(:disabled){background:#174d39}
    .composer-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;opacity:.75;padding:0 2px}
    .check-label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
    .check-label input{margin:0}
    @media(prefers-color-scheme:dark){
      .launcher,.send-btn,.pill[aria-pressed="true"],.msg.user .bubble,.msg-actions button.primary,.consent-actions .primary,.banner-actions button.primary{background:#2d8a67;border-color:#2d8a67;color:#fff}
      .launcher:hover:not(:disabled),.send-btn:hover:not(:disabled){background:#37a078}
    }
    @media(max-width:600px){
      .shell.drawer{width:calc(100vw - 16px);height:min(76dvh,calc(var(--tendril-viewport-height,100dvh) - 72px))}
      textarea,input{font-size:16px}
    }
    @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
  `;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const btn = (text: string, className?: string) => {
    const node = el("button", className, text);
    node.type = "button";
    return node;
  };

  let disposed = false;
  let isOpen = options.open ?? (layout === "embedded");
  let messages: AgentChatMessage[] = [...(options.messages ?? [])];
  let streamingEntries: AgentChatStreamingEntry[] = [];
  let activityItems: AgentChatActivityItem[] = [];
  let rosterState: AgentChatRosterState = { primaryId: null, agents: [], targetId: null, canSetPrimary: false };
  let activeBanner: AgentChatBanner | null = null;
  let rosterOpen = false;
  let activeContext: AgentChatContext | null = null;
  let autoSendVoice = options.autoSendVoice ?? true;
  let autoSpeak = options.autoSpeak ?? false;
  let handsFreeLoop = options.handsFreeLoop ?? false;
  let captureState = "idle";
  let voiceError = "";
  let voiceDetail = "";
  let speaking = false;
  let sending = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holding = false;
  let suppressPointerClick = false;
  let handsFreeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingConsentResolve: ((ok: boolean) => void) | null = null;
  const spokenIds = new Set<string>(messages.filter(m => m.role === "agent").map(m => m.id));
  const speechQueue: string[] = [];

  // Mention autocomplete state
  let mentionMatches: Array<{ handle: string; bio?: string }> = [];
  let mentionIndex = 0;
  let mentionStart = -1;

  // Header
  const shell = el("section", `shell ${layout === "embedded" ? "embedded" : "drawer"}`);
  shell.setAttribute("aria-label", options.title || "Assistant chat");
  shell.hidden = !isOpen;

  const header = el("header", "header");
  const titleGroup = el("div", "title-group");
  const titleNode = el("span", "title", options.title || "Assistant");
  const presenceBtn = btn("", "presence-btn");
  presenceBtn.setAttribute("aria-expanded", "false");
  const presenceRow = el("span", "presence");
  const presenceDot = el("span", "pdot");
  const presenceLabel = el("span", undefined, options.presence?.label || "Ready");
  presenceDot.dataset.status = options.presence?.status || "unknown";
  presenceRow.append(presenceDot, presenceLabel);
  presenceBtn.append(presenceRow);
  titleGroup.append(titleNode, presenceBtn);

  const headerActions = el("div", "header-actions");
  const stopSpeakBtn = btn("Stop speaking", "pill stop-speak");
  stopSpeakBtn.hidden = true;
  const speakerBtn = btn(autoSpeak ? "Voice: On" : "Voice: Off", "pill");
  speakerBtn.setAttribute("aria-pressed", String(autoSpeak));
  speakerBtn.hidden = outputEngine === false;
  const loopBtn = btn("Hands-free", "pill");
  loopBtn.setAttribute("aria-pressed", String(handsFreeLoop));
  loopBtn.title = "Listen again automatically after each spoken reply";
  loopBtn.hidden = outputEngine === false;
  const closeBtn = btn("×", "close-btn");
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.hidden = layout === "embedded";
  headerActions.append(stopSpeakBtn, speakerBtn, loopBtn, closeBtn);
  header.append(titleGroup, headerActions);

  // Roster popover
  const rosterPopover = el("div", "roster-popover");
  rosterPopover.hidden = true;

  // Non-blocking inline failover / info banner
  const bannerBox = el("div", "banner");
  bannerBox.setAttribute("role", "status");
  bannerBox.hidden = true;

  // Feed
  const feed = el("div", "feed");
  feed.setAttribute("role", "log");
  feed.setAttribute("aria-live", "polite");

  // Collapsible agent-to-agent activity drawer
  const activityDrawer = el("details", "activity-drawer");
  activityDrawer.hidden = true;
  const activitySummary = el("summary", undefined, "Agent activity (0)");
  const activityList = el("ul", "activity-list");
  activityDrawer.append(activitySummary, activityList);

  // Status / Error / Hands-free countdown strip
  const statusStrip = el("div", "status-strip");
  statusStrip.hidden = true;
  const statusText = el("span");
  const statusCancel = btn("Cancel", "pill");
  statusCancel.hidden = true;
  statusStrip.append(statusText, statusCancel);

  // Inline consent banner
  const consentBar = el("div", "consent-bar");
  consentBar.hidden = true;
  const consentDesc = el("div");
  const consentActions = el("div", "consent-actions");
  const consentAccept = btn("Allow voice", "primary");
  const consentDecline = btn("Not now");
  consentActions.append(consentAccept, consentDecline);
  consentBar.append(consentDesc, consentActions);

  // Context chip bar
  const ctxBar = el("div", "ctx-bar");
  ctxBar.hidden = true;
  const ctxText = el("span");
  const ctxClear = btn("Clear");
  ctxBar.append(ctxText, ctxClear);

  const haptic = (pattern: number | number[]) => {
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      navigator.vibrate?.(pattern);
    } catch { /* ignore */ }
  };

  let wakeLease: { release(): Promise<void> } | null = null;
  let wakeSeq = 0;
  const syncWakeLock = () => {
    const want = handsFreeLoop && isOpen && !disposed && document.visibilityState === "visible";
    if (want && !wakeLease && runtime.sensors.wakeLock) {
      const seq = ++wakeSeq;
      void runtime.sensors.wakeLock({ label: "Hands-free voice", autoReacquire: true }).then(lease => {
        if (seq !== wakeSeq || !handsFreeLoop || !isOpen || disposed || document.visibilityState !== "visible") {
          void lease.release();
          return;
        }
        wakeLease = lease;
      }).catch(() => {});
    } else if (!want) {
      ++wakeSeq;
      const prev = wakeLease;
      wakeLease = null;
      void prev?.release();
    }
  };

  // Composer
  const composer = el("div", "composer");
  const mentionMenu = el("div", "mention-menu");
  mentionMenu.setAttribute("role", "listbox");
  mentionMenu.setAttribute("aria-label", "Mention an agent");
  mentionMenu.hidden = true;

  const targetRow = el("div", "target-row");
  targetRow.hidden = true;
  const targetChip = btn("To: Primary ▾", "target-chip");
  targetRow.append(targetChip);

  const composerRow = el("div", "composer-row");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.hidden = true;
  const cameraInput = el("input");
  cameraInput.type = "file";
  cameraInput.accept = "image/*";
  cameraInput.setAttribute("capture", "environment");
  cameraInput.hidden = true;
  const attachBtn = btn("+", "icon-btn");
  attachBtn.setAttribute("aria-label", "Attach photo or file");
  attachBtn.title = "Attach photo or file";
  attachBtn.hidden = !options.onAttach;
  const isTouchDevice = (typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0);
  const cameraBtn = btn("Cam", "icon-btn");
  cameraBtn.setAttribute("aria-label", "Take photo");
  cameraBtn.title = "Take photo with camera";
  cameraBtn.hidden = !options.onAttach || !isTouchDevice;

  const textarea = el("textarea");
  textarea.rows = 1;
  textarea.maxLength = 8000;
  textarea.placeholder = options.placeholder || "Message or tap mic to speak…";
  textarea.setAttribute("aria-label", "Message input");
  try {
    const saved = sessionStorage.getItem(draftKey);
    if (saved) textarea.value = saved;
  } catch { /* ignore */ }

  const micBtn = btn("Mic", "icon-btn mic-btn");
  micBtn.setAttribute("aria-label", "Tap to speak or hold to talk");
  micBtn.title = "Tap to talk (or press and hold)";

  const sendBtn = btn("Send", "send-btn");
  composerRow.append(fileInput, cameraInput, attachBtn, cameraBtn, textarea, micBtn, sendBtn);

  const composerFoot = el("div", "composer-foot");
  const autoSendLabel = el("label", "check-label");
  const autoSendInput = el("input");
  autoSendInput.type = "checkbox";
  autoSendInput.checked = autoSendVoice;
  autoSendLabel.append(autoSendInput, document.createTextNode("Send voice immediately"));
  const hint = el("span", undefined, "Enter to send · @handle to mention");
  composerFoot.append(autoSendLabel, hint);
  composer.append(mentionMenu, targetRow, composerRow, composerFoot);

  shell.append(header, rosterPopover, bannerBox, feed, activityDrawer, statusStrip, consentBar, ctxBar, composer);

  const launcher = btn(options.title || "Chat & Voice", "launcher");
  launcher.hidden = layout !== "dock" || isOpen;

  root.append(style, shell, launcher);

  const autoResize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(140, Math.max(42, textarea.scrollHeight))}px`;
  };

  const clearHandsFreeTimer = () => {
    if (handsFreeTimer !== null) {
      clearTimeout(handsFreeTimer);
      handsFreeTimer = null;
    }
  };

  const updateStatusStrip = () => {
    if (voiceError) {
      statusStrip.hidden = false;
      statusStrip.className = "status-strip error";
      statusText.textContent = voiceError;
      statusCancel.hidden = true;
      return;
    }
    if (handsFreeTimer !== null) {
      statusStrip.hidden = false;
      statusStrip.className = "status-strip";
      statusText.textContent = "Listening for follow-up…";
      statusCancel.hidden = false;
      return;
    }
    if (voiceDetail && (captureState === "recording" || captureState === "working")) {
      statusStrip.hidden = false;
      statusStrip.className = "status-strip";
      statusText.textContent = voiceDetail;
      statusCancel.hidden = false;
      return;
    }
    statusStrip.hidden = true;
  };

  const renderBanner = () => {
    bannerBox.replaceChildren();
    if (!activeBanner) {
      bannerBox.hidden = true;
      return;
    }
    bannerBox.hidden = false;
    bannerBox.dataset.kind = activeBanner.kind ?? "warning";
    const top = el("div", "banner-top");
    top.append(el("span", undefined, activeBanner.message));
    if (activeBanner.onDismiss) {
      const dismissBtn = btn("×", "banner-dismiss");
      dismissBtn.setAttribute("aria-label", "Dismiss notice");
      dismissBtn.addEventListener("click", () => activeBanner?.onDismiss?.());
      top.append(dismissBtn);
    }
    bannerBox.append(top);
    if (activeBanner.actions?.length) {
      const row = el("div", "banner-actions");
      for (const act of activeBanner.actions) {
        const b = btn(act.label, act.primary ? "primary" : undefined);
        b.addEventListener("click", () => {
          void Promise.resolve().then(() => activeBanner?.onAction?.(act.id)).catch(err => {
            voiceError = err instanceof Error ? err.message : String(err);
            renderControls();
          });
        });
        row.append(b);
      }
      bannerBox.append(row);
    }
  };

  const renderRoster = () => {
    const agents = rosterState.agents;
    const primary = agents.find(a => a.id === rosterState.primaryId || a.isPrimary) ?? null;
    const target = rosterState.targetId === "*"
      ? "*"
      : (agents.find(a => a.id === rosterState.targetId || a.publicKey === rosterState.targetId) ?? null);

    targetRow.hidden = agents.length === 0;
    if (agents.length > 0) {
      if (target === "*") targetChip.textContent = "To: @all ▾";
      else if (target) targetChip.textContent = `To: @${target.handle}${target.id === primary?.id ? " (Primary)" : ""} ▾`;
      else if (primary) targetChip.textContent = `To: @${primary.handle} (Primary) ▾`;
      else targetChip.textContent = "To: Any mentioned @agent ▾";
    }

    if (agents.length > 0) {
      const active = (target && target !== "*") ? target : primary;
      const othersOnline = agents.filter(a => a.id !== active?.id && (a.state === "online" || a.state === "busy")).length;
      if (active) {
        presenceDot.dataset.status = active.state;
        const statusWord = active.state === "online" ? "Online"
          : active.state === "busy" ? "Thinking…"
          : active.state === "stopped" ? "Stopped"
          : active.state === "offline" ? "Offline" : "Ready";
        const suffix = othersOnline > 0 ? ` · +${othersOnline} online` : "";
        presenceLabel.textContent = `@${active.handle}${active.id === primary?.id ? " (Primary)" : ""} · ${statusWord}${suffix}`;
      } else {
        const onlineCount = agents.filter(a => a.state === "online" || a.state === "busy").length;
        presenceDot.dataset.status = onlineCount > 0 ? "online" : "offline";
        presenceLabel.textContent = `${agents.length} agents · ${onlineCount} online`;
      }
    }

    rosterPopover.hidden = !rosterOpen || agents.length === 0;
    presenceBtn.setAttribute("aria-expanded", String(!rosterPopover.hidden));
    rosterPopover.replaceChildren();
    if (!rosterPopover.hidden) {
      for (const agent of agents) {
        const row = el("div", "roster-row");
        const info = el("div", "roster-info");
        const name = el("div", "roster-name");
        const dot = el("span", "pdot");
        dot.dataset.status = agent.state;
        name.append(dot, document.createTextNode(`@${agent.handle}${agent.id === primary?.id ? " (Primary)" : ""}`));
        info.append(name);
        if (agent.bio) info.append(el("div", "roster-bio", agent.bio));
        const btns = el("div", "roster-btns");
        const msgBtn = btn(rosterState.targetId === agent.id ? "Targeted" : "Message");
        msgBtn.disabled = rosterState.targetId === agent.id;
        msgBtn.addEventListener("click", () => {
          rosterState = { ...rosterState, targetId: agent.id };
          options.onSelectTarget?.(agent.id);
          rosterOpen = false;
          renderRoster();
          textarea.focus();
        });
        btns.append(msgBtn);
        if (rosterState.canSetPrimary && agent.id !== primary?.id) {
          const priBtn = btn("Make primary");
          priBtn.addEventListener("click", () => {
            priBtn.disabled = true;
            void Promise.resolve().then(() => options.onSetPrimary?.(agent.id)).catch(err => {
              voiceError = err instanceof Error ? err.message : String(err);
              renderControls();
            }).finally(() => { priBtn.disabled = false; });
          });
          btns.append(priBtn);
        }
        row.append(info, btns);
        rosterPopover.append(row);
      }
      if (agents.length > 1) {
        const allRow = el("div", "roster-row");
        allRow.append(el("span", "roster-bio", "Broadcast to every agent on this page"));
        const allBtn = btn(rosterState.targetId === "*" ? "Targeting @all" : "Message @all");
        allBtn.disabled = rosterState.targetId === "*";
        allBtn.addEventListener("click", () => {
          rosterState = { ...rosterState, targetId: "*" };
          options.onSelectTarget?.("*");
          rosterOpen = false;
          renderRoster();
          textarea.focus();
        });
        allRow.append(allBtn);
        rosterPopover.append(allRow);
      }
    }
  };

  presenceBtn.addEventListener("click", () => {
    if (rosterState.agents.length === 0) return;
    rosterOpen = !rosterOpen;
    renderRoster();
  });

  targetChip.addEventListener("click", () => {
    if (rosterState.agents.length === 0) return;
    rosterOpen = !rosterOpen;
    renderRoster();
  });

  const renderActivity = () => {
    activityDrawer.hidden = activityItems.length === 0;
    activitySummary.textContent = `Agent activity (${activityItems.length})`;
    activityList.replaceChildren();
    for (const item of activityItems.slice(-40)) {
      const li = el("li", "activity-item");
      const toStr = item.toHandles?.length ? ` → ${item.toHandles.map(h => `@${h}`).join(", ")}` : "";
      const time = item.at ? ` · ${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
      li.append(el("div", "activity-head", `@${item.senderHandle}${toStr}${time}`), el("div", undefined, item.text));
      activityList.append(li);
    }
  };

  const renderControls = () => {
    if (disposed) return;
    stopSpeakBtn.hidden = !speaking;
    speakerBtn.textContent = autoSpeak ? "Voice: On" : "Voice: Off";
    speakerBtn.setAttribute("aria-pressed", String(autoSpeak));
    loopBtn.setAttribute("aria-pressed", String(handsFreeLoop));
    micBtn.dataset.state = captureState;
    micBtn.textContent = captureState === "recording" ? "Stop" : captureState === "working" ? "…" : "Mic";
    micBtn.setAttribute("aria-label", captureState === "recording" ? "Finish recording" : "Tap to speak or hold to talk");
    sendBtn.disabled = sending || !textarea.value.trim();
    ctxBar.hidden = !activeContext;
    if (activeContext) ctxText.textContent = `About: ${activeContext.label}`;
    updateStatusStrip();
  };

  const renderMessages = () => {
    if (disposed) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;
    while (feed.firstChild) feed.firstChild.remove();
    if (messages.length === 0 && streamingEntries.length === 0) {
      feed.append(el("div", "empty", "Ask a question by typing below or tapping Mic. Use @handle to address a specific agent."));
      return;
    }
    const multiAgent = rosterState.agents.length > 1 || new Set(messages.map(m => m.senderHandle).filter(Boolean)).size > 1;
    for (const msg of messages) {
      const row = el("article", `msg ${msg.role}`);
      if (msg.role === "agent" && (msg.senderHandle || multiAgent)) {
        const tag = el("span", "sender-tag");
        tag.style.setProperty("--agent-color", handleColor(msg.senderHandle));
        tag.append(document.createTextNode(msg.senderHandle ? `@${msg.senderHandle}` : "Agent"));
        if (msg.isPrimary) tag.append(el("span", "p-chip", "Primary"));
        row.append(tag);
      }
      if (msg.contextLabel) row.append(el("span", "ctx-badge", `About: ${msg.contextLabel}`));
      const bubble = el("div", "bubble", msg.text);
      row.append(bubble);
      if (msg.actions?.length) {
        const actionsRow = el("div", "msg-actions");
        for (const action of msg.actions) {
          const ab = btn(action.label, action.primary ? "primary" : undefined);
          ab.addEventListener("click", () => {
            void Promise.resolve().then(() => options.onAction?.({ messageId: msg.id, actionId: action.id, label: action.label })).catch(err => {
              voiceError = err instanceof Error ? err.message : String(err);
              renderControls();
            });
          });
          actionsRow.append(ab);
        }
        row.append(actionsRow);
      }
      const metaParts: string[] = [];
      if (msg.toHandles?.length) metaParts.push(`to ${msg.toHandles.map(h => h === "*" ? "@all" : `@${h}`).join(", ")}`);
      if (msg.at) metaParts.push(new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (msg.status && STATUS_LABELS[msg.status]) metaParts.push(STATUS_LABELS[msg.status]);
      if (metaParts.length) row.append(el("span", "meta", metaParts.join(" · ")));
      feed.append(row);
    }
    for (const stream of streamingEntries) {
      if (!stream.text?.trim()) continue;
      const row = el("article", "msg agent streaming");
      if (stream.senderHandle) {
        const tag = el("span", "sender-tag");
        tag.style.setProperty("--agent-color", handleColor(stream.senderHandle));
        tag.textContent = `@${stream.senderHandle}`;
        row.append(tag);
      }
      row.append(el("div", "bubble", stream.text), el("span", "meta", "Thinking…"));
      feed.append(row);
    }
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  };

  // Mention autocomplete helpers
  const closeMentionMenu = () => {
    mentionMatches = [];
    mentionStart = -1;
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
  };

  const applyMention = (handle: string) => {
    if (mentionStart < 0) return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, mentionStart);
    const after = textarea.value.slice(caret);
    const inserted = `@${handle} `;
    textarea.value = before + inserted + after;
    const nextPos = before.length + inserted.length;
    textarea.setSelectionRange(nextPos, nextPos);
    closeMentionMenu();
    autoResize();
    renderControls();
    textarea.focus();
  };

  const updateMentionMenu = () => {
    if (rosterState.agents.length === 0) { closeMentionMenu(); return; }
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(before);
    if (!match) { closeMentionMenu(); return; }
    const query = (match[1] ?? "").toLowerCase();
    const candidates: Array<{ handle: string; bio?: string }> = [
      ...rosterState.agents.map(a => ({ handle: a.handle, bio: a.bio })),
      ...(rosterState.agents.length > 1 ? [{ handle: "all", bio: "Everyone on this page" }] : []),
    ].filter(item => item.handle.startsWith(query));
    if (candidates.length === 0) { closeMentionMenu(); return; }
    mentionStart = caret - (match[1]?.length ?? 0) - 1;
    mentionMatches = candidates;
    mentionIndex = Math.min(mentionIndex, candidates.length - 1);
    mentionMenu.replaceChildren();
    candidates.forEach((item, idx) => {
      const opt = btn("", "mention-opt");
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(idx === mentionIndex));
      opt.append(el("strong", undefined, `@${item.handle}`));
      if (item.bio) opt.append(el("span", "m-bio", item.bio));
      opt.addEventListener("mousedown", e => { e.preventDefault(); applyMention(item.handle); });
      mentionMenu.append(opt);
    });
    mentionMenu.hidden = false;
  };

  const requestInlineConsent = (description: string): Promise<boolean> => {
    if (pendingConsentResolve) { pendingConsentResolve(false); pendingConsentResolve = null; }
    consentDesc.textContent = description;
    consentBar.hidden = false;
    return new Promise<boolean>(resolve => {
      pendingConsentResolve = ok => {
        pendingConsentResolve = null;
        consentBar.hidden = true;
        resolve(ok);
      };
    });
  };
  consentAccept.addEventListener("click", () => pendingConsentResolve?.(true));
  consentDecline.addEventListener("click", () => pendingConsentResolve?.(false));

  const submitText = async (text: string, via: "text" | "voice") => {
    const trimmed = text.trim();
    if (!trimmed || sending || disposed) return;
    closeMentionMenu();
    sending = true;
    voiceError = "";
    const ctx = activeContext;
    if (via === "text") {
      textarea.value = "";
      autoResize();
      try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
    }
    renderControls();
    try {
      await options.onSend({
        text: trimmed,
        via,
        ...(ctx ? { context: ctx.data ?? ctx.label } : {}),
        ...(rosterState.targetId ? { target: rosterState.targetId } : {}),
      });
      if (!disposed && ctx === activeContext) activeContext = null;
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

  const pumpSpeechQueue = () => {
    if (disposed || outputEngine === false || speaking || speechQueue.length === 0) return;
    const next = speechQueue.shift();
    if (!next) return;
    void ensureOutputEnabled().then(ok => {
      if (ok && !disposed) voice.speak(next);
      else speechQueue.length = 0;
    });
  };

  const enqueueSpeech = (text: string) => {
    if (!text?.trim() || outputEngine === false) return;
    speechQueue.push(text.trim());
    pumpSpeechQueue();
  };

  const voice = createVoice(runtime, {
    consentMode,
    consent: consentMode === "auto" ? undefined : request => requestInlineConsent(request.description),
    autoOutput: autoSpeak && outputEngine ? outputEngine : false,
    mediaSession: {
      title: options.title || document.title || "Assistant",
      artworkUrl: `${runtime.identity.base}_tendril/icon.svg`,
      onPlay: () => {
        const lastAgent = [...messages].reverse().find(m => m.role === "agent" && m.text?.trim());
        if (lastAgent && outputEngine !== false) enqueueSpeech(lastAgent.text);
      },
    },
    transcript(text) {
      if (disposed || !text.trim()) return;
      haptic([10, 30, 10]);
      voiceError = "";
      if (autoSendVoice) {
        void submitText(text, "voice");
      } else {
        textarea.value = [textarea.value.trim(), text.trim()].filter(Boolean).join(" ");
        autoResize();
        textarea.focus();
        try { sessionStorage.setItem(draftKey, textarea.value); } catch { /* ignore */ }
        renderControls();
      }
    },
    level(level) {
      if (!disposed) micBtn.style.setProperty("--level", level.toFixed(3));
    },
    status(status: VoiceStatus) {
      if (disposed) return;
      if (status.kind === "capture") {
        captureState = status.state;
        voiceDetail = status.message || (status.state === "recording" ? "Listening… tap Stop when done" : "");
        if (status.state === "error") voiceError = status.message || "Voice input failed. You can type instead.";
      } else if (status.kind === "output") {
        const wasSpeaking = speaking;
        speaking = Boolean(status.speaking);
        if (speaking) clearHandsFreeTimer();
        if (wasSpeaking && !speaking && status.completed === true) {
          if (speechQueue.length > 0 && autoSpeak) {
            pumpSpeechQueue();
          } else if (handsFreeLoop && isOpen && document.visibilityState === "visible") {
            clearHandsFreeTimer();
            handsFreeTimer = setTimeout(() => {
              handsFreeTimer = null;
              if (!disposed && handsFreeLoop && isOpen && !voice.listening && document.visibilityState === "visible") {
                void voice.startCapture();
              }
              renderControls();
            }, 550);
          }
        }
      }
      renderControls();
    },
  });
  if (options.language) voice.language(options.language);

  const ensureOutputEnabled = async () => {
    if (outputEngine === false) return false;
    if (!voice.muted) return true;
    return voice.enableOutput(outputEngine);
  };

  // Tap or press-and-hold Mic interaction (with automatic barge-in over TTS + queue clear)
  const beginMic = () => {
    clearHandsFreeTimer();
    voiceError = "";
    speechQueue.length = 0;
    if (voice.speaking) {
      haptic(20);
      voice.stop();
    }
    if (captureState === "recording") {
      voice.finishCapture();
      return;
    }
    if (captureState === "working") {
      voice.cancelCapture();
      return;
    }
    haptic(12);
    void voice.startCapture();
  };

  micBtn.addEventListener("pointerdown", event => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    holding = false;
    suppressPointerClick = false;
    try { micBtn.setPointerCapture(event.pointerId); } catch { /* unsupported pointer capture */ }
    if (captureState === "idle" || captureState === "error") {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holding = true;
        suppressPointerClick = true;
        beginMic();
      }, HOLD_THRESHOLD_MS);
    }
  });
  const endPointer = (event: PointerEvent) => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (holding) {
      holding = false;
      if (event.type === "pointercancel") voice.cancelCapture();
      else if (captureState === "recording") voice.finishCapture();
      else voice.cancelCapture();
    }
  };
  micBtn.addEventListener("pointerup", endPointer);
  micBtn.addEventListener("pointercancel", endPointer);
  micBtn.addEventListener("click", event => {
    if (suppressPointerClick && event.detail !== 0) { suppressPointerClick = false; return; }
    suppressPointerClick = false;
    beginMic();
  });

  speakerBtn.addEventListener("click", async () => {
    if (outputEngine === false) return;
    if (autoSpeak) {
      autoSpeak = false;
      handsFreeLoop = false;
      speechQueue.length = 0;
      clearHandsFreeTimer();
      syncWakeLock();
      voice.mute();
    } else {
      try {
        if (typeof window !== "undefined" && window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined") {
          window.speechSynthesis.resume?.();
          const primer = new SpeechSynthesisUtterance("");
          primer.volume = 0;
          window.speechSynthesis.speak(primer);
        }
      } catch { /* ignore */ }
      const ok = await ensureOutputEnabled();
      autoSpeak = ok;
    }
    renderControls();
  });

  loopBtn.addEventListener("click", async () => {
    if (handsFreeLoop) {
      handsFreeLoop = false;
      clearHandsFreeTimer();
      syncWakeLock();
    } else {
      handsFreeLoop = true;
      syncWakeLock();
      if (!autoSpeak && outputEngine !== false) {
        autoSpeak = await ensureOutputEnabled();
      }
    }
    renderControls();
  });

  stopSpeakBtn.addEventListener("click", () => {
    haptic(20);
    speechQueue.length = 0;
    clearHandsFreeTimer();
    voice.stop();
    speaking = false;
    renderControls();
  });

  statusCancel.addEventListener("click", () => {
    clearHandsFreeTimer();
    voice.cancelCapture();
    renderControls();
  });

  ctxClear.addEventListener("click", () => {
    activeContext = null;
    renderControls();
  });

  autoSendInput.addEventListener("change", () => {
    autoSendVoice = autoSendInput.checked;
  });

  textarea.addEventListener("input", () => {
    autoResize();
    updateMentionMenu();
    try {
      if (textarea.value) sessionStorage.setItem(draftKey, textarea.value);
      else sessionStorage.removeItem(draftKey);
    } catch { /* ignore */ }
    renderControls();
  });
  textarea.addEventListener("keydown", event => {
    if (!mentionMenu.hidden && mentionMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        mentionIndex = (mentionIndex + 1) % mentionMatches.length;
        updateMentionMenu();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        mentionIndex = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
        updateMentionMenu();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(mentionMatches[mentionIndex]!.handle);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentionMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitText(textarea.value, "text");
    }
  });
  sendBtn.addEventListener("click", () => { void submitText(textarea.value, "text"); });

  attachBtn.addEventListener("click", () => fileInput.click());
  cameraBtn.addEventListener("click", () => cameraInput.click());
  const deliverAttachedFile = (file: File | undefined) => {
    if (!file || !options.onAttach) return;
    void Promise.resolve().then(() => options.onAttach?.(file)).catch(err => {
      voiceError = err instanceof Error ? err.message : String(err);
      renderControls();
    });
  };
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    deliverAttachedFile(file);
  });
  cameraInput.addEventListener("change", () => {
    const file = cameraInput.files?.[0];
    cameraInput.value = "";
    deliverAttachedFile(file);
  });

  textarea.addEventListener("focus", () => { feed.scrollTop = feed.scrollHeight; });
  const onViewportResize = () => {
    if (root.activeElement === textarea) feed.scrollTop = feed.scrollHeight;
  };
  window.visualViewport?.addEventListener("resize", onViewportResize);

  const suspendConversation = () => {
    clearHandsFreeTimer();
    speechQueue.length = 0;
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    holding = false;
    pendingConsentResolve?.(false);
    syncWakeLock();
  };
  const offSensorsStopped = runtime.on("sensors_stopped", suspendConversation);
  const onHidden = () => { if (document.visibilityState !== "visible") suspendConversation(); else syncWakeLock(); };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", suspendConversation);

  const setOpen = (next: boolean) => {
    isOpen = next;
    shell.hidden = !isOpen;
    launcher.hidden = layout !== "dock" || isOpen;
    syncWakeLock();
    if (!isOpen) {
      rosterOpen = false;
      closeMentionMenu();
      suspendConversation(); voice.stop();
      if (layout === "dock") launcher.focus();
    }
    if (isOpen) {
      feed.scrollTop = feed.scrollHeight;
      textarea.focus();
    }
  };
  const offShare = (options.consumeShares !== false && runtime.shareTarget)
    ? runtime.shareTarget.onShare(payload => {
      if (disposed) return;
      const parts = [payload.title, payload.text, payload.url].filter(Boolean);
      if (parts.length) {
        textarea.value = [textarea.value.trim(), parts.join("\n")].filter(Boolean).join("\n\n");
        autoResize();
        try { sessionStorage.setItem(draftKey, textarea.value); } catch { /* ignore */ }
      }
      if (!isOpen) setOpen(true);
      renderControls();
      textarea.focus();
      for (const file of payload.files) deliverAttachedFile(file);
    })
    : () => {};
  launcher.addEventListener("click", () => setOpen(true));
  closeBtn.addEventListener("click", () => setOpen(false));
  root.addEventListener("keydown", event => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    if (!mentionMenu.hidden) { event.preventDefault(); closeMentionMenu(); return; }
    if (rosterOpen) { event.preventDefault(); rosterOpen = false; renderRoster(); return; }
    event.preventDefault(); event.stopPropagation();
    if (layout === "embedded") { suspendConversation(); voice.stop(); textarea.focus(); }
    else setOpen(false);
  });

  (options.container || document.body).append(host);
  renderRoster();
  renderBanner();
  renderMessages();
  renderActivity();
  renderControls();
  autoResize();

  return {
    voice,
    element: host,
    setMessages(next) {
      const prevIds = new Set(messages.map(m => m.id));
      messages = [...next];
      renderMessages();
      if (!isOpen && !disposed) {
        for (const m of messages) {
          if (m.role === "agent" && !prevIds.has(m.id)) {
            runtime.chat?.notifyIncoming?.({ id: m.id, senderHandle: m.senderHandle, text: m.text });
          }
        }
      }
      if (autoSpeak && !disposed) {
        const newlyArrived = messages.filter(m => m.role === "agent" && !spokenIds.has(m.id));
        const multiAgent = rosterState.agents.length > 1;
        for (const m of newlyArrived) {
          spokenIds.add(m.id);
          if (!m.text?.trim()) continue;
          const prefix = multiAgent && m.senderHandle && !m.isPrimary ? `${m.senderHandle} says: ` : "";
          enqueueSpeech(prefix + m.text);
        }
      } else {
        for (const m of messages) if (m.role === "agent") spokenIds.add(m.id);
      }
    },
    setStreamingReply(text) {
      streamingEntries = text && text.trim() ? [{ id: "default", text }] : [];
      renderMessages();
    },
    setStreamingReplies(entries) {
      streamingEntries = entries.filter(e => e.text && e.text.trim());
      renderMessages();
    },
    setRoster(roster) {
      rosterState = { ...roster, agents: [...roster.agents] };
      renderRoster();
      renderMessages();
    },
    setActivity(items) {
      activityItems = [...items];
      renderActivity();
    },
    setBanner(banner) {
      activeBanner = banner;
      renderBanner();
    },
    setPresence(presence) {
      presenceDot.dataset.status = presence.status;
      presenceLabel.textContent = presence.label
        ?? (presence.status === "online" ? "Online"
          : presence.status === "busy" ? "Thinking…"
          : presence.status === "offline" ? "Offline" : "Ready");
    },
    setContext(context) {
      activeContext = context ? { ...context } : null;
      renderControls();
    },
    speak(text) {
      enqueueSpeech(text);
    },
    stopSpeaking() {
      speechQueue.length = 0;
      clearHandsFreeTimer();
      voice.stop();
      speaking = false;
      renderControls();
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen),
    focus: () => { if (!isOpen) setOpen(true); textarea.focus(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      speechQueue.length = 0;
      clearHandsFreeTimer();
      if (holdTimer !== null) clearTimeout(holdTimer);
      pendingConsentResolve?.(false);
      syncWakeLock();
      offShare();
      offSensorsStopped();
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", suspendConversation);
      voice.dispose();
      host.remove();
    },
  };
}
