// Live publication update controller: one explicit state machine, zero hidden policies,
// zero 300ms timers. The page automatically adopts the latest selected release as soon as
// no application hold, active IME composition, active pointer gesture, or typed draft defers it.
// Whenever an update is deferred or pinned, listeners immediately receive `phase: "deferred" | "pinned"`
// with human-readable `reasons` so the UI surfaces a deterministic "Update now" notice.
import { watchPublicationUpdates as watchPublicationSelection, type AgentsRosterNotice, type McpSyncNotice } from "../../contract/publication-watch.mjs";
import type { PublicationUpdate, PublicationUpdatePhase } from "../../contract/index.mjs";
import { documentUrl } from "./document";
import type { TendrilConfig } from "./types";
import type { PublicationChangeOutcome } from "./slots";

export type UpdatePolicy = "live";
export type BeforeReloadHandler = (update: PublicationUpdate) => boolean | void | Promise<boolean | void>;

export interface PublicationUpdates {
  readonly pinned: boolean;
  readonly policy: UpdatePolicy;
  readonly updateAvailable: boolean;
  readonly phase: PublicationUpdatePhase;
  readonly reasons: readonly string[];
  onUpdate(listener: (update: PublicationUpdate) => void): () => void;
  onBeforeReload(handler: BeforeReloadHandler): () => void;
  hold(reason?: string): () => void;
  update(): void;
  close(): void;
}

function viewOf(node: Node | null | undefined): (Window & typeof globalThis) | null {
  return (node?.ownerDocument?.defaultView as (Window & typeof globalThis) | null) ?? (typeof window !== "undefined" ? window : null);
}
function isHtmlElement(node: unknown): node is HTMLElement {
  if (!node || typeof node !== "object" || (node as Node).nodeType !== 1) return false;
  const view = viewOf(node as Node);
  const Ctor = view?.HTMLElement ?? (typeof HTMLElement !== "undefined" ? HTMLElement : null);
  return Ctor ? node instanceof Ctor : false;
}
function isInput(node: unknown): node is HTMLInputElement {
  if (!isHtmlElement(node)) return false;
  const Ctor = viewOf(node)?.HTMLInputElement ?? (typeof HTMLInputElement !== "undefined" ? HTMLInputElement : null);
  return Ctor ? node instanceof Ctor : node.tagName === "INPUT";
}
function isTextArea(node: unknown): node is HTMLTextAreaElement {
  if (!isHtmlElement(node)) return false;
  const Ctor = viewOf(node)?.HTMLTextAreaElement ?? (typeof HTMLTextAreaElement !== "undefined" ? HTMLTextAreaElement : null);
  return Ctor ? node instanceof Ctor : node.tagName === "TEXTAREA";
}
function isSelect(node: unknown): node is HTMLSelectElement {
  if (!isHtmlElement(node)) return false;
  const Ctor = viewOf(node)?.HTMLSelectElement ?? (typeof HTMLSelectElement !== "undefined" ? HTMLSelectElement : null);
  return Ctor ? node instanceof Ctor : node.tagName === "SELECT";
}
function isIframe(node: unknown): node is HTMLIFrameElement {
  if (!isHtmlElement(node)) return false;
  const Ctor = viewOf(node)?.HTMLIFrameElement ?? (typeof HTMLIFrameElement !== "undefined" ? HTMLIFrameElement : null);
  return Ctor ? node instanceof Ctor : node.tagName === "IFRAME";
}
function sameOriginDocument(frame: HTMLIFrameElement): Document | null {
  try {
    const doc = frame.contentDocument;
    return doc && doc.documentElement ? doc : null;
  } catch {
    return null;
  }
}

function editableHost(element: HTMLElement): HTMLElement {
  let cur: HTMLElement = element;
  while (cur.parentElement && isHtmlElement(cur.parentElement) && cur.parentElement.isContentEditable) {
    cur = cur.parentElement;
  }
  return cur;
}

