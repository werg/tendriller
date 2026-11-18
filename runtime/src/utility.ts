import type { RuntimeApi } from "../../contract/index.mjs";

const labels: Record<string, string> = { camera: "Camera", microphone: "Microphone", screen: "Screen sharing", location: "Location", motion: "Motion" };
const SUGGEST_AFTER_MS = 12_000;
const DISMISS_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/** Page installation, explicit offline saving and always-reachable sensor cancellation. */
export function mountUtility(api: RuntimeApi): () => void {
  const host = document.createElement("tendril-utility");
  host.style.cssText = "position:fixed!important;inset:auto max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) auto!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;max-width:calc(100vw - 24px)!important;max-height:calc(100vh - 24px)!important;max-height:calc(100dvh - 24px - env(safe-area-inset-bottom))!important;contain:layout style!important;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial;color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:CanvasText}
    *{box-sizing:border-box}[hidden]{display:none!important}
    nav,.card{border:1px solid #8886;background:Canvas;color:CanvasText;box-shadow:0 4px 24px #0002}
    nav{display:flex;flex-shrink:0;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:4px;padding:4px;border-radius:14px;margin-left:auto;width:fit-content;max-width:100%}
    a,button{font:inherit;color:inherit;min-height:44px;padding:10px 12px;border:0;border-radius:9px;background:transparent;text-decoration:none;cursor:pointer;touch-action:manipulation}
    a:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
    button:hover,a:hover{background:#8882}button:disabled{opacity:.65;cursor:default}
    .stop{background:#a32020;color:white}.stop:hover{background:#8e1717}
    .sensors{padding:0 8px;max-width:min(54vw,260px);font-size:12px}
    .options{font-weight:650}.card{flex-shrink:1;min-height:0;width:min(360px,calc(100vw - 24px));border-radius:16px;padding:18px;margin:0 0 10px auto;overflow:auto;max-height:calc(100vh - 112px);max-height:calc(100dvh - 112px - env(safe-area-inset-bottom))}
    .heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
    h2{font-size:18px;line-height:1.3;margin:3px 0 10px;font-weight:700;letter-spacing:-.02em}h2:focus{outline:none}
    h3{font-size:14px;margin:0 0 6px}p{margin:0 0 12px}ol{margin:0 0 12px;padding-left:22px}li+li{margin-top:7px}
    .close{font-size:22px;line-height:1;padding:4px;min-width:44px;flex:none;margin:-8px -8px 0 0}
    .primary{display:block;background:#1e644a;color:white;font-weight:650;width:100%;margin-bottom:10px}.primary:hover{background:#174d39}
    .secondary{border:1px solid #8888;width:100%;font-weight:600}.note{font-size:12px;opacity:.8}
    .section{border-top:1px solid #8885;padding-top:14px;margin-top:14px}.links{display:flex;flex-wrap:wrap;gap:2px;margin:12px -8px -8px;border-top:1px solid #8885;padding-top:6px}.links a{font-size:12px}
    .message{font-size:13px;margin:10px 0 0}.suggestion p{margin:0 0 8px}.suggestion strong{font-size:16px}.actions{display:flex;align-items:center;gap:6px}.actions .primary{width:auto;margin:0;flex:1}.actions button{white-space:nowrap}
    @media(prefers-color-scheme:dark){.primary{background:#a6dfbd;color:#123b2b}.primary:hover{background:#bcebcf}}
  `;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, className?: string) => {
    const node = element("button", text, className); node.type = "button"; return node;
  };

  const nav = element("nav"); nav.setAttribute("aria-label", "Page operations");
  const active = element("span", undefined, "sensors"); active.setAttribute("role", "status");
  const stop = button("Stop sensors", "stop");
  stop.addEventListener("click", () => api.sensors.stopAll());
  const options = button("Page options", "options");
  options.setAttribute("aria-expanded", "false"); options.setAttribute("aria-controls", "page-options");
  nav.append(active, stop, options);

  const panel = element("section", undefined, "card"); panel.id = "page-options"; panel.hidden = true;
  panel.setAttribute("aria-label", "Save and manage page");
  const heading = element("h2", "Keep this page handy"); heading.tabIndex = -1;
  const close = button("×", "close"); close.setAttribute("aria-label", "Close page options");
  const headingRow = element("div", undefined, "heading"); headingRow.append(heading, close);
  const introduction = element("p", "Add it to your Home Screen for a shortcut back to this page.");
  const nativeInstall = button("Add to Home Screen", "primary");
  const steps = element("ol");
  const fallback = element("p", undefined, "note");
  const deviceNote = element("p", "When you first open the Home Screen app, it may ask you to sign in or connect this device again.", "note");
  const installMessage = element("p", undefined, "message"); installMessage.hidden = true; installMessage.setAttribute("role", "status");
  panel.append(headingRow, introduction, nativeInstall, steps, fallback, deviceNote, installMessage);

  const offline = element("section", undefined, "section");
  const save = button("Save for offline use", "secondary");
  const savedMessage = element("p", undefined, "message"); savedMessage.hidden = true; savedMessage.setAttribute("role", "status");
  offline.append(element("h3", "Use without a connection"),
    element("p", "Save this version’s page files on this device. Your app’s data and connections are managed separately.", "note"), save, savedMessage);
  offline.hidden = !api.identity.publication || !("serviceWorker" in navigator);
  panel.append(offline);
  const links = element("div", undefined, "links");
  const latest = element("a", "Open latest version"); latest.href = api.identity.base;
  latest.title = "Open the currently selected publication";
  const manage = element("a", "Manage page"); manage.href = api.identity.managementUrl;
  manage.title = "Page recovery and device management"; manage.target = "_blank"; manage.rel = "noopener";
  if (api.identity.version > 0) links.append(latest);
  links.append(manage); panel.append(links);

  const suggestion = element("aside", undefined, "card suggestion"); suggestion.hidden = true;
  suggestion.setAttribute("aria-label", "Home screen suggestion");
  const pitch = element("p"); pitch.append(element("strong", "Keep this page one tap away"));
  const suggestAdd = button("Show me how", "primary"), dismiss = button("Not now");
  const actions = element("div", undefined, "actions"); actions.append(suggestAdd, dismiss);
  suggestion.append(pitch, element("p", "Add a shortcut to your Home Screen."), actions);
  root.append(style, suggestion, panel, nav);

  let disposed = false, engaged = false, suggested = false, suppressed = false, installing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismissalKey = "tendril:install-dismissed:" + api.identity.base;
  const cancelSuggestion = () => { clearTimeout(timer); timer = undefined; };
  const isDismissed = () => {
    if (suppressed) return true;
    try { return Number(localStorage.getItem(dismissalKey) || 0) > Date.now(); }
    catch { return false; }
  };
  const rememberDismissal = () => {
    suppressed = true; suggestion.hidden = true; cancelSuggestion();
    try { localStorage.setItem(dismissalKey, String(Date.now() + DISMISS_FOR_MS)); }
    catch { /* An in-memory dismissal still works when device storage is blocked. */ }
  };
  const eligible = () => {
    const state = api.installation.status();
    return !!api.identity.publication && state.platform !== "desktop"
      && (state.state === "available" || state.platform === "ios" && state.state === "manual") && !isDismissed();
  };
  const scheduleSuggestion = () => {
    if (!engaged || suggested || timer !== undefined || !panel.hidden || !eligible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      const focused = document.activeElement;
      const editing = focused?.matches("input,textarea,select,[contenteditable]:not([contenteditable=false])");
      const sensors = api.sensors.status();
      if (disposed || document.hidden || editing || !panel.hidden || sensors.active.length || sensors.pending.length || !eligible()) return;
      suggested = true; suggestion.hidden = false;
    }, SUGGEST_AFTER_MS);
  };
  const openPanel = () => {
    suggested = true; suggestion.hidden = true; cancelSuggestion(); panel.hidden = false;
    options.setAttribute("aria-expanded", "true"); heading.focus();
  };
  const closePanel = () => {
    panel.hidden = true; options.setAttribute("aria-expanded", "false"); options.focus();
  };
  options.addEventListener("click", () => { if (panel.hidden) openPanel(); else closePanel(); });
  close.addEventListener("click", closePanel);
  dismiss.addEventListener("click", () => { rememberDismissal(); options.focus(); });

  const renderInstallation = () => {
    const { state, platform } = api.installation.status();
    const focused = root.activeElement;
    const wasInstallFocused = focused && (focused === nativeInstall || suggestion.contains(focused));
    nativeInstall.hidden = state !== "available";
    nativeInstall.disabled = installing;
    deviceNote.hidden = platform !== "ios" || state === "installed" || state === "unavailable";
    steps.hidden = state !== "manual";
    fallback.hidden = state !== "manual";
    introduction.textContent = state === "installed" ? "This page is available as an app on this device."
      : state === "unavailable" ? "Open this page in a secure browser window to add it to your Home Screen."
      : "Add it to your Home Screen for a shortcut back to this page.";
    while (steps.firstChild) steps.firstChild.remove();
    if (platform === "ios") {
      for (const text of ["Tap Share. It may be inside your browser’s page menu.", "Choose Add to Home Screen.", "Keep Open as Web App enabled if shown, then tap Add."]) steps.append(element("li", text));
      fallback.textContent = "If the option is missing, open this page in Safari and check Share → Edit Actions.";
    } else if (platform === "android") {
      for (const text of ["Open your browser’s menu.", "Choose Add to Home Screen or Install app, then confirm."]) steps.append(element("li", text));
      fallback.textContent = "If the option is missing, open this page in Chrome or another browser that supports web apps.";
    } else {
      steps.append(element("li", "Look for Install in the address bar or browser menu. In Safari on Mac, choose File → Add to Dock."));
      fallback.textContent = "Available options depend on your browser. You can also bookmark this page.";
    }
    suggestAdd.textContent = state === "available" ? "Add to Home Screen" : "Show me how";
    if (!eligible()) { suggestion.hidden = true; cancelSuggestion(); }
    if (state === "installed") installMessage.hidden = true;
    if (!installing && wasInstallFocused && (state === "installed" || state === "unavailable")) options.focus();
    scheduleSuggestion();
  };
  const install = async () => {
    if (installing) return;
    installing = true; nativeInstall.disabled = true; suggestAdd.disabled = true;
    try {
      // Invoke before awaiting anything: the browser requires this click’s activation.
      const result = await api.installation.prompt();
      if (disposed) return;
      openPanel();
      if (result === "accepted") {
        rememberDismissal();
        installMessage.textContent = "Installation requested. Follow your browser’s confirmation, then open the new app icon.";
      } else if (result === "dismissed") {
        rememberDismissal(); installMessage.textContent = "You can add this page later from Page options.";
      } else {
        installMessage.textContent = "Use your browser’s menu to add this page. The steps above will help.";
      }
      installMessage.hidden = false;
    } catch {
      if (!disposed) {
        openPanel(); installMessage.hidden = false;
        installMessage.textContent = "The browser could not start installation. Try its menu to add this page.";
      }
    } finally {
      installing = false; suggestAdd.disabled = false;
      if (!disposed) renderInstallation();
    }
  };
  nativeInstall.addEventListener("click", () => { void install(); });
  suggestAdd.addEventListener("click", () => {
    if (api.installation.status().state === "available") void install(); else openPanel();
  });
  save.addEventListener("click", async () => {
    if (save.disabled) return;
    save.disabled = true; save.textContent = "Saving page files…"; savedMessage.hidden = false;
    savedMessage.textContent = "Keep this page open while its files are saved.";
    try {
      await api.publication.saveOffline();
      if (disposed) return;
      save.textContent = "Page files saved";
      savedMessage.textContent = "This version’s page files are saved on this device. App data and live features depend on the page.";
    } catch {
      if (disposed) return;
      save.disabled = false; save.textContent = "Try saving again";
      savedMessage.textContent = "Could not save the page files. Check your connection and try again.";
    }
  });

  const renderSensors = () => {
    const status = api.sensors.status();
    const sensors = [...new Set([...status.active, ...status.pending])];
    active.hidden = stop.hidden = sensors.length === 0;
    active.textContent = [
      status.active.length ? status.active.map(sensor => labels[sensor]).join(", ") + " active" : "",
      status.pending.length ? status.pending.map(sensor => labels[sensor]).join(", ") + " request pending" : "",
    ].filter(Boolean).join(". ");
    stop.setAttribute("aria-label", "Stop " + sensors.map(sensor => labels[sensor]).join(", "));
    if (sensors.length) { suggestion.hidden = true; cancelSuggestion(); } else scheduleSuggestion();
  };
  const interact = (event: Event) => {
    if (!event.isTrusted || event.composedPath().includes(host)) return;
    engaged = true; scheduleSuggestion();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !panel.hidden) { closePanel(); event.preventDefault(); }
    else interact(event);
  };
  const hide = () => { suggestion.hidden = true; cancelSuggestion(); };
  const show = () => { renderInstallation(); renderSensors(); };
  document.addEventListener("pointerup", interact);
  document.addEventListener("keydown", keydown);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  const attach = () => { const parent = document.body || document.documentElement; if (host.parentNode !== parent) parent.append(host); };
  const observer = new MutationObserver(attach);
  const offSensors = api.sensors.on(renderSensors), offInstallation = api.installation.on(renderInstallation);
  renderInstallation(); renderSensors(); attach(); observer.observe(document, { childList: true, subtree: true });
  return () => {
    disposed = true; cancelSuggestion(); observer.disconnect(); offSensors(); offInstallation();
    document.removeEventListener("pointerup", interact); document.removeEventListener("keydown", keydown);
    window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); host.remove();
  };
}
