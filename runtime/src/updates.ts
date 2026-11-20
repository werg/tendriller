// The page shows the latest selected release by default. The address bar keeps the
// page's own URL (assets resolve through the injected <base>), so a reload, a new tab
// or a discarded-and-restored tab loads whatever release is selected now. An open tab
// learns of a different selection over the page's one hibernating publication watch
// (contract/publication-watch.mjs) and switches at its next safe point: immediately
// when hidden or idle, otherwise once no input is focused or edited and no application
// hold is active. Pinning is explicit: a document opened at its immutable
// /_publications/ID/ URL stays on that release and only offers the update.
import { watchPublicationUpdates as watchPublicationSelection } from "../../contract/publication-watch.mjs";
import type { TendrilConfig } from "./types";

export interface PublicationUpdates {
  readonly pinned: boolean;
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

const EDITABLE = "input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),textarea,select,[contenteditable=''],[contenteditable=true]";

function unsavedInput(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && active.matches?.(EDITABLE)) return true;
  for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")) {
    if (element.type === "hidden" || element.readOnly || element.disabled) continue;
    if (element.value !== element.defaultValue) return true;
  }
  return false;
}

export function explicitlyPinned(cfg: TendrilConfig, href = location.href): boolean {
  return Boolean(cfg.publication) && new URL(href).pathname.includes("/_publications/");
}

const holdingStatus = (state: string) => state === "connected" ? "Your agent is preparing the first version. It will open here automatically."
  : state === "reconnecting" ? "Connection interrupted. Retrying automatically."
  : "This page could not be opened. Select Check now to try again.";

/** The update policy. `watch` opens the page's one publication watch (the default
 * tendril.js entry does; the bare kernel stays without host connections unless asked). */
export function watchPublicationUpdates(cfg: TendrilConfig, options: { pinned: boolean; watch?: boolean; reload?: () => void } = { pinned: false }): PublicationUpdates {
  const listeners = new Set<(update: { version: number | null }) => void>(), holds = new Set<object>();
  const reload = options.reload ?? (() => location.reload());
  const latestUrl = () => new URL(cfg.base, location.href).href;
  let available: number | null = null, switching = false;
  const safe = () => holds.size === 0 && (document.visibilityState === "hidden" || !unsavedInput());
  const announce = (version: number | null) => {
    for (const listener of listeners) { try { listener({ version }); } catch { /* Observers cannot block the switch. */ } }
  };
  const attempt = () => {
    if (available === null || options.pinned || switching || !safe()) return;
    switching = true; reload();
  };
  const browser = typeof document !== "undefined" && typeof document.addEventListener === "function" && typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (!browser) return Object.freeze({ pinned: options.pinned, updateAvailable: false, onUpdate: () => () => {}, hold: () => () => {}, update() { reload(); }, close() {} });
  let watch: { close(): void } | undefined;
  if (options.watch) try {
    watch = watchPublicationSelection({ base: latestUrl(),
      onCurrent({ current }: { current: number }) {
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
      onStatus({ state }: { state: string }) {
        if (cfg.version !== 0) return;
        const status = document.getElementById("publication-status");
        if (status) status.textContent = holdingStatus(state);
      } });
  } catch { /* A document outside its page origin has no publication watch. */ }
  // A resumed (BFCache, unfrozen or re-shown) tab switches at once if an update arrived.
  document.addEventListener("visibilitychange", attempt);
  window.addEventListener("pageshow", attempt);
  document.addEventListener("focusout", () => setTimeout(attempt, 0));
  document.addEventListener("change", () => setTimeout(attempt, 0));
  const interval = setInterval(attempt, 5000);
  return Object.freeze({
    pinned: options.pinned,
    get updateAvailable() { return available !== null; },
    onUpdate(listener: (update: { version: number | null }) => void) {
      listeners.add(listener);
      if (available !== null) listener({ version: available });
      return () => { listeners.delete(listener); };
    },
    hold() { const token = {}; holds.add(token); return () => { holds.delete(token); attempt(); }; },
    update() { switching = true; if (options.pinned) location.assign(latestUrl()); else reload(); },
    close() { clearInterval(interval); watch?.close(); },
  });
}
