import { encodePublicationPath } from "./paths";
import { observeUtilityBar, observeVisualViewport, utilityBottom, utilityLeft, utilityMaxWidth, utilityRight, utilityTop } from "./utility-layout";
import type { RuntimeApi, SensorStatus } from "../../contract/index.mjs";
import { btn, clearChildren, el, iconEl, setData } from "./utility/dom";
import type { IconName } from "./utility/icons";
import { UTILITY_CSS } from "./utility/styles";
import { createChatModal, type TalkDockState } from "./utility/chat-modal";
import {
  createAgentsModal,
  createAppModal,
  createDiagnosticsModal,
  createShareModal,
  createSyncModal,
  createVoiceModal,
  type ShareAgentsSharedState,
} from "./utility/modals";

const labels: Record<string, string> = { camera: "Camera", microphone: "Microphone", screen: "Screen sharing", location: "Location", motion: "Motion", wake_lock: "Keep awake" };
const SUGGEST_AFTER_MS = 12_000;
const DISMISS_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const HOLD_TO_TALK_MS = 280;

/** Local-only presentation; caller inserts message as text, never markup. */
export function sensorSummary(status: SensorStatus) {
  const resources = status.resources ?? [];
  const name = (kind: string) => labels[kind] ?? kind;
  const describedActive = new Set(resources.filter(r => r.state === "active").map(r => r.kind));
  const describedPending = new Set(resources.filter(r => r.state === "pending").map(r => r.kind));
  const active = status.active.filter(kind => !describedActive.has(kind));
  const pending = status.pending.filter(kind => !describedPending.has(kind));
  const phase = { active: "active", pending: "request pending", stopping: "stopping", failed: "failed" };
  const parts = [
    active.length ? active.map(name).join(", ") + " active" : "",
    pending.length ? pending.map(name).join(", ") + " request pending" : "",
    ...resources.map(resource => (resource.label ?? name(resource.kind)) + " " + phase[resource.state]),
  ].filter(Boolean);
  const names = [...new Set([...active, ...pending].map(name).concat(resources.map(resource => resource.label ?? name(resource.kind))))];
  return {
    message: parts.join(". "),
    names,
    visible: parts.length > 0,
    canStop: status.active.length > 0 || status.pending.length > 0 || resources.length > 0,
  };
}

type ModalId = "chat" | "share" | "agents" | "voice" | "sync" | "app" | "diagnostics";
type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
const CORNERS: ReadonlyArray<[Corner, string]> = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
];