function editedElement(event: Event): Element | null {
  const target = event.composedPath?.()[0] ?? event.target;
  if (target && typeof target === "object") {
    if ((target as Node).nodeType === 1) return target as Element;
    if ((target as Node).parentElement) return (target as Node).parentElement;
  }
  return null;
}

/** True only when a control the person actively edited still holds unsent/unclear input. */
function typedDraftPending(edited: Set<Element>): boolean {
  for (const element of [...edited]) {
    if (!element.isConnected) { edited.delete(element); continue; }
    if (isInput(element)) {
      if (["hidden", "button", "submit", "reset", "image", "range", "color"].includes(element.type)) { edited.delete(element); continue; }
      if (element.type === "file") {
        if ((element.files?.length ?? 0) > 0) return true;
      } else if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.value !== "" && element.value !== element.defaultValue) return true;
    } else if (isTextArea(element)) {
      if (element.value !== "" && element.value !== element.defaultValue) return true;
    } else if (isSelect(element)) {
      if ([...element.options].some(opt => opt.selected !== opt.defaultSelected)) return true;
    } else if (isHtmlElement(element) && element.isContentEditable) {
      const host = editableHost(element);
      const doc = host.ownerDocument;
      const frameFocused = !doc || doc === document || doc.hasFocus();
      const root = host.getRootNode() as Document | ShadowRoot;
      const active = root && "activeElement" in root ? root.activeElement : null;
      if (frameFocused && active && (active === host || host.contains(active) || active.contains(host))) return true;
    }
    edited.delete(element);
  }
  return false;
}

export function explicitlyPinned(cfg: TendrilConfig, href = location.href): boolean {
  if (!cfg.publication) return false;
  const current = new URL(href), base = new URL(cfg.base, current);
  if (current.origin !== base.origin || !current.pathname.startsWith(base.pathname)) return false;
  const match = /^_publications\/([1-9][0-9]*)\//.exec(current.pathname.slice(base.pathname.length));
  return !!match && Number.isSafeInteger(Number(match[1]));
}

const holdingStatus = (state: string) => state === "connected" ? "Your agent is preparing the first version. It will open here automatically."
  : state === "reconnecting" ? "Connection interrupted. Retrying automatically."
  : "This page could not be opened. Select Check now to try again.";

