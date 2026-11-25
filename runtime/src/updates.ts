// The page shows the latest selected release by default. The address bar keeps the
// page's own URL (assets resolve through the injected <base>), so a reload, a new tab
// or a discarded-and-restored tab loads whatever release is selected now. An open tab
// learns of a different selection over the page's one hibernating publication watch
// (contract/publication-watch.mjs) and switches by itself. Two policies:
//   live (default)  switch at once; only an application hold or text the person typed
//                   and has not yet sent/cleared defers it, with no prompt;
//   careful         opt in with <meta name="tendriller-updates" content="careful">: also
//                   wait for any focused editor or any control that differs from its HTML
//                   default, and show the "New version published" card meanwhile.
// Pinning is explicit: a document opened at its immutable /_publications/ID/ URL stays
// on that release and only offers the update.
import { watchPublicationUpdates as watchPublicationSelection, type AgentsRosterNotice } from "../../contract/publication-watch.mjs";
import { documentUrl } from "./document";
import type { TendrilConfig } from "./types";

export type UpdatePolicy = "live" | "careful";

export interface PublicationUpdates {
  readonly pinned: boolean;
  /** "live" switches as soon as nothing the person typed is pending; "careful" also waits for any focused or changed control. */
  readonly policy: UpdatePolicy;
  readonly updateAvailable: boolean;
  /** Called with the selected version when it differs from this document's release,
   * and with version null when the selection returns to this release (a rollback). */
  onUpdate(listener: (update: { version: number | null }) => void): () => void;
  /** Defers automatic switching (unsaved work) until the returned function is called. */
  hold(): () => void;
  /** Load the latest release now. */
  update(): void;
  close(): void;
}

const EDITABLE = "input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=hidden]),textarea,select";

function resetClone<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(element: T): T {
  const initial = element.cloneNode(true) as T;
  const form = document.createElement("form"); form.append(initial); form.reset();
  return initial;
}

/** Inspect native form defaults even after a preview disables a control. Walk open
 * shadow roots: document.activeElement alone only identifies their host. */
function unsavedInput(root: Document | ShadowRoot = document): boolean {
  const active = root.activeElement;
  if (active && active !== document.body && (active.matches(EDITABLE) || (active instanceof HTMLElement && active.isContentEditable))) return true;
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot && unsavedInput(element.shadowRoot)) return true;
    if (element instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "image"].includes(element.type)) continue;
      if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.value !== resetClone(element).value) return true;
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value !== resetClone(element).value) return true;
    } else if (element instanceof HTMLSelectElement) {
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
  const meta = typeof document !== "undefined" ? document.querySelector('meta[name="tendriller-updates" i]') : null;
  return meta?.getAttribute("content")?.trim().toLowerCase() === "careful" ? "careful" : "live";
}

/** The element a trusted edit event really targeted, also inside open shadow roots. */
function editedElement(event: Event): Element | null {
  const target = event.composedPath?.()[0] ?? event.target;
  return target instanceof Element ? target : null;
}

/** Live policy: only content the person typed and has not sent or cleared defers a switch. */
function typedDraftPending(edited: Set<Element>): boolean {
  for (const element of [...edited]) {
    if (!element.isConnected) { edited.delete(element); continue; }
    if (element instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "image", "range", "color"].includes(element.type)) { edited.delete(element); continue; }
      if (element.type === "checkbox" || element.type === "radio") { if (element.checked !== element.defaultChecked) return true; }
      else if (element.value !== "" && element.value !== resetClone(element).value) return true;
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value !== "" && element.value !== resetClone(element).value) return true;
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      if (element === (element.getRootNode() as Document | ShadowRoot).activeElement && element.textContent?.trim()) return true;
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
export function watchPublicationUpdates(cfg: TendrilConfig, options: { pinned: boolean; watch?: boolean; reload?: () => void; policy?: UpdatePolicy; onAgents?: (notice: AgentsRosterNotice) => void } = { pinned: false }): PublicationUpdates {
  const listeners = new Set<(update: { version: number | null }) => void>(), holds = new Set<object>(), edited = new Set<Element>();
  const policy = (): UpdatePolicy => options.policy ?? authoredUpdatePolicy();
  const reload = options.reload ?? (() => location.reload());
  const latestUrl = () => new URL(cfg.base, location.href).href;
  let available: number | null = null, switching = false, closed = false;
  const safe = () => holds.size === 0 && (policy() === "careful" ? !unsavedInput() : !typedDraftPending(edited));
  const announce = (version: number | null) => {
    for (const listener of listeners) { try { listener({ version }); } catch { /* Observers cannot block the switch. */ } }
  };
  const attempt = () => {
    if (closed || available === null || options.pinned || switching || !safe()) return;
    switching = true; reload();
  };
  const browser = typeof document !== "undefined" && typeof document.addEventListener === "function" && typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (!browser) return Object.freeze({ pinned: options.pinned, policy: options.policy ?? "live", updateAvailable: false, onUpdate: () => () => {}, hold: () => () => {}, update() { reload(); }, close() {} });
  let watch: { close(): void } | undefined;
  if (options.watch) try {
    watch = watchPublicationSelection({ base: latestUrl(),
      onCurrent({ current }: { current: number }) {
        if (closed) return;
        if (cfg.version === 0) {
          // A holding page opens the first release as soon as one is selected.
          if (current > 0 && !switching) { switching = true; reload(); }
          return;
        }
        if (current === 0 || current === cfg.version) { if (available !== null) { available = null; announce(null); } return; }
        if (available === current) return;
        available = current; announce(current);
        attempt();
      },
      onAgents(notice: AgentsRosterNotice) {
        if (!closed) options.onAgents?.(notice);
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
  const afterEdit = (event: Event) => {
    // Remember what the person actually edited; programmatic values never fire trusted events.
    if (event.isTrusted && (event.type === "input" || event.type === "change")) { const element = editedElement(event); if (element) edited.add(element); }
    if (closed || available === null || options.pinned || switching) return;
    clearTimeout(deferred); deferred = setTimeout(attempt, 0);
  };
  // Only recheck after an event that can change safety. A reset event arrives
  // before native defaults are restored, hence the single deferred attempt.
  const editEvents = ["input", "change", "focusout", "reset"];
  for (const event of editEvents) document.addEventListener(event, afterEdit, true);
  return Object.freeze({
    pinned: options.pinned,
    get policy() { return policy(); },
    get updateAvailable() { return available !== null; },
    onUpdate(listener: (update: { version: number | null }) => void) {
      if (closed) return () => {};
      listeners.add(listener);
      if (available !== null) listener({ version: available });
      return () => { listeners.delete(listener); };
    },
    hold() { const token = {}; if (!closed) holds.add(token); return () => { holds.delete(token); attempt(); }; },
    update() { if (closed) return; switching = true; if (options.pinned) location.assign(documentUrl(cfg, new URL(latestUrl())).href); else reload(); },
    close() {
      if (closed) return;
      closed = true; clearTimeout(deferred); watch?.close();
      document.removeEventListener("visibilitychange", attempt); window.removeEventListener("pageshow", attempt);
      for (const event of editEvents) document.removeEventListener(event, afterEdit, true);
      holds.clear(); listeners.clear(); edited.clear(); available = null;
    },
  });
}