/** Reactive floating dock (Talk + Page Options icon), compact menu, and mobile-first modals. */
export function mountUtility(api: RuntimeApi): () => void {
  const host = document.createElement("tendril-utility");
  host.style.cssText = `position:fixed!important;inset:auto ${utilityRight} ${utilityBottom} auto!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;max-width:${utilityMaxWidth}!important;max-height:calc(100vh - ${utilityTop} - ${utilityBottom})!important;max-height:calc(100dvh - ${utilityTop} - ${utilityBottom})!important;contain:style!important;`;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = UTILITY_CSS;

  let disposed = false;
  let activeModal: ModalId | null = null;
  let modalOpener: HTMLElement | null = null;

  const shared: ShareAgentsSharedState = {
    pageName: (typeof document !== "undefined" && document.title) || "Tendriller page",
    canManage: false,
    ownerChecked: false,
    links: [],
    pendingGuests: [],
    accountAgents: [],
    dashboardUrl: "/dashboard#agents",
    connectionsUrl: "/connections",
    platformsUrl: "/agents",
    mcpGrants: null,
  };

  // ── Floating Status Cards (Broadcast, Publication Update, Install Suggestion) ──
  const updateCard = el("aside", undefined, "float-card"); updateCard.hidden = true;
  updateCard.setAttribute("aria-label", "Publication update"); updateCard.setAttribute("role", "status"); updateCard.setAttribute("aria-live", "polite");
  const openUpdate = el("a", "Open update", "btn primary full");
  openUpdate.href = api.identity?.documentPath && api.identity.documentPath !== "index.html"
    ? new URL(encodePublicationPath(api.identity.documentPath), api.identity.base).href : (api.identity?.base || "/");
  updateCard.append(
    el("strong", "New version published"),
    el("p", api.publication?.pinned
      ? "This address shows a fixed version. Open the latest version when you are ready."
      : "This page switches to it as soon as no unsaved changes are open."),
    openUpdate,
  );

  const broadcastCard = el("aside", undefined, "float-card broadcast-card"); broadcastCard.hidden = true;
  broadcastCard.setAttribute("aria-label", "System notice"); broadcastCard.setAttribute("role", "status"); broadcastCard.setAttribute("aria-live", "polite");

  const suggestion = el("aside", undefined, "float-card"); suggestion.hidden = true;
  suggestion.setAttribute("aria-label", "Home screen suggestion");
  const suggestAdd = btn("Show me how", "btn primary sm"); suggestAdd.style.flex = "1";
  const suggestDismiss = btn("Not now", "btn sm");
  const suggestActions = el("div", undefined, "row"); suggestActions.append(suggestAdd, suggestDismiss);
  suggestion.append(el("strong", "Keep this page one tap away"), el("p", "Add a shortcut to your Home Screen."), suggestActions);

  // ── Floating Dock (Always-reachable Stop + Talk Icon + Options Icon) ──
  const nav = el("nav", undefined, "dock");
  nav.setAttribute("aria-label", "Page operations");

  const activeSensors = el("span", undefined, "sensors-pill");
  activeSensors.setAttribute("role", "status");
  activeSensors.hidden = true;
  const stopSensors = btn("Stop sensors", "stop-btn");
  stopSensors.hidden = true;

  const recChip = el("div", undefined, "rec-chip"); recChip.hidden = true;
  const recPulse = el("span", undefined, "rec-pulse");
  const recText = el("span", "Listening…");
  const recCancel = btn("Cancel", "rec-cancel");
  recChip.append(recPulse, recText, recCancel);

  const talkBtn = btn("", "dock-btn dock-talk");
  talkBtn.setAttribute("aria-label", "Talk to assistant");
  talkBtn.title = "Tap for chat · Hold for voice input";
  talkBtn.append(iconEl("assistant"));
  const talkDot = el("span", undefined, "dock-dot"); talkDot.hidden = true;
  const talkBadge = el("span", "", "dock-badge"); talkBadge.hidden = true;
  talkBtn.append(talkDot, talkBadge);

  const optionsBtn = btn("", "dock-btn");
  optionsBtn.setAttribute("aria-label", "Page options");
  optionsBtn.setAttribute("aria-expanded", "false");
  optionsBtn.setAttribute("aria-controls", "page-options");
  optionsBtn.title = "Page options";
  optionsBtn.append(iconEl("options"));
  const optionsDot = el("span", undefined, "dock-dot"); optionsDot.hidden = true;
  optionsBtn.append(optionsDot);

  nav.append(activeSensors, stopSensors, recChip, talkBtn, optionsBtn);

  // ── Compact Options Popover Menu (Launches Dedicated Modals) ──────────
  const panel = el("section", undefined, "popover");
  panel.id = "page-options";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Save and manage page");

  const popHead = el("div", undefined, "pop-head");
  const popTitleWrap = el("div", undefined, "pop-title-wrap");
  const popHeading = el("h2", shared.pageName, "pop-title"); popHeading.tabIndex = -1;
  const popMeta = el("div", undefined, "pop-meta");
  const popVersion = el("span", api.identity?.version ? `v${api.identity.version}` : "Draft", "pill");
  const popSync = el("span", "Local", "pill");
  popMeta.append(popVersion, popSync);
  popTitleWrap.append(popHeading, popMeta);
  const popClose = btn("", "pop-close");
  popClose.setAttribute("aria-label", "Close page options");
  popClose.append(iconEl("close"));
  popHead.append(popTitleWrap, popClose);

  const popBody = el("div", undefined, "pop-body");
  const popUpdateBanner = el("div", undefined, "pop-banner"); popUpdateBanner.hidden = true;
  const popUpdateLink = el("a", "Update", "btn primary sm");
  popUpdateLink.href = openUpdate.href;
  popUpdateBanner.append(el("div", "New version available"), popUpdateLink);
  popBody.append(popUpdateBanner);

  const makeMenuItem = (icon: IconName, title: string, subtitle: string, onClick: () => void) => {
    const item = btn("", "menu-item");
    const ico = el("span", undefined, "menu-ico"); ico.append(iconEl(icon));
    const copy = el("span", undefined, "menu-copy");
    const lbl = el("span", title, "menu-label");
    const sub = el("span", subtitle, "menu-sub");
    copy.append(lbl, sub);
    const trail = el("span", undefined, "menu-trail");
    const badge = el("span", "", "pill accent"); badge.hidden = true;
    trail.append(badge, iconEl("chevronRight"));
    item.append(ico, copy, trail);
    item.addEventListener("click", onClick);
    return { item, sub, badge };
  };
  const shareItem = makeMenuItem("share", "Share & invite", "My device, invite people & links", () => openModal("share", optionsBtn));
  const agentsItem = makeMenuItem("agents", "Agents & MCP", "Add agents, primary & ChatGPT MCP", () => openModal("agents", optionsBtn));
  const voiceItem = makeMenuItem("voice", "Voice & audio", "Mic, wake word & spoken replies", () => openModal("voice", optionsBtn));
  const syncItem = makeMenuItem("sync", "Sync & connections", "Peer links & local session status", () => openModal("sync", optionsBtn));
  const appItem = makeMenuItem("app", "App & offline", "Install, offline cache & notifications", () => openModal("app", optionsBtn));
  const diagItem = makeMenuItem("device", "Device & diagnostics", "Permissions, notices & error logs", () => openModal("diagnostics", optionsBtn));

  popBody.append(shareItem.item, agentsItem.item, voiceItem.item, syncItem.item, appItem.item, diagItem.item);

  // Footer with clean links + compact visual mini-screen 4-corner dock picker
  const popFoot = el("div", undefined, "pop-foot");
  const links = el("div", undefined, "links pop-links");
  const latest = el("a", "Open latest version", "pop-link"); latest.href = api.identity?.base || "/";
  latest.title = "Open the currently selected publication";
  const manage = el("a", "Manage page", "pop-link"); manage.href = api.identity?.managementUrl || "_tendril/manage";
  manage.title = "Page recovery and device management"; manage.target = "_blank"; manage.rel = "noopener";
  if ((api.identity?.version ?? 0) > 0) links.append(latest);
  links.append(manage);

  const cornerKey = "tendril:utility-corner:" + (api.identity?.base ?? "");
  let corner: Corner = "bottom-right";
  try { const saved = localStorage.getItem(cornerKey); if (CORNERS.some(([v]) => v === saved)) corner = saved as Corner; } catch { /* ignore */ }
  const cornerPicker = el("div", undefined, "corner-picker");
  cornerPicker.setAttribute("role", "group");
  cornerPicker.setAttribute("aria-label", "Button position");
  cornerPicker.title = "Dock corner (or drag the dock)";
  const cornerButtons = CORNERS.map(([value, label]) => {
    const choice = btn("", "corner-dot");
    choice.setAttribute("aria-label", label);
    choice.setAttribute("aria-pressed", "false");
    choice.setAttribute("data-corner", value);
    choice.title = label;
    choice.addEventListener("click", () => { setCorner(value); choice.focus(); });
    return choice;
  });
  cornerPicker.append(...cornerButtons);
  popFoot.append(links, cornerPicker);

  panel.append(popHead, popBody, popFoot);

  // ── Unified Reactive Modal Shell (Desktop Dialog / Mobile Bottom Sheet) ──
  const modalBackdrop = el("div", undefined, "modal-backdrop");
  modalBackdrop.hidden = true;
  const modalBox = el("section", undefined, "modal");
  modalBox.setAttribute("role", "dialog");
  modalBox.setAttribute("aria-modal", "true");
  const modalGrab = el("div", undefined, "modal-grab");
  const modalHead = el("header", undefined, "modal-head");
  const modalHeadLeft = el("div", undefined, "modal-head-left");
  const modalHeadIco = el("span", undefined, "modal-head-ico");
  const modalHeadCopy = el("div", undefined, "modal-head-copy");
  const modalTitle = el("h2"); modalTitle.tabIndex = -1;
  const modalSub = el("div", "", "modal-head-sub");
  modalHeadCopy.append(modalTitle, modalSub);
  modalHeadLeft.append(modalHeadIco, modalHeadCopy);

  const modalHeadActions = el("div", undefined, "modal-head-actions");
  const modalExtraSlot = el("div");
  const modalCloseBtn = btn("", "pop-close");
  modalCloseBtn.setAttribute("aria-label", "Close dialog");
  modalCloseBtn.append(iconEl("close"));
  modalHeadActions.append(modalExtraSlot, modalCloseBtn);
  modalHead.append(modalHeadLeft, modalHeadActions);

  const modalContentSlot = el("div");
  modalContentSlot.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
  modalBox.append(modalGrab, modalHead, modalContentSlot);
  modalBackdrop.append(modalBox);

  // ── Install Suggestion Lifecycle ──────────────────────────────────────
  let engaged = false, suggested = false, suppressed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismissalKey = "tendril:install-dismissed:" + (api.identity?.base ?? "");
  const cancelSuggestion = () => { clearTimeout(timer); timer = undefined; };
  const isDismissed = () => {
    if (suppressed) return true;
    try { return Number(localStorage.getItem(dismissalKey) || 0) > Date.now(); }
    catch { return false; }
  };
  const rememberDismissal = () => {
    suppressed = true; suggestion.hidden = true; cancelSuggestion();
    try { localStorage.setItem(dismissalKey, String(Date.now() + DISMISS_FOR_MS)); }
    catch { /* ignore */ }
  };
  const eligible = () => {
    const st = api.installation.status();
    return !!api.identity?.publication && st.platform !== "desktop"
      && (st.state === "available" || (st.platform === "ios" && st.state === "manual")) && !isDismissed();
  };
  const scheduleSuggestion = () => {
    if (!engaged || suggested || timer !== undefined || !panel.hidden || activeModal !== null || !eligible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      const focused = document.activeElement;
      const editing = focused?.matches?.("input,textarea,select,[contenteditable]:not([contenteditable=false])");
      const sensors = api.sensors.status();
      if (disposed || document.hidden || editing || !panel.hidden || activeModal !== null || sensors.active.length || sensors.pending.length || sensors.resources?.length || !eligible()) return;
      suggested = true; suggestion.hidden = false;
    }, SUGGEST_AFTER_MS);
  };
  const renderInstallSuggestion = () => {
    const st = api.installation.status();
    suggestAdd.textContent = st.state === "available" ? "Add to Home Screen" : "Show me how";
    if (!eligible()) { suggestion.hidden = true; cancelSuggestion(); }
    scheduleSuggestion();
  };

  // ── Instantiate Modals ────────────────────────────────────────────────
  const updateMenuMeta = () => {
    if (disposed) return;
    const roster = api.agents?.snapshot?.() ?? { primary_agent_id: null, agents: [], live: {} };
    const count = roster.agents.length;
    const primary = roster.agents.find(a => a.id === roster.primary_agent_id || a.is_primary);
    agentsItem.sub.textContent = count === 0
      ? "Add workspace agents or ChatGPT MCP"
      : `${count} ${count === 1 ? "agent" : "agents"}${primary ? ` · @${primary.handle} primary` : ""}`;
    agentsItem.badge.hidden = count === 0;
    agentsItem.badge.textContent = String(count);

    const pendingCount = shared.pendingGuests.length || (roster.pending_guests ?? 0);
    shareItem.badge.hidden = pendingCount === 0;
    shareItem.badge.textContent = `${pendingCount} pending`;
    shareItem.badge.className = "pill warn";

    const errCount = api.errors?.list?.().length ?? 0;
    diagItem.badge.hidden = errCount === 0;
    diagItem.badge.textContent = String(errCount);
    diagItem.badge.className = "pill danger";

    const tr = api.transport?.status?.();
    const peers = tr?.authenticatedPeers;
    if (peers && peers > 0) {
      syncItem.sub.textContent = `Connected to ${peers} ${peers === 1 ? "device" : "devices"}`;
      popSync.textContent = `${peers} ${peers === 1 ? "peer" : "peers"}`;
      popSync.className = "pill ok";
    } else if (tr?.phase === "connecting") {
      syncItem.sub.textContent = "Connecting… saved locally";
      popSync.textContent = "Connecting";
      popSync.className = "pill warn";
    } else {
      syncItem.sub.textContent = "Local-first · peer links & sync";
      popSync.textContent = api.application?.available ? "Local ready" : "Local";
      popSync.className = "pill";
    }

    const inst = api.installation.status();
    appItem.sub.textContent = inst.state === "installed"
      ? "Installed · offline files & alerts"
      : "Install app, offline cache & alerts";

    const broadcasts = api.broadcasts?.active?.() ?? [];
    const hasAlert = Boolean(api.publication?.updateAvailable || pendingCount > 0 || errCount > 0 || broadcasts.length > 0);
    optionsDot.hidden = !hasAlert;
    setData(optionsDot, "tone", errCount > 0 || broadcasts.some(b => b.severity === "critical" || b.severity === "urgent") ? "danger" : "busy");
  };

  const applyTalkDockState = (st: TalkDockState) => {
    setData(talkBtn, "glow", String(st.glowing));
    setData(talkBtn, "recording", String(st.recording));
    setData(talkBtn, "working", String(st.working && !st.recording));
    talkBtn.style.setProperty?.("--level", st.audioLevel.toFixed(3));
    talkBadge.hidden = st.unreadCount <= 0;
    if (st.unreadCount > 0) talkBadge.textContent = st.unreadCount > 9 ? "9+" : String(st.unreadCount);
    talkDot.hidden = st.unreadCount > 0 || (st.presenceStatus !== "online" && st.presenceStatus !== "busy" && !st.wakeActive);
    setData(talkDot, "tone", st.presenceStatus === "busy" ? "busy" : "online");

    const showChip = Boolean(st.statusChip) && activeModal !== "chat";
    recChip.hidden = !showChip;
    if (showChip) recText.textContent = st.statusChip;
    voiceItem.sub.textContent = st.wakeActive ? "Wake word listening" : st.speaking ? "Speaking reply…" : "Mic, wake word & spoken replies";
  };

  const chatModal = createChatModal(api, {
    onDockStateChange: applyTalkDockState,
    onOpenAgentsModal: () => openModal("agents", talkBtn, "add"),
    onOpenVoiceModal: () => openModal("voice", talkBtn),
    onRequestOpen: () => openModal("chat", talkBtn),
  });
  const shareModal = createShareModal(api, shared, updateMenuMeta);
  const agentsModal = createAgentsModal(api, shared, updateMenuMeta);
  const voiceModal = createVoiceModal(api);
  const syncModal = createSyncModal(api);
  const appModal = createAppModal(api, {
    onInstalledChange: () => { renderInstallSuggestion(); updateMenuMeta(); },
    onDismissInstallSuggestion: () => rememberDismissal(),
  });
  const diagModal = createDiagnosticsModal(api, shared);

  const MODAL_META: Record<ModalId, { icon: IconName; title: string; subtitle: string; closeLabel: string }> = {
    chat: { icon: "chat", title: "Assistant", subtitle: "", closeLabel: "Close assistant chat" },
    share: { icon: "share", title: "Share & invite", subtitle: "Open on another device or invite people", closeLabel: "Close share dialog" },
    agents: { icon: "agents", title: "Agents & MCP", subtitle: "Manage page agents, join codes & Hosted MCP", closeLabel: "Close agents dialog" },
    voice: { icon: "voice", title: "Voice & audio", subtitle: "On-device mic, wake word & spoken replies", closeLabel: "Close voice dialog" },
    sync: { icon: "sync", title: "Sync & connections", subtitle: "Authenticated local peer links", closeLabel: "Close sync dialog" },
    app: { icon: "app", title: "Keep this page handy", subtitle: "Install, offline files, notifications & release", closeLabel: "Close app dialog" },
    diagnostics: { icon: "device", title: "Device & diagnostics", subtitle: "Permissions, system notices & error log", closeLabel: "Close diagnostics dialog" },
  };

  const closeMenu = (restoreFocus = false) => {
    panel.hidden = true;
    optionsBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus) optionsBtn.focus();
    updateKeyboardLayout();
  };

  const closeModal = (restoreFocus = true) => {
    if (!activeModal) return;
    if (activeModal === "chat") chatModal.onClose();
    activeModal = null;
    modalBackdrop.hidden = true;
    clearChildren(modalContentSlot);
    clearChildren(modalExtraSlot);
    const target = modalOpener;
    modalOpener = null;
    if (restoreFocus) (target ?? optionsBtn).focus();
    updateKeyboardLayout();
  };

  function openModal(id: ModalId, opener?: HTMLElement, subTab?: string) {
    if (disposed) return;
    if (activeModal === "chat" && id !== "chat") chatModal.onClose();
    closeMenu(false);
    suggested = true; suggestion.hidden = true; cancelSuggestion();
    activeModal = id;
    if (opener) modalOpener = opener;
    const meta = MODAL_META[id];
    modalBox.className = id === "chat" ? "modal modal-chat" : "modal";
    modalBox.setAttribute("aria-label", meta.title);
    modalCloseBtn.setAttribute("aria-label", meta.closeLabel);
    clearChildren(modalHeadIco); modalHeadIco.append(iconEl(meta.icon));
    clearChildren(modalHeadCopy);
    clearChildren(modalExtraSlot);
    clearChildren(modalContentSlot);

    if (id === "chat") {
      modalHeadCopy.append(chatModal.headerTitle, chatModal.headerSub);
      modalExtraSlot.append(chatModal.headerExtra);
      modalContentSlot.append(chatModal.body);
      modalBackdrop.hidden = false;
      nav.classList?.remove("tucked");
      chatModal.onOpen();
      chatModal.focusInput();
    } else {
      modalTitle.textContent = meta.title;
      modalSub.textContent = meta.subtitle;
      modalHeadCopy.append(modalTitle, modalSub);
      const map = {
        share: () => { modalContentSlot.append(shareModal.body); shareModal.onOpen(subTab as "device" | "person" | "links" | undefined); },
        agents: () => { modalContentSlot.append(agentsModal.body); agentsModal.onOpen(subTab as "roster" | "add" | "mcp" | undefined); },
        voice: () => { modalContentSlot.append(voiceModal.body); voiceModal.onOpen(); },
        sync: () => { modalContentSlot.append(syncModal.body); syncModal.onOpen(); },
        app: () => { modalContentSlot.append(appModal.body); appModal.onOpen(); },
        diagnostics: () => { modalContentSlot.append(diagModal.body); diagModal.onOpen(); },
      };
      map[id]();
      modalBackdrop.hidden = false;
      nav.classList?.remove("tucked");
      modalTitle.focus();
    }
    updateKeyboardLayout();
  }

  const openMenu = () => {
    if (activeModal) closeModal(false);
    suggested = true; suggestion.hidden = true; cancelSuggestion();
    panel.hidden = false;
    nav.classList?.remove("tucked");
    optionsBtn.setAttribute("aria-expanded", "true");
    popHeading.textContent = (typeof document !== "undefined" && document.title) || shared.pageName;
    updateMenuMeta();
    popHeading.focus();
  };

  // ── Floating Broadcast Card & Updates ─────────────────────────────────
  const offUpdate = api.publication.onUpdate(({ version, kind }) => {
    if (disposed) return;
    const show = version !== null && kind !== "hot-swapped" && (api.publication.pinned || api.publication.policy === "careful");
    updateCard.hidden = !show;
    popUpdateBanner.hidden = version === null || kind === "hot-swapped";
    updateMenuMeta();
  });

  const renderBroadcastCard = () => {
    if (disposed) return;
    const activeBroadcasts = api.broadcasts?.active?.() ?? [];
    if (!activeBroadcasts.length) { broadcastCard.hidden = true; updateMenuMeta(); return; }
    const rank = { critical: 4, urgent: 3, recommended: 2, info: 1 } as const;
    const sorted = [...activeBroadcasts].sort((a, b) => (rank[b.severity] - rank[a.severity]) || (b.seq - a.seq));
    const current = sorted[0]!;
    const tone = current.severity === "critical" || current.severity === "urgent" ? "danger"
      : current.severity === "recommended" ? "warn" : "";
    broadcastCard.className = `float-card broadcast-card${tone ? " " + tone : ""}`;
    clearChildren(broadcastCard);
    const head = el("div", undefined, "broadcast-head");
    head.append(el("span", `${current.kind} · ${current.severity}`, tone ? `pill ${tone}` : "pill accent"));
    if (sorted.length > 1) head.append(el("span", `+${sorted.length - 1} more`, "muted"));
    broadcastCard.append(head, el("strong", current.title), el("p", current.summary));
    if (current.action?.requires_republish) {
      broadcastCard.append(el("p", "Reconnect an agent from your dashboard to rebuild and republish this page."));
    } else if (current.action?.requires_tab_reload) {
      broadcastCard.append(el("p", "Close all tabs of this page and reopen it to apply the update."));
    }
    const row = el("div", undefined, "row");
    if (current.docs_url) {
      const detailsLink = el("a", "Details", "btn primary sm");
      detailsLink.href = current.docs_url; detailsLink.target = "_blank"; detailsLink.rel = "noopener";
      row.append(detailsLink);
    }
    if (current.dismissible) {
      const dismissBtn = btn("Dismiss", "btn sm");
      dismissBtn.addEventListener("click", () => { api.broadcasts?.dismiss?.(current.id); });
      row.append(dismissBtn);
    }
    if (row.firstChild) broadcastCard.append(row);
    broadcastCard.hidden = false;
    updateMenuMeta();
  };
  const offBroadcasts = api.broadcasts?.onChange?.(renderBroadcastCard) ?? (() => {});

  suggestAdd.addEventListener("click", () => {
    if (api.installation.status().state === "available") {
      openModal("app", optionsBtn);
      void appModal.triggerInstall();
    } else {
      openModal("app", optionsBtn);
    }
  });
  suggestDismiss.addEventListener("click", () => { rememberDismissal(); optionsBtn.focus(); });

  // ── Dock & Modal Controls ─────────────────────────────────────────────
  optionsBtn.addEventListener("click", () => { if (panel.hidden) openMenu(); else closeMenu(true); });
  popClose.addEventListener("click", () => closeMenu(true));
  modalCloseBtn.addEventListener("click", () => closeModal(true));
  modalBackdrop.addEventListener("click", (e: MouseEvent) => { if (e.target === modalBackdrop) closeModal(true); });
  stopSensors.addEventListener("click", () => { api.sensors.stopAll(); optionsBtn.focus(); });
  recCancel.addEventListener("click", () => chatModal.cancelHoldVoice());

  // ── Corner Positioning & Drag-to-Snap + Hold-to-Talk Coexistence ──────
  let lastKeyboardHeight = 0;
  function applyCorner() {
    const [vertical, horizontal] = corner.split("-") as ["top" | "bottom", "left" | "right"];
    host.setAttribute("data-v", vertical); host.setAttribute("data-h", horizontal);
    const set = (name: string, value: string) => host.style.setProperty?.(name, value, "important");
    set("inset", "auto");
    set("top", vertical === "top" ? utilityTop : "auto");
    set("left", horizontal === "left" ? utilityLeft : "auto");
    set("right", horizontal === "right" ? utilityRight : "auto");
    set("flex-direction", vertical === "top" ? "column-reverse" : "column");
    set("align-items", horizontal === "left" ? "flex-start" : "flex-end");
    cornerButtons.forEach((choice, index) => choice.setAttribute("aria-pressed", String(CORNERS[index]![0] === corner)));
    updateKeyboardLayout();
  }
  function setCorner(next: Corner) {
    corner = next;
    try { localStorage.setItem(cornerKey, next); } catch { /* ignore */ }
    applyCorner();
  }

  let drag: { id: number; x: number; y: number; moved: boolean; onTalk: boolean } | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdVoiceActive = false;
  let suppressNavClick = false;

  const clearHoldTimer = () => { if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; } };

  nav.addEventListener("click", event => {
    if (suppressNavClick) { suppressNavClick = false; event.stopPropagation(); event.preventDefault(); }
  }, true);

  talkBtn.addEventListener("click", () => {
    if (activeModal === "chat") closeModal(true);
    else openModal("chat", talkBtn);
  });

  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id || holdVoiceActive) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 8) return;
      clearHoldTimer();
      drag.moved = true;
      nav.classList?.add("dragging");
    }
    event.preventDefault();
    host.style.setProperty?.("transform", `translate(${dx}px,${dy}px)`, "important");
  };
  const stopFollowing = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  };
  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    clearHoldTimer();
    const wasHoldVoice = holdVoiceActive;
    const moved = drag.moved;
    drag = null;
    stopFollowing();
    if (wasHoldVoice) {
      holdVoiceActive = false;
      chatModal.finishHoldVoice();
      suppressNavClick = true; setTimeout(() => { suppressNavClick = false; }, 0);
      return;
    }
    if (!moved) return;
    nav.classList?.remove("dragging"); host.style.removeProperty?.("transform");
    const vertical = event.clientY < window.innerHeight / 2 ? "top" : "bottom";
    const horizontal = event.clientX < window.innerWidth / 2 ? "left" : "right";
    setCorner(`${vertical}-${horizontal}` as Corner);
    suppressNavClick = true; setTimeout(() => { suppressNavClick = false; }, 0);
  };
  const onCancel = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    clearHoldTimer();
    drag = null;
    stopFollowing();
    if (holdVoiceActive) { holdVoiceActive = false; chatModal.cancelHoldVoice(); }
    nav.classList?.remove("dragging"); host.style.removeProperty?.("transform");
  };
  nav.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!event.isPrimary || (event.button !== 0 && event.pointerType === "mouse")) return;
    const path = event.composedPath?.() ?? [];
    const onTalk = path.includes(talkBtn);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, onTalk };
    if (onTalk) {
      clearHoldTimer();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (!drag || drag.moved) return;
        holdVoiceActive = true;
        chatModal.startHoldVoice();
      }, HOLD_TO_TALK_MS);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });

  // ── Keyboard & Sensor Reactivity ──────────────────────────────────────
  const updateKeyboardLayout = () => {
    if (disposed) return;
    const focused = document.activeElement;
    const editingExternal = Boolean(
      focused && !host.contains?.(focused)
      && focused.matches?.("input,textarea,select,[contenteditable]:not([contenteditable=false])"),
    );
    const hasSensors = !stopSensors.hidden;
    const kbOpen = lastKeyboardHeight > 120;
    const atBottom = !corner.startsWith("top");
    if (kbOpen && hasSensors) {
      nav.classList?.remove("tucked");
      host.style.setProperty?.("bottom", atBottom ? `calc(${utilityBottom} + ${lastKeyboardHeight}px)` : "auto", "important");
    } else {
      host.style.setProperty?.("bottom", atBottom ? utilityBottom : "auto", "important");
      nav.classList?.toggle("tucked", kbOpen && editingExternal && panel.hidden && activeModal === null && !hasSensors);
    }
  };

  const renderSensors = () => {
    const summary = sensorSummary(api.sensors.status());
    activeSensors.hidden = stopSensors.hidden = !summary.visible;
    setData(nav, "sensors", String(summary.visible));
    activeSensors.textContent = summary.message;
    activeSensors.title = summary.message;
    stopSensors.disabled = !summary.canStop;
    stopSensors.setAttribute("aria-label", "Stop " + summary.names.join(", "));
    if (summary.visible) { suggestion.hidden = true; cancelSuggestion(); } else scheduleSuggestion();
    updateKeyboardLayout();
  };

  const interact = (event: Event) => {
    if (!event.isTrusted || event.composedPath?.().includes(host)) return;
    engaged = true;
    scheduleSuggestion();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (activeModal !== null) { closeModal(true); event.preventDefault(); return; }
      if (!panel.hidden) { closeMenu(true); event.preventDefault(); return; }
    }
    interact(event);
  };
  const hide = () => { suggestion.hidden = true; cancelSuggestion(); };
  const show = () => { renderInstallSuggestion(); renderSensors(); };

  document.addEventListener("pointerup", interact);
  document.addEventListener("keydown", keydown);
  document.addEventListener("focusin", updateKeyboardLayout);
  document.addEventListener("focusout", updateKeyboardLayout);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);

  root.append(style, broadcastCard, updateCard, suggestion, panel, nav, modalBackdrop);

  const attach = () => { const parent = document.body || document.documentElement; if (host.parentNode !== parent) parent.append(host); };
  const observer = new MutationObserver(attach);
  const offSensors = api.sensors.on(renderSensors);
  const offInstallation = api.installation.on(() => { renderInstallSuggestion(); updateMenuMeta(); });
  const offErrors = api.errors?.on?.(updateMenuMeta) ?? (() => {});
  const offAgentsMeta = api.agents?.onChange?.(updateMenuMeta) ?? (() => {});
  const offTransportMeta = api.transport?.onChange?.(() => updateMenuMeta()) ?? (() => {});
  const offChatOpen = api.chat?.onOpenRequest?.(open => { if (open) openModal("chat", talkBtn); else if (activeModal === "chat") closeModal(false); }) ?? (() => {});

  applyCorner();
  renderInstallSuggestion();
  renderSensors();
  renderBroadcastCard();
  updateMenuMeta();
  applyTalkDockState(chatModal.getDockState());
  attach();
  observer.observe(document, { childList: true, subtree: true });
  const offGeometry = observeUtilityBar(nav);
  const offViewport = observeVisualViewport(({ keyboardHeight }) => {
    lastKeyboardHeight = keyboardHeight;
    updateKeyboardLayout();
  });

  return () => {
    disposed = true;
    clearHoldTimer();
    stopFollowing();
    chatModal.dispose();
    shareModal.dispose();
    agentsModal.dispose();
    voiceModal.dispose();
    syncModal.dispose();
    appModal.dispose();
    diagModal.dispose();
    offUpdate();
    offBroadcasts();
    offSensors();
    offInstallation();
    offErrors();
    offAgentsMeta();
    offTransportMeta();
    offChatOpen();
    cancelSuggestion();
    observer.disconnect();
    offGeometry();
    offViewport();
    document.removeEventListener("pointerup", interact);
    document.removeEventListener("keydown", keydown);
    document.removeEventListener("focusin", updateKeyboardLayout);
    document.removeEventListener("focusout", updateKeyboardLayout);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
    host.remove();
  };
}
