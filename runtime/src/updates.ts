// The page shows the latest selected release by default. The address bar keeps the
// page's own URL (assets resolve through the injected <base>), so a reload, a new tab
// or a discarded-and-restored tab loads whatever release is selected now. An open tab
// learns of a different selection over the page's one hibernating publication watch
// (contract/publication-watch.mjs) and switches by itself. Two policies:
//   live (default)  switch at once; only an application hold, active IME composition,
//                   an active pointer/drag gesture, a selected file input, or text the
//                   person typed and has not yet sent/cleared (including inside open
//                   shadow roots and same-origin iframes) defers it, with no prompt;
//   careful         opt in with <meta name="tendriller-updates" content="careful">: also
//                   wait for any focused editor or any control that differs from its HTML
//                   default (including open shadow roots and same-origin iframes), and
//                   show the "New version published" card meanwhile.
// Pinning is explicit: a document opened at its immutable /_publications/ID/ URL stays
// on that release and only offers the update.
import { watchPublicationUpdates as watchPublicationSelection, type AgentsRosterNotice, type McpSyncNotice } from "../../contract/publication-watch.mjs";
import type { PublicationUpdate } from "../../contract/index.mjs";
import { documentUrl } from "./document";
import type { TendrilConfig } from "./types";
import type { PublicationChangeOutcome } from "./slots";

export type UpdatePolicy = "live" | "careful";

export type BeforeReloadHandler = (update: PublicationUpdate) => boolean | void | Promise<boolean | void>;

export interface PublicationUpdates {
  readonly pinned: boolean;
  /** "live" switches as soon as nothing the person is actively editing/gesturing is pending; "careful" also waits for any focused or changed control. */
  readonly policy: UpdatePolicy;
  readonly updateAvailable: boolean;
  /** Called with the selected version when it differs from this document's release (hot-swapped or reload),
   * and with version null when the selection returns to this release (a rollback). */
  onUpdate(listener: (update: PublicationUpdate) => void): () => void;
  /** Runs asynchronously right before an automatic full-page reload (bounded timeout).
   * Flush debounced drafts here, or return `false` / acquire `hold()` to defer the reload. */
  onBeforeReload(handler: BeforeReloadHandler): () => void;
  /** Defers automatic switching (unsaved work or active media call) until the returned function is called. */
  hold(reason?: string): () => void;
  /** Load the latest release now. */
  update(): void;
  close(): void;
}

const EDITABLE = "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=hidden]),textarea,select";

// Cross-realm element helpers so controls inside same-origin iframes are recognized accurately.
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

/** Walk up to the topmost contentEditable host so nested child nodes (<span>, <p>, etc.) map to their editor root. */
function editableHost(element: HTMLElement): HTMLElement {
  let cur: HTMLElement = element;
  while (cur.parentElement && isHtmlElement(cur.parentElement) && cur.parentElement.isContentEditable) {
    cur = cur.parentElement;
  }
  return cur;
}

function resetClone<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(element: T): T {
  const doc = element.ownerDocument ?? document;
  const initial = element.cloneNode(true) as T;
  const form = doc.createElement("form"); form.append(initial); form.reset();
  return initial;
}

/** Inspect native form defaults even after a preview disables a control. Walk open
 * shadow roots and same-origin iframes: document.activeElement alone only identifies their host. */
function unsavedInput(root: Document | ShadowRoot = document, seen = new Set<Node>()): boolean {
  if (seen.has(root)) return false;
  seen.add(root);
  const active = root.activeElement;
  const ownerBody = "body" in root ? root.body : root.ownerDocument?.body;
  if (active && active !== ownerBody && (active.matches(EDITABLE) || (isHtmlElement(active) && active.isContentEditable))) return true;
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot && unsavedInput(element.shadowRoot, seen)) return true;
    if (isIframe(element)) {
      const childDoc = sameOriginDocument(element);
      if (childDoc && unsavedInput(childDoc, seen)) return true;
      continue;
    }
    if (isInput(element)) {
      if (["hidden", "button", "submit", "reset", "image"].includes(element.type)) continue;
      if (element.type === "file") {
        if ((element.files?.length ?? 0) > 0) return true;
      } else if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.value !== resetClone(element).value) return true;
    } else if (isTextArea(element)) {
      if (element.value !== resetClone(element).value) return true;
    } else if (isSelect(element)) {
      // Let native reset semantics handle implicit defaults, disabled options,
      // multiple selection and multiple defaultSelected attributes correctly.
      const initial = resetClone(element);
      if ([...element.options].some((option, index) => option.selected !== initial.options[index].selected)) return true;
    }
  }
  return false;
}

