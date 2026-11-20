// The page shows the latest selected release by default. The address bar keeps the
// page's own URL (assets resolve through the injected <base>), so a reload, a new tab
// or a discarded-and-restored tab loads whatever release is selected now. An open tab
// learns of a newer release over one hibernating socket and switches at its next safe
// point: immediately when hidden or idle, otherwise once no input is focused or
// edited and no application hold is active. The watch is the runtime's only
// self-started host contact (see BROWSER_API.md). Pinning is explicit: a document opened
// at its immutable /_publications/ID/ URL stays on that release.
import type { TendrilConfig } from "./types";

export interface PublicationUpdates {
  readonly pinned: boolean;
  readonly updateAvailable: boolean;
  /** Called with the newer selected version when one is published. */
  onUpdate(listener: (update: { version: number }) => void): () => void;
  /** Defers automatic switching (unsaved work) until the returned function is called. */
  hold(): () => void;
  /** Load the latest release now. */
  update(): void;
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

export function watchPublicationUpdates(cfg: TendrilConfig, options: { pinned: boolean; reload?: () => void } = { pinned: false }): PublicationUpdates {
  const listeners = new Set<(update: { version: number }) => void>(), holds = new Set<object>();
  const reload = options.reload ?? (() => location.reload());
  let available: number | null = null, socket: WebSocket | null = null, retry = 1000, timer: ReturnType<typeof setTimeout> | undefined, switching = false;
  const safe = () => holds.size === 0 && (document.visibilityState === "hidden" || !unsavedInput());
  const attempt = () => {
    if (available === null || options.pinned || switching || !safe()) return;
    switching = true; reload();
  };
  const connect = () => {
    if (options.pinned || !cfg.publication || cfg.version < 1 || socket || available !== null || typeof WebSocket !== "function") return;
    const url = new URL(cfg.base + "_tendril/publication-ready", location.href);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:"; url.searchParams.set("after", String(cfg.version));
    let current: WebSocket;
    try { current = new WebSocket(url); } catch { return; }
    socket = current;
    current.addEventListener("message", event => {
      try {
        const value = JSON.parse(String(event.data));
        if (value?.t !== "ready" || !Number.isSafeInteger(value.version) || value.version <= cfg.version) return;
        available = value.version;
        for (const listener of listeners) { try { listener({ version: value.version }); } catch { /* Observers cannot block the switch. */ } }
        attempt();
      } catch { /* Only the bounded ready frame is meaningful. */ }
    });
    current.addEventListener("close", () => {
      if (socket === current) socket = null;
      if (available === null && document.visibilityState === "visible") { clearTimeout(timer); timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 60_000); }
    });
    current.addEventListener("open", () => { retry = 1000; });
  };
  const browser = typeof document !== "undefined" && typeof document.addEventListener === "function" && typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (!browser) return Object.freeze({ pinned: options.pinned, updateAvailable: false, onUpdate: () => () => {}, hold: () => () => {}, update() { reload(); } });
  // A resumed (BFCache, unfrozen or re-shown) tab rechecks at once.
  const resumed = () => { if (document.visibilityState === "visible") { connect(); attempt(); } else attempt(); };
  document.addEventListener("visibilitychange", resumed);
  window.addEventListener("pageshow", resumed);
  document.addEventListener("focusout", () => setTimeout(attempt, 0));
  document.addEventListener("change", () => setTimeout(attempt, 0));
  setInterval(attempt, 5000);
  // The only host contact this runtime starts by itself: one hibernating watch, opened
  // after the document has loaded and only while it is visible (a hidden tab connects
  // when it is next shown). Loading the page never waits on or contacts the host.
  if (document.readyState === "complete") setTimeout(() => { if (document.visibilityState === "visible") connect(); }, 0);
  else window.addEventListener("load", () => { if (document.visibilityState === "visible") connect(); }, { once: true });
  return Object.freeze({
    pinned: options.pinned,
    get updateAvailable() { return available !== null; },
    onUpdate(listener: (update: { version: number }) => void) {
      listeners.add(listener);
      if (available !== null) listener({ version: available });
      return () => { listeners.delete(listener); };
    },
    hold() { const token = {}; holds.add(token); return () => { holds.delete(token); attempt(); }; },
    update() { switching = true; if (options.pinned) location.assign(new URL(cfg.base, location.href)); else reload(); },
  });
}