export function watchPublicationUpdates(cfg: TendrilConfig, options: {
  pinned: boolean;
  watch?: boolean;
  reload?: () => void;
  beforeReloadTimeoutMs?: number;
  onAgents?: (notice: AgentsRosterNotice) => void;
  onMcpSync?: (notice: McpSyncNotice) => void;
  hasHotSwappableSlots?: () => boolean;
  onBeforeSwitch?: (version: number) => Promise<PublicationChangeOutcome>;
} = { pinned: false }): PublicationUpdates {
  const listeners = new Set<(update: PublicationUpdate) => void>();
  const beforeReloadHandlers = new Set<BeforeReloadHandler>();
  const holds = new Map<object, string | undefined>();
  const edited = new Set<Element>();
  const composingDocs = new Set<Document>();
  const activePointers = new Map<Document, Set<number>>();
  const attachedDocs = new Map<Document, () => void>();
  const reload = options.reload ?? (() => location.reload());
  const beforeReloadTimeoutMs = Math.max(100, options.beforeReloadTimeoutMs ?? 2500);
  const latestUrl = () => new URL(cfg.base, location.href).href;
  let activeVersion = cfg.version;
  let available: number | null = null;
  let availableOutcome: PublicationChangeOutcome | undefined;
  let phase: PublicationUpdatePhase = "current";
  let currentReasons: readonly string[] = Object.freeze([]);
  let lastAnnouncedKey = "";
  let switching = false, switchReset: ReturnType<typeof setTimeout> | undefined, closed = false;
  let noticeEpoch = 0;

  const pruneDetachedDocs = () => {
    for (const [doc, cleanup] of [...attachedDocs.entries()]) {
      if (doc === document) continue;
      if (!doc.defaultView || !doc.documentElement?.isConnected) {
        attachedDocs.delete(doc);
        try { cleanup(); } catch {}
      }
    }
  };
  const hasActivePointer = () => {
    for (const [doc, ids] of [...activePointers.entries()]) {
      if (!doc.defaultView) { activePointers.delete(doc); continue; }
      if (ids.size > 0) return true;
    }
    return false;
  };
  const hasComposing = () => {
    for (const doc of [...composingDocs]) {
      if (!doc.defaultView) composingDocs.delete(doc);
    }
    return composingDocs.size > 0;
  };
  const computeReasons = (): string[] => {
    pruneDetachedDocs();
    const reasons: string[] = [];
    for (const reason of holds.values()) {
      const label = typeof reason === "string" && reason.trim() ? reason.trim() : "Pending app work";
      if (!reasons.includes(label)) reasons.push(label);
    }
    if (hasComposing()) reasons.push("Active text composition");
    if (hasActivePointer()) reasons.push("Active pointer gesture");
    if (typedDraftPending(edited)) reasons.push("Unsaved text draft");
    return reasons;
  };

  const buildUpdate = (
    version: number | null,
    kind: "hot-swapped" | "reload" | "reverted",
    nextPhase: PublicationUpdatePhase,
    reasons: readonly string[],
    outcome?: PublicationChangeOutcome,
  ): PublicationUpdate => Object.freeze({
    version,
    kind,
    phase: nextPhase,
    reasons: Object.freeze([...reasons]),
    ...(outcome?.publication !== undefined ? { publication: outcome.publication } : {}),
    ...(outcome?.changedPaths !== undefined ? { changedPaths: outcome.changedPaths } : {}),
  });

  const emitState = (update: PublicationUpdate, force = false) => {
    const key = `${update.version}|${update.kind}|${update.phase}|${(update.reasons ?? []).join("\u001f")}`;
    if (!force && key === lastAnnouncedKey) return;
    lastAnnouncedKey = key;
    phase = update.phase ?? "current";
    currentReasons = update.reasons ?? Object.freeze([]);
    for (const listener of listeners) { try { listener(update); } catch { /* Observers cannot block the switch. */ } }
  };

  const commitReload = () => {
    clearTimeout(switchReset);
    switchReset = setTimeout(() => {
      switching = false;
      switchReset = undefined;
      if (!closed && available !== null) {
        const reasons = computeReasons();
        emitState(buildUpdate(available, "reload", "deferred", reasons.length ? reasons : ["Reload deferred"], availableOutcome));
      }
    }, 5000);
    reload();
  };

  const attempt = () => {
    if (closed || available === null) return;
    if (options.pinned) {
      emitState(buildUpdate(available, "reload", "pinned", [], availableOutcome));
      return;
    }
    if (switching) return;
    const reasons = computeReasons();
    if (reasons.length > 0) {
      emitState(buildUpdate(available, "reload", "deferred", reasons, availableOutcome));
      return;
    }
    switching = true;
    const applyingUpdate = buildUpdate(available, "reload", "applying", [], availableOutcome);
    emitState(applyingUpdate);
    if (beforeReloadHandlers.size === 0) {
      commitReload();
      return;
    }
    const handlers = [...beforeReloadHandlers];
    let vetoed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runAll = Promise.all(handlers.map(async (handler) => {
      try {
        const result = await handler(applyingUpdate);
        if (result === false) vetoed = true;
      } catch {
        // A failing flush hook must not crash the update watcher.
      }
    }));
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => { resolve(); }, beforeReloadTimeoutMs);
    });
    void Promise.race([runAll, timeout]).then(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (closed || available === null || options.pinned) {
        switching = false;
        return;
      }
      const nextReasons = computeReasons();
      if (vetoed || nextReasons.length > 0) {
        switching = false;
        emitState(buildUpdate(available, "reload", "deferred", nextReasons.length ? nextReasons : ["Pending changes"], availableOutcome));
        return;
      }
      commitReload();
    });
  };

  const browser = typeof document !== "undefined" && typeof document.addEventListener === "function" && typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (!browser) {
    return Object.freeze({
      pinned: options.pinned,
      policy: "live" as const,
      updateAvailable: false,
      phase: "current" as const,
      reasons: Object.freeze([]),
      onUpdate: () => () => {},
      onBeforeReload: () => () => {},
      hold: () => () => {},
      update() { reload(); },
      close() {},
    });
  }

  let watch: { close(): void } | undefined;
  const applyReloadNotice = (current: number, outcome?: PublicationChangeOutcome) => {
    if (available === current && phase !== "current") return;
    available = current;
    availableOutcome = outcome;
    attempt();
  };

  if (options.watch) try {
    watch = watchPublicationSelection({ base: latestUrl(),
      onCurrent({ current }: { current: number }) {
        if (closed) return;
        const epoch = ++noticeEpoch;
        if (cfg.version === 0) {
          if (current > 0 && !switching) { switching = true; reload(); }
          return;
        }
        if (current === 0 || current === activeVersion) {
          if (available !== null) {
            available = null; availableOutcome = undefined; switching = false;
            emitState(buildUpdate(null, "reverted", "current", []), true);
          }
          return;
        }
        if (!options.pinned && options.onBeforeSwitch && options.hasHotSwappableSlots?.()) {
          void options.onBeforeSwitch(current).then(outcome => {
            if (closed || epoch !== noticeEpoch) return;
            if (outcome.handled && outcome.kind === "hot-swapped") {
              activeVersion = current;
              available = null;
              availableOutcome = undefined;
              emitState(buildUpdate(current, "hot-swapped", "current", [], outcome), true);
              return;
            }
            applyReloadNotice(current, outcome);
          }).catch(() => {
            if (!closed && epoch === noticeEpoch) applyReloadNotice(current);
          });
          return;
        }
        applyReloadNotice(current);
      },
      onAgents(notice: AgentsRosterNotice) {
        if (!closed) options.onAgents?.(notice);
      },
      onMcpSync(notice: McpSyncNotice) {
        if (!closed) options.onMcpSync?.(notice);
      },
      onStatus({ state }: { state: string }) {
        if (closed || cfg.version !== 0) return;
        const status = document.getElementById("publication-status");
        if (status) status.textContent = holdingStatus(state);
      } });
  } catch { /* A document outside its page origin has no publication watch. */ }

  document.addEventListener("visibilitychange", attempt);
  window.addEventListener("pageshow", attempt);

  let deferred: ReturnType<typeof setTimeout> | undefined;
  const scheduleAttempt = () => {
    if (closed || available === null || options.pinned || switching) return;
    clearTimeout(deferred); deferred = setTimeout(attempt, 0);
  };

  const afterEdit = (event: Event) => {
    if (event.type === "input" || event.type === "change" || event.type === "beforeinput") {
      const element = editedElement(event);
      if (element && (event.isTrusted || ((event.type === "input" || event.type === "change") && isInput(element) && element.type === "file"))) {
        edited.add(isHtmlElement(element) && element.isContentEditable ? editableHost(element) : element);
      }
    }
    scheduleAttempt();
  };

  const editEvents = ["beforeinput", "input", "change", "focusout", "reset"];

  const attachDocument = (doc: Document | null) => {
    if (!doc || closed || attachedDocs.has(doc)) return;
    const onCompositionStart = () => { composingDocs.add(doc); };
    const onCompositionEnd = () => { composingDocs.delete(doc); scheduleAttempt(); };
    const onPointerDown = (event: Event) => {
      if (!event.isTrusted) return;
      const pe = event as PointerEvent;
      let set = activePointers.get(doc);
      if (!set) { set = new Set(); activePointers.set(doc, set); }
      set.add(pe.pointerId ?? 0);
    };
    const onPointerDone = (event: Event) => {
      const pe = event as PointerEvent;
      const set = activePointers.get(doc);
      if (set) {
        set.delete(pe.pointerId ?? 0);
        if (set.size === 0) activePointers.delete(doc);
      }
      scheduleAttempt();
    };
    const onWinBlur = () => {
      const had = activePointers.delete(doc);
      if (had || doc !== document) scheduleAttempt();
    };
    const onParentFocusIn = () => {
      if (attachedDocs.size > 1) scheduleAttempt();
    };
    const onFrameLoad = (event: Event) => {
      if (isIframe(event.target)) {
        attachDocument(sameOriginDocument(event.target));
      }
    };
    for (const event of editEvents) doc.addEventListener(event, afterEdit, true);
    if (doc === document) doc.addEventListener("focusin", onParentFocusIn, true);
    doc.addEventListener("compositionstart", onCompositionStart, true);
    doc.addEventListener("compositionend", onCompositionEnd, true);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointerup", onPointerDone, true);
    doc.addEventListener("pointercancel", onPointerDone, true);
    doc.addEventListener("load", onFrameLoad, true);
    const win = doc.defaultView;
    win?.addEventListener("blur", onWinBlur);

    attachedDocs.set(doc, () => {
      for (const event of editEvents) doc.removeEventListener(event, afterEdit, true);
      if (doc === document) doc.removeEventListener("focusin", onParentFocusIn, true);
      doc.removeEventListener("compositionstart", onCompositionStart, true);
      doc.removeEventListener("compositionend", onCompositionEnd, true);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointerup", onPointerDone, true);
      doc.removeEventListener("pointercancel", onPointerDone, true);
      doc.removeEventListener("load", onFrameLoad, true);
      win?.removeEventListener("blur", onWinBlur);
      composingDocs.delete(doc);
      activePointers.delete(doc);
    });

    try {
      for (const frame of doc.querySelectorAll("iframe")) {
        if (isIframe(frame)) attachDocument(sameOriginDocument(frame));
      }
    } catch { /* Ignore detached/restricted frame trees. */ }
  };

  attachDocument(document);

  return Object.freeze({
    pinned: options.pinned,
    policy: "live" as const,
    get updateAvailable() { return available !== null; },
    get phase() { return phase; },
    get reasons() { return currentReasons; },
    onUpdate(listener: (update: PublicationUpdate) => void) {
      if (closed) return () => {};
      listeners.add(listener);
      if (available !== null) {
        listener(buildUpdate(available, "reload", phase, currentReasons, availableOutcome));
      }
      return () => { listeners.delete(listener); };
    },
    onBeforeReload(handler: BeforeReloadHandler) {
      if (closed || typeof handler !== "function") return () => {};
      beforeReloadHandlers.add(handler);
      return () => { beforeReloadHandlers.delete(handler); };
    },
    hold(reason?: string) {
      const token = {};
      if (!closed) {
        holds.set(token, reason);
        if (available !== null && !options.pinned && !switching) attempt();
      }
      return () => { if (holds.delete(token)) attempt(); };
    },
    update() {
      if (closed) return;
      switching = true;
      if (options.pinned) location.assign(documentUrl(cfg, new URL(latestUrl())).href);
      else reload();
    },
    close() {
      if (closed) return;
      closed = true; clearTimeout(deferred); clearTimeout(switchReset); watch?.close();
      document.removeEventListener("visibilitychange", attempt); window.removeEventListener("pageshow", attempt);
      for (const cleanup of attachedDocs.values()) { try { cleanup(); } catch {} }
      attachedDocs.clear();
      holds.clear(); listeners.clear(); beforeReloadHandlers.clear(); edited.clear();
      composingDocs.clear(); activePointers.clear(); available = null; phase = "current"; currentReasons = Object.freeze([]);
    },
  });
}