/** Read the authored policy. Read lazily: the runtime runs before the author's <head> metadata is parsed. */
export function authoredUpdatePolicy(): UpdatePolicy {
  const meta = typeof document !== "undefined" && typeof document.querySelector === "function"
    ? document.querySelector('meta[name="tendriller-updates" i]') : null;
  return meta?.getAttribute("content")?.trim().toLowerCase() === "careful" ? "careful" : "live";
}

/** The element a trusted edit event really targeted, also inside open shadow roots and same-origin iframes. */
function editedElement(event: Event): Element | null {
  const target = event.composedPath?.()[0] ?? event.target;
  if (target && typeof target === "object") {
    if ((target as Node).nodeType === 1) return target as Element;
    if ((target as Node).parentElement) return (target as Node).parentElement;
  }
  return null;
}

/** Live policy: only content the person typed/picked and has not sent or cleared defers a switch. */
function typedDraftPending(edited: Set<Element>): boolean {
  for (const element of [...edited]) {
    if (!element.isConnected) { edited.delete(element); continue; }
    if (isInput(element)) {
      if (["hidden", "button", "submit", "reset", "image", "range", "color"].includes(element.type)) { edited.delete(element); continue; }
      if (element.type === "file") {
        if ((element.files?.length ?? 0) > 0) return true;
      } else if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.value !== "" && element.value !== resetClone(element).value) return true;
    } else if (isTextArea(element)) {
      if (element.value !== "" && element.value !== resetClone(element).value) return true;
    } else if (isHtmlElement(element) && element.isContentEditable) {
      const host = editableHost(element);
      const doc = host.ownerDocument;
      // Clicking from a same-origin iframe back into the parent document blurs the iframe
      // window while leaving iframeDoc.activeElement pointing at the previous editor.
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

/** The update policy. `watch` opens the page's one publication watch (the default
 * tendril.js entry does; the bare kernel stays without host connections unless asked). */
export function watchPublicationUpdates(cfg: TendrilConfig, options: {
  pinned: boolean;
  watch?: boolean;
  reload?: () => void;
  policy?: UpdatePolicy;
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
  const policy = (): UpdatePolicy => options.policy ?? authoredUpdatePolicy();
  const reload = options.reload ?? (() => location.reload());
  const beforeReloadTimeoutMs = Math.max(100, options.beforeReloadTimeoutMs ?? 2500);
  const latestUrl = () => new URL(cfg.base, location.href).href;
  let activeVersion = cfg.version;
  let available: number | null = null, availableUpdate: PublicationUpdate | null = null;
  let switching = false, switchReset: ReturnType<typeof setTimeout> | undefined, closed = false;
  let noticeEpoch = 0;

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
  const safe = () =>
    holds.size === 0
    && !hasComposing()
    && !hasActivePointer()
    && (policy() === "careful" ? !unsavedInput() : !typedDraftPending(edited));

  const announce = (update: PublicationUpdate) => {
    for (const listener of listeners) { try { listener(update); } catch { /* Observers cannot block the switch. */ } }
  };

  const commitReload = () => {
    // If the navigation is aborted or fails transiently (e.g. dev reload or brief drop), allow a later retry.
    clearTimeout(switchReset);
    switchReset = setTimeout(() => { switching = false; switchReset = undefined; }, 5000);
    reload();
  };

  const attempt = () => {
    if (closed || available === null || options.pinned || switching || !safe()) return;
    switching = true;
    if (beforeReloadHandlers.size === 0) {
      commitReload();
      return;
    }
    const pendingUpdate = availableUpdate ?? Object.freeze({ version: available, kind: "reload" as const });
    const handlers = [...beforeReloadHandlers];
    let timedOut = false;
    let vetoed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runAll = Promise.all(handlers.map(async (handler) => {
      try {
        const result = await handler(pendingUpdate);
        if (result === false) vetoed = true;
      } catch {
        // A failing flush hook must not crash the update watcher.
      }
    }));
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, beforeReloadTimeoutMs);
    });
    void Promise.race([runAll, timeout]).then(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (closed || available === null || options.pinned || vetoed || !safe()) {
        switching = false;
        return;
      }
      void timedOut;
      commitReload();
    });
  };

  const browser = typeof document !== "undefined" && typeof document.addEventListener === "function" && typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (!browser) {
    return Object.freeze({
      pinned: options.pinned,
      policy: options.policy ?? "live",
      updateAvailable: false,
      onUpdate: () => () => {},
      onBeforeReload: () => () => {},
      hold: () => () => {},
      update() { reload(); },
      close() {},
    });
  }

  let watch: { close(): void } | undefined;
  const applyReloadNotice = (current: number, outcome?: PublicationChangeOutcome) => {
    if (available === current) return;
    available = current;
    availableUpdate = Object.freeze({
      version: current,
      kind: "reload",
      ...(outcome?.publication !== undefined ? { publication: outcome.publication } : {}),
      ...(outcome?.changedPaths !== undefined ? { changedPaths: outcome.changedPaths } : {}),
    });
    announce(availableUpdate);
    attempt();
  };

  if (options.watch) try {
    watch = watchPublicationSelection({ base: latestUrl(),
      onCurrent({ current }: { current: number }) {
        if (closed) return;
        const epoch = ++noticeEpoch;
        if (cfg.version === 0) {
          // A holding page opens the first release as soon as one is selected.
          if (current > 0 && !switching) { switching = true; reload(); }
          return;
        }
        if (current === 0 || current === activeVersion) {
          if (available !== null) {
            available = null; availableUpdate = null;
            announce({ version: null, kind: "reverted" });
          }
          return;
        }
        if (!options.pinned && options.onBeforeSwitch && options.hasHotSwappableSlots?.()) {
          void options.onBeforeSwitch(current).then(outcome => {
            if (closed || epoch !== noticeEpoch) return;
            if (outcome.handled && outcome.kind === "hot-swapped") {
              activeVersion = current;
              available = null;
              availableUpdate = null;
              announce(Object.freeze({
                version: current,
                kind: "hot-swapped",
                ...(outcome.publication !== undefined ? { publication: outcome.publication } : {}),
                ...(outcome.changedPaths !== undefined ? { changedPaths: outcome.changedPaths } : {}),
              }));
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

  // A resumed (BFCache, unfrozen or re-shown) tab switches at once if an update arrived.
  document.addEventListener("visibilitychange", attempt);
  window.addEventListener("pageshow", attempt);

  let deferred: ReturnType<typeof setTimeout> | undefined;
  const scheduleAttempt = () => {
    if (closed || available === null || options.pinned || switching) return;
    clearTimeout(deferred); deferred = setTimeout(attempt, 0);
  };

  const afterEdit = (event: Event) => {
    // Remember what the person actually edited; programmatic values never fire trusted events
    // (file inputs have no HTML default, so any change populating files is an active user attachment).
    if (event.type === "input" || event.type === "change" || event.type === "beforeinput") {
      const element = editedElement(event);
      if (element && (event.isTrusted || ((event.type === "input" || event.type === "change") && isInput(element) && element.type === "file"))) {
        edited.add(isHtmlElement(element) && element.isContentEditable ? editableHost(element) : element);
      }
    }
    scheduleAttempt();
  };

  // Only recheck after an event that can change safety. A reset event arrives
  // before native defaults are restored, hence the single deferred attempt.
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

    // Attach to any same-origin iframes already present in this document.
    try {
      for (const frame of doc.querySelectorAll("iframe")) {
        if (isIframe(frame)) attachDocument(sameOriginDocument(frame));
      }
    } catch { /* Ignore detached/restricted frame trees. */ }
  };

  attachDocument(document);

  return Object.freeze({
    pinned: options.pinned,
    get policy() { return policy(); },
    get updateAvailable() { return available !== null; },
    onUpdate(listener: (update: PublicationUpdate) => void) {
      if (closed) return () => {};
      listeners.add(listener);
      if (available !== null) listener(availableUpdate ?? { version: available, kind: "reload" });
      return () => { listeners.delete(listener); };
    },
    onBeforeReload(handler: BeforeReloadHandler) {
      if (closed || typeof handler !== "function") return () => {};
      beforeReloadHandlers.add(handler);
      return () => { beforeReloadHandlers.delete(handler); };
    },
    hold(reason?: string) {
      const token = {};
      if (!closed) holds.set(token, reason);
      return () => { if (holds.delete(token)) attempt(); };
    },
    update() { if (closed) return; switching = true; if (options.pinned) location.assign(documentUrl(cfg, new URL(latestUrl())).href); else reload(); },
    close() {
      if (closed) return;
      closed = true; clearTimeout(deferred); clearTimeout(switchReset); watch?.close();
      document.removeEventListener("visibilitychange", attempt); window.removeEventListener("pageshow", attempt);
      for (const cleanup of attachedDocs.values()) { try { cleanup(); } catch {} }
      attachedDocs.clear();
      holds.clear(); listeners.clear(); beforeReloadHandlers.clear(); edited.clear();
      composingDocs.clear(); activePointers.clear(); available = null;
    },
  });
}
