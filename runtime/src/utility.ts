import { mountTransportInspector } from "./transport-view";
import { encodePublicationPath } from "./paths";
import { observeUtilityBar, observeVisualViewport, utilityBottom, utilityMaxWidth, utilityRight, utilityTop } from "./utility-layout";
import { renderQrSvg } from "./qr";
import type { RuntimeApi, SensorStatus } from "../../contract/index.mjs";

const labels: Record<string, string> = { camera: "Camera", microphone: "Microphone", screen: "Screen sharing", location: "Location", motion: "Motion", wake_lock: "Keep awake" };
const SUGGEST_AFTER_MS = 12_000;
const DISMISS_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/** Local-only presentation; caller inserts message as text, never markup. */
export function sensorSummary(status: SensorStatus) {
  const resources = status.resources ?? [];
  const name = (kind: string) => labels[kind] ?? kind;
  // A pending custom loop must not mask an independently active core sensor
  // of the same kind (and vice versa). Deduplicate only within the same phase.
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
  return { message: parts.join(". "), names, visible: parts.length > 0,
    // A page can report stopping/failed before the runtime has cancelled it.
    // Keep Stop reachable; repeating a requested cleanup is already idempotent.
    canStop: status.active.length > 0 || status.pending.length > 0 || resources.length > 0 };
}

/** Page installation, explicit offline saving and always-reachable sensor cancellation. */
export function mountUtility(api: RuntimeApi): () => void {
  const host = document.createElement("tendril-utility");
  host.style.cssText = `position:fixed!important;inset:auto ${utilityRight} ${utilityBottom} auto!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;max-width:${utilityMaxWidth}!important;max-height:calc(100vh - ${utilityTop} - ${utilityBottom})!important;max-height:calc(100dvh - ${utilityTop} - ${utilityBottom})!important;contain:layout style!important;`;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial;color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:CanvasText}
    *{box-sizing:border-box}[hidden]{display:none!important}
    nav,.card{border:1px solid #8886;background:Canvas;color:CanvasText;box-shadow:0 4px 24px #0002}
    nav{display:flex;flex-shrink:0;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:4px;padding:4px;border-radius:14px;margin-left:auto;width:fit-content;max-width:100%;transition:opacity .15s}
    nav.tucked{opacity:0;pointer-events:none}
    a,button{font:inherit;color:inherit;min-height:44px;padding:10px 12px;border:0;border-radius:9px;background:transparent;text-decoration:none;cursor:pointer;touch-action:manipulation}
    a:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
    button:hover,a:hover{background:#8882}button:disabled{opacity:.65;cursor:default}
    .stop{background:#a32020;color:white}.stop:hover{background:#8e1717}
    .sensors{padding:0 8px;max-width:min(54vw,260px);font-size:12px;overflow-wrap:anywhere}
    .options{font-weight:650}.card{flex-shrink:1;min-height:0;width:min(360px,calc(100vw - 24px));max-width:100%;border-radius:16px;padding:18px;margin:0 0 10px auto;overflow:auto;max-height:calc(100vh - var(--tendril-utility-height,54px) - 10px - ${utilityTop} - ${utilityBottom});max-height:calc(100dvh - var(--tendril-utility-height,54px) - 10px - ${utilityTop} - ${utilityBottom})}
    .heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
    h2{font-size:18px;line-height:1.3;margin:3px 0 10px;font-weight:700;letter-spacing:-.02em}h2:focus{outline:none}
    h3{font-size:14px;margin:0 0 6px}p{margin:0 0 12px}ol{margin:0 0 12px;padding-left:22px}li+li{margin-top:7px}
    .close{font-size:22px;line-height:1;padding:4px;min-width:44px;flex:none;margin:-8px -8px 0 0}
    .primary{display:block;background:#1e644a;color:white;font-weight:650;width:100%;margin-bottom:10px}.primary:hover{background:#174d39}
    .secondary{border:1px solid #8888;width:100%;font-weight:600}.note{font-size:12px;opacity:.8}
    .section{border-top:1px solid #8885;padding-top:14px;margin-top:14px}.links{display:flex;flex-wrap:wrap;gap:2px;margin:12px -8px -8px;border-top:1px solid #8885;padding-top:6px}.links a{font-size:12px}
    .diag-list{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:6px}.diag-item{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 8px;border-radius:8px;background:#8881;overflow-wrap:anywhere}
    .diag-actions{display:flex;gap:6px;flex-wrap:wrap}.diag-actions .secondary{width:auto;flex:1}
    .share-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.share-bar button{flex:1;min-width:110px}
    .share-primary-row{display:flex;gap:6px;margin-bottom:8px}.share-primary-row .primary{margin-bottom:0;flex:1}.share-primary-row .qr-toggle{flex:0 0 auto;border:1px solid #8888;font-weight:600;white-space:nowrap}
    .qr-box{margin:8px 0;padding:12px;border-radius:12px;background:#fff;color:#111;border:1px solid #8884;display:grid;justify-items:center;gap:6px}
    .qr-box svg{display:block;width:184px;height:184px;max-width:100%;height:auto}
    .qr-caption{font-size:11px;color:#444;text-align:center}
    .ready-share{border:1px solid #1e644a88;background:#1e644a14;border-radius:12px;padding:10px;margin:8px 0;display:grid;gap:6px}
    .ready-share strong{font-size:13px}
    .share-opts{margin:6px 0 8px}.share-opts summary{font-size:12px;opacity:.85;cursor:pointer;padding:4px 0}
    .share-fields{display:grid;gap:6px;margin-top:6px}.share-fields input,.share-fields select{font:inherit;font-size:13px;padding:7px 9px;border:1px solid #8886;border-radius:8px;background:Canvas;color:CanvasText;width:100%}
    .share-list{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:8px}
    .share-item{border:1px solid #8884;border-radius:10px;padding:8px 10px;display:grid;gap:6px;background:#8881}
    .share-top{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:13px}.share-role{font-size:11px;font-weight:650;padding:2px 7px;border-radius:999px;background:#1e644a22;color:#1e644a}
    .share-url{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.8;overflow-wrap:anywhere}
    .share-row-actions{display:flex;gap:6px;flex-wrap:wrap}.share-row-actions button{min-height:34px;padding:5px 10px;font-size:12px;border:1px solid #8886;width:auto;flex:1}
    .share-row-actions .revoke{color:#a32020;border-color:#a3202055;flex:0 0 auto}.share-row-actions .revoke:hover{background:#a3202018}
    .guest-box{margin-top:8px;padding-top:8px;border-top:1px solid #8884}
    .add{display:inline-flex;align-items:center;gap:6px;font-weight:650}.add svg{width:18px;height:18px;flex:none}
    .seg{display:flex;gap:3px;padding:3px;border-radius:12px;background:#8881;border:1px solid #8883;margin:0 0 12px}
    .seg button{flex:1;min-height:38px;padding:6px 8px;font-size:13px;font-weight:600;border-radius:9px;opacity:.8}
    .seg button[aria-selected=true]{background:Canvas;opacity:1;box-shadow:0 1px 3px #0003}
    .tabpanel h4{font-size:13px;margin:0 0 6px}
    .agent-fields{display:grid;gap:6px;margin-bottom:8px}.agent-fields input[type=text]{font:inherit;font-size:13px;padding:8px 10px;border:1px solid #8886;border-radius:8px;background:Canvas;color:CanvasText;width:100%}
    .scopes{display:grid;gap:2px;font-size:12px}.scopes label{display:flex;gap:8px;align-items:flex-start;padding:5px 2px;cursor:pointer}.scopes input{margin-top:2px}
    .blurb{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;width:100%;min-height:180px;padding:8px;border:1px solid #8886;border-radius:8px;background:#8881;color:CanvasText;resize:vertical}
    .message{font-size:13px;margin:10px 0 0}.suggestion p{margin:0 0 8px}.suggestion strong{font-size:16px}.actions{display:flex;align-items:center;gap:6px}.actions .primary{width:auto;margin:0;flex:1}.actions button{white-space:nowrap}
    @media(prefers-color-scheme:dark){.primary{background:#a6dfbd;color:#123b2b}.primary:hover{background:#bcebcf}.share-role{background:#a6dfbd22;color:#a6dfbd}.share-row-actions .revoke{color:#fca5a5;border-color:#fca5a555}}
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

  let disposed = false;
  let voiceControls: { dispose(): void; element: HTMLElement } | null = null;
  // The runtime owns the page's one publication watch and switches at the next safe
  // point. This card is shown while a switch waits (unsaved input, an application hold,
  // or a page pinned to its release), with an explicit way to open the update now.
  const update = element("aside", undefined, "card"); update.hidden = true;
  update.setAttribute("aria-label", "Publication update"); update.setAttribute("role", "status"); update.setAttribute("aria-live", "polite");
  // A link to the page's own address: following it loads the latest selected release.
  const openUpdate = element("a", "Open update", "primary"); openUpdate.href = api.identity.documentPath && api.identity.documentPath !== "index.html"
    ? new URL(encodePublicationPath(api.identity.documentPath), api.identity.base).href : api.identity.base;
  update.append(element("strong", "New version published"), element("p", api.publication.pinned
    ? "This address shows a fixed version. Open the latest version when you are ready."
    : "This page switches to it as soon as no unsaved changes are open.", "note"), openUpdate);
  const offUpdate = api.publication.onUpdate(({ version }) => { if (!disposed) update.hidden = version === null; });
  const nav = element("nav"); nav.setAttribute("aria-label", "Page operations");
  const active = element("span", undefined, "sensors"); active.setAttribute("role", "status");
  const stop = button("Stop sensors", "stop");
  stop.addEventListener("click", () => { api.sensors.stopAll(); options.focus(); });
  const addPeople = button("", "add");
  addPeople.setAttribute("aria-label", "Add people & devices"); addPeople.title = "Add people & devices";
  addPeople.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>';
  addPeople.setAttribute("aria-controls", "page-options");
  const options = button("Page options", "options");
  options.setAttribute("aria-expanded", "false"); options.setAttribute("aria-controls", "page-options");
  nav.append(active, stop, addPeople, options);

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
  const installSection = element("section");
  installSection.append(introduction, nativeInstall, steps, fallback, deviceNote, installMessage);
  panel.append(headingRow, installSection);

  const offline = element("section", undefined, "section");
  const save = button("Save for offline use", "secondary");
  const savedMessage = element("p", undefined, "message"); savedMessage.hidden = true; savedMessage.setAttribute("role", "status");
  offline.append(element("h3", "Use without a connection"),
    element("p", "Save this version’s page files on this device. Your app’s data and connections are managed separately.", "note"), save, savedMessage);
  offline.hidden = !api.identity.publication || !("serviceWorker" in navigator);

  type ShareLink = { id: string; url: string; role: "owner" | "guest" | "display"; label: string | null; email?: string | null; expires_at: number | null };
  const canNativeShare = () => typeof navigator.share === "function";
  const buildQrBox = (url: string, caption: string) => {
    const box = element("div", undefined, "qr-box");
    try {
      box.innerHTML = renderQrSvg(url, { label: caption, sizePx: 184 });
      box.append(element("span", caption, "qr-caption"));
    } catch {
      box.append(element("span", "Link is too long for a QR code.", "qr-caption"));
    }
    return box;
  };
  const shareSection = element("section", undefined, "section");
  const shareHeading = element("h3", "Add people & devices"); shareHeading.tabIndex = -1;
  const shareIntro = element("p", "Open this page on another device, invite someone, or connect another agent.", "note");
  const shareMessage = element("p", undefined, "message"); shareMessage.hidden = true; shareMessage.setAttribute("role", "status");
  // Segmented tabs: nothing is fetched until a person or agent tab is chosen.
  const seg = element("div", undefined, "seg"); seg.setAttribute("role", "tablist"); seg.setAttribute("aria-label", "Add people and devices");
  const tabNames = ["My device", "A person", "An agent"] as const;
  const tabs = tabNames.map(name => { const tab = button(name); tab.setAttribute("role", "tab"); return tab; });
  const panels = tabNames.map(() => { const panel = element("div", undefined, "tabpanel"); panel.setAttribute("role", "tabpanel"); return panel; });
  seg.append(...tabs);
  const [devicePanel, personPanel, agentPanel] = panels as [HTMLDivElement, HTMLDivElement, HTMLDivElement];

  const shareCurrentRow = element("div", undefined, "share-primary-row");
  const shareCurrentBtn = button(canNativeShare() ? "Share this page" : "Copy page link", "primary");
  const shareCurrentQrBtn = button("QR code", "qr-toggle");
  shareCurrentQrBtn.setAttribute("aria-expanded", "false");
  const shareCurrentQrSlot = element("div"); shareCurrentQrSlot.hidden = true;
  shareCurrentRow.append(shareCurrentBtn, shareCurrentQrBtn);
  devicePanel.append(element("p", "Scan the code with your other device’s camera, or send it the link. Sign in there with the same account.", "note"),
    shareCurrentRow, shareCurrentQrSlot);

  const readyShareBox = element("div", undefined, "ready-share"); readyShareBox.hidden = true;
  const inviteDetails = element("details", undefined, "share-opts");
  const inviteSummary = element("summary", "Manage existing links");
  const shareOwnerBox = element("div"); shareOwnerBox.hidden = true;
  const inviteBtn = button("Invite person", "secondary");
  const displayBtn = button("Page-only link", "secondary");
  const shareBar = element("div", undefined, "share-bar"); shareBar.append(inviteBtn, displayBtn);
  const shareFields = element("div", undefined, "share-fields");
  const shareEmail = document.createElement("input"); shareEmail.type = "email"; shareEmail.maxLength = 254; shareEmail.placeholder = "Their email (optional, locks the invite)";
  shareEmail.setAttribute("aria-label", "Restrict invite to email (optional)");
  const shareLabel = document.createElement("input"); shareLabel.type = "text"; shareLabel.maxLength = 100; shareLabel.placeholder = "Optional label (e.g. Alex or Tablet)";
  shareLabel.setAttribute("aria-label", "Invite label (optional)");
  const shareExpiry = document.createElement("select"); shareExpiry.setAttribute("aria-label", "Link expiry");
  for (const [val, text] of [["604800", "Expires in 7 days"], ["86400", "Expires in 24 hours"], ["2592000", "Expires in 30 days"], ["", "No expiry"]]) {
    const opt = document.createElement("option"); opt.value = val; opt.textContent = text; shareExpiry.append(opt);
  }
  shareFields.append(shareEmail, shareLabel, shareExpiry);
  const shareList = element("ul", undefined, "share-list");
  inviteDetails.append(inviteSummary, shareList);
  shareOwnerBox.append(element("p", "They sign in with GitHub or Google to join. Page-only links open the page files without sign-in.", "note"), shareFields, shareBar, readyShareBox, inviteDetails);
  const shareVisitorNote = element("p", "Only the page owner can create invite or page-only links.", "note"); shareVisitorNote.hidden = true;
  const ownerLoading = element("p", "Loading…", "note");
  personPanel.append(ownerLoading, shareOwnerBox, shareVisitorNote);

  const agentOwnerBox = element("div"); agentOwnerBox.hidden = true;
  const agentFields = element("div", undefined, "agent-fields");
  const agentName = document.createElement("input"); agentName.type = "text"; agentName.maxLength = 64; agentName.placeholder = "Agent name (e.g. reviewer)";
  agentName.setAttribute("aria-label", "Agent name"); agentName.autocomplete = "off";
  const scopeBox = element("details", undefined, "share-opts"); scopeBox.append(element("summary", "Host permissions"));
  const scopeList = element("div", undefined, "scopes");
  for (const [value, label, on] of [["host:read", "Read host status", true], ["participants:connect", "Connect enrolled participants", true],
    ["control:write", "Update signed application control", false], ["publication:write", "Publish signed code", false], ["assistant:manage", "Propose assistant access", false]] as const) {
    const row = document.createElement("label"); const box = document.createElement("input");
    // Initial permissions are defaults, not an unsaved edit in this open shadow root.
    box.type = "checkbox"; box.value = value; box.defaultChecked = on; row.append(box, element("span", label)); scopeList.append(row);
  }
  scopeBox.append(scopeList);
  const agentCreate = button("Create agent invitation", "primary");
  agentFields.append(agentName, scopeBox, agentCreate);
  const agentResult = element("div", undefined, "ready-share"); agentResult.hidden = true;
  const agentBlurb = document.createElement("textarea"); agentBlurb.readOnly = true; agentBlurb.className = "blurb";
  agentBlurb.setAttribute("aria-label", "Agent invitation to paste");
  const agentCopy = button("Copy invitation", "primary"), agentCopyLink = button("Copy as short link message", "secondary");
  let agentLinkText = "";
  agentResult.append(element("strong", "Paste this to the other agent"), agentBlurb, agentCopy, agentCopyLink,
    element("p", "Single use, valid for 10 minutes. Existing agents keep their access.", "note"));
  agentOwnerBox.append(element("p", "Creates a paste-ready invitation with a one-time code for another agent, such as a second coding assistant.", "note"), agentFields, agentResult);
  const agentVisitorNote = element("p", "Only the page owner can connect agents.", "note"); agentVisitorNote.hidden = true;
  const agentLoading = element("p", "Loading…", "note");
  agentPanel.append(agentLoading, agentOwnerBox, agentVisitorNote);

  const manualLink = document.createElement("input"); manualLink.type = "text"; manualLink.readOnly = true; manualLink.hidden = true;
  manualLink.setAttribute("aria-label", "Link to copy"); manualLink.style.cssText = "width:100%;font:inherit";
  shareSection.append(shareHeading, shareIntro, seg, ...panels, shareMessage, manualLink);
  let ownerChecked = false;
  const selectTab = (index: number) => {
    tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    panels.forEach((panel, i) => { panel.hidden = i !== index; });
    if (index > 0 && !ownerChecked) void refreshShareState();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(index));
    tab.addEventListener("keydown", event => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = (index + step + tabs.length) % tabs.length; selectTab(next); tabs[next]!.focus(); event.preventDefault();
    });
  });
  selectTab(0);

  const notifSection = element("section", undefined, "section");
  const notifHeading = element("h3", "Notifications");
  const notifNote = element("p", "Receive alerts from this page even when it is closed.", "note");
  const notifBtn = button("Enable notifications", "secondary");
  const notifMessage = element("p", undefined, "message"); notifMessage.hidden = true; notifMessage.setAttribute("role", "status");
  notifSection.append(notifHeading, notifNote, notifBtn, notifMessage);
  notifSection.hidden = !api.notifications;
  let notifSubscribed = false;
  const renderNotifications = async () => {
    if (!api.notifications || disposed) return;
    try {
      const st = await api.notifications.status();
      if (disposed) return;
      notifSubscribed = st.subscribed;
      if (st.state === "unsupported") {
        notifSection.hidden = true;
        return;
      }
      notifSection.hidden = false;
      if (st.state === "install_required") {
        notifNote.textContent = "Add this page to your Home Screen first to enable push notifications on iOS.";
        notifBtn.hidden = true;
      } else if (st.state === "denied") {
        notifNote.textContent = "Notifications are blocked in your browser settings for this site.";
        notifBtn.hidden = true;
      } else {
        notifNote.textContent = st.subscribed
          ? "Push notifications are enabled on this device."
          : "Receive alerts from this page even when it is closed.";
        notifBtn.hidden = false;
        notifBtn.disabled = false;
        notifBtn.textContent = st.subscribed ? "Disable notifications" : "Enable notifications";
      }
    } catch { /* keep silent */ }
  };
  notifBtn.addEventListener("click", async () => {
    if (!api.notifications || notifBtn.disabled) return;
    notifBtn.disabled = true;
    notifMessage.hidden = false;
    try {
      if (notifSubscribed) {
        notifMessage.textContent = "Disabling notifications…";
        await api.notifications.disable();
        if (!disposed) notifMessage.textContent = "Notifications disabled on this device.";
      } else {
        notifMessage.textContent = "Enabling notifications…";
        const next = await api.notifications.enable();
        if (!disposed) {
          notifMessage.textContent = next.subscribed
            ? "Notifications enabled."
            : next.state === "denied"
              ? "Notifications were blocked."
              : next.state === "install_required"
                ? "Add this page to your Home Screen first."
                : "Notifications were not enabled.";
        }
      }
    } catch (err) {
      if (!disposed) notifMessage.textContent = err instanceof Error ? err.message : "Could not update notifications.";
    } finally {
      if (!disposed) { notifBtn.disabled = false; void renderNotifications(); }
    }
  });

  panel.append(shareSection, notifSection, offline);

  let sharePageName = document.title || "Tendriller page";
  const showShareStatus = (msg: string) => { shareMessage.hidden = false; shareMessage.textContent = msg; };
  const copyText = async (value: string, label = "Link copied.") => {
    manualLink.hidden = true;
    try { await navigator.clipboard.writeText(value); if (!disposed) showShareStatus(label); return true; }
    catch {
      if (disposed) return false;
      manualLink.value = value; manualLink.hidden = false; manualLink.focus(); manualLink.select();
      showShareStatus("Copy the selected link below."); return false;
    }
  };
  const deliverLink = async (url: string, title: string, text: string) => {
    if (canNativeShare()) {
      try { await navigator.share({ title, text, url }); showShareStatus("Shared."); return; }
      catch (err) { if ((err as { name?: string })?.name === "AbortError") return; }
    }
    await copyText(url, "Link copied to clipboard.");
  };
  shareCurrentBtn.addEventListener("click", () => {
    void deliverLink(location.href, sharePageName, `Open ${sharePageName}`);
  });
  shareCurrentQrBtn.addEventListener("click", () => {
    const show = shareCurrentQrSlot.hidden;
    shareCurrentQrSlot.hidden = !show;
    shareCurrentQrBtn.setAttribute("aria-expanded", String(show));
    if (show) {
      while (shareCurrentQrSlot.firstChild) shareCurrentQrSlot.firstChild.remove();
      shareCurrentQrSlot.append(buildQrBox(location.href, "Scan to open this page on another device"));
    }
  });
  const showReadyShare = (link: ShareLink) => {
    while (readyShareBox.firstChild) readyShareBox.firstChild.remove();
    const title = link.role === "guest" ? `Join ${sharePageName}` : `View ${sharePageName}`;
    readyShareBox.append(
      element("strong", link.role === "guest" ? "Invite link ready" : "Page-only link ready"),
      element("div", link.url, "share-url"),
    );
    const qrSlot = element("div"); qrSlot.hidden = true;
    const actionsRow = element("div", undefined, "share-row-actions");
    if (canNativeShare()) {
      const shareNow = button("Share", "primary");
      shareNow.addEventListener("click", () => { void deliverLink(link.url, sharePageName, title); });
      actionsRow.append(shareNow);
    }
    const copyNow = button("Copy");
    copyNow.addEventListener("click", () => { void copyText(link.url, "Link copied."); });
    const qrNow = button("QR");
    qrNow.addEventListener("click", () => {
      const show = qrSlot.hidden;
      qrSlot.hidden = !show;
      if (show && !qrSlot.firstChild) qrSlot.append(buildQrBox(link.url, "Scan on nearby device"));
    });
    actionsRow.append(copyNow, qrNow);
    readyShareBox.append(actionsRow, qrSlot);
    readyShareBox.hidden = false;
  };
  const renderShareLinks = (links: ShareLink[]) => {
    while (shareList.firstChild) shareList.firstChild.remove();
    // Keep expired links revocable: they still consume the host's link limits.
    const active = links.filter(l => l.role !== "owner");
    shareList.hidden = active.length === 0;
    for (const link of active) {
      const li = element("li", undefined, "share-item");
      const top = element("div", undefined, "share-top");
      const roleLabel = link.role === "guest" ? (link.email ? link.email : "Guest invite") : "Page-only";
      top.append(element("strong", link.label || (link.role === "guest" ? "Guest invite" : "Page-only")), element("span", roleLabel, "share-role"));
      const expired = link.expires_at !== null && link.expires_at <= Date.now();
      const urlEl = element("div", expired ? "Expired" : link.url, "share-url");
      const rowActions = element("div", undefined, "share-row-actions");
      const qrSlot = element("div"); qrSlot.hidden = true;
      if (!expired && canNativeShare()) {
        const shareBtn = button("Share");
        shareBtn.addEventListener("click", () => {
          void deliverLink(link.url, sharePageName, link.role === "guest" ? `Join ${sharePageName}` : `View ${sharePageName}`);
        });
        rowActions.append(shareBtn);
      }
      const copyBtn = button("Copy");
      copyBtn.addEventListener("click", () => { void copyText(link.url, `${link.role === "guest" ? "Guest invite" : "Page-only"} link copied.`); });
      if (!expired) {
        const qrBtn = button("QR");
        qrBtn.addEventListener("click", () => {
          const show = qrSlot.hidden;
          qrSlot.hidden = !show;
          if (show && !qrSlot.firstChild) qrSlot.append(buildQrBox(link.url, "Scan to open on another device"));
        });
        rowActions.append(copyBtn, qrBtn);
      } else {
        rowActions.append(copyBtn);
      }
      const revokeBtn = button("Revoke", "revoke");
      revokeBtn.addEventListener("click", async () => {
        revokeBtn.disabled = true;
        try {
          const res = await fetch(`${api.identity.base}_tendril/links/${encodeURIComponent(link.id)}`, { method: "DELETE", credentials: "same-origin" });
          if (!res.ok) throw Error();
          showShareStatus("Link revoked.");
          await refreshShareState();
        } catch {
          revokeBtn.disabled = false;
          showShareStatus("Could not revoke link.");
        }
      });
      copyBtn.disabled = expired;
      rowActions.append(revokeBtn);
      li.append(top, urlEl, rowActions, qrSlot);
      shareList.append(li);
    }
  };
  const showOwner = (owner: boolean) => {
    ownerLoading.hidden = agentLoading.hidden = true;
    shareOwnerBox.hidden = agentOwnerBox.hidden = !owner;
    shareVisitorNote.hidden = agentVisitorNote.hidden = owner;
  };
  const refreshShareState = async () => {
    if (disposed || !api.identity.base) return;
    try {
      const linksRes = await fetch(`${api.identity.base}_tendril/links`, { credentials: "same-origin", cache: "no-store" });
      if (disposed) return;
      if (linksRes.status === 403 || linksRes.status === 401) { ownerChecked = true; showOwner(false); return; }
      if (!linksRes.ok) throw Error();
      const data = await linksRes.json() as { name?: string; links?: ShareLink[] };
      if (data.name) sharePageName = data.name;
      ownerChecked = true; showOwner(true);
      renderShareLinks(data.links ?? []);
    } catch {
      if (disposed) return;
      showOwner(false);
      shareVisitorNote.textContent = agentVisitorNote.textContent = "Could not load sharing options while offline.";
    }
  };
  agentCreate.addEventListener("click", async () => {
    if (agentCreate.disabled) return;
    const name = agentName.value.trim();
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(name)) { showShareStatus("Choose an agent name using letters, numbers, dots, dashes or underscores."); agentName.focus(); return; }
    agentCreate.disabled = true; showShareStatus("Creating agent invitation…");
    try {
      const scopes = [...scopeList.querySelectorAll("input")].filter(box => box.checked).map(box => box.value);
      const res = await fetch(`${api.identity.base}_tendril/agents`, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, scopes }) });
      const data = await res.json().catch(() => null) as { blurb?: string; link_blurb?: string; error?: { message?: string } } | null;
      if (!res.ok || !data?.blurb) throw Error(data?.error?.message || "Could not create the invitation.");
      if (disposed) return;
      agentBlurb.value = data.blurb; agentLinkText = data.link_blurb ?? "";
      agentResult.hidden = false; agentName.value = ""; shareMessage.hidden = true;
      agentBlurb.focus(); agentBlurb.select();
    } catch (err) {
      if (!disposed) showShareStatus(err instanceof Error ? err.message : "Could not create the invitation.");
    } finally {
      if (!disposed) agentCreate.disabled = false;
    }
  });
  agentCopy.addEventListener("click", () => { void copyText(agentBlurb.value, "Invitation copied. Paste it to the other agent."); });
  agentCopyLink.addEventListener("click", () => { void copyText(agentLinkText, "Short message copied. Paste it to the other agent."); });
  const createShareLink = async (role: "guest" | "display", trigger: HTMLButtonElement) => {
    if (trigger.disabled) return;
    trigger.disabled = true;
    showShareStatus(role === "guest" ? "Creating invite link…" : "Creating page-only link…");
    try {
      const body: Record<string, unknown> = { role };
      if (role === "guest" && shareEmail.value.trim()) body.email = shareEmail.value.trim();
      if (shareLabel.value.trim()) body.label = shareLabel.value.trim();
      if (shareExpiry.value) body.expires_in = Number(shareExpiry.value);
      const res = await fetch(`${api.identity.base}_tendril/links`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw Error(err?.error?.message || "Could not create link.");
      }
      const created = await res.json() as ShareLink;
      shareEmail.value = "";
      shareLabel.value = "";
      showReadyShare(created);
      await refreshShareState();
      if (canNativeShare()) {
        showShareStatus("Link created. Tap Share, Copy, or QR below.");
      } else {
        await copyText(created.url, "Link created and copied to clipboard.");
      }
    } catch (err) {
      showShareStatus(err instanceof Error ? err.message : "Could not create link.");
    } finally {
      if (!disposed) trigger.disabled = false;
    }
  };
  inviteBtn.addEventListener("click", () => { void createShareLink("guest", inviteBtn); });
  displayBtn.addEventListener("click", () => { void createShareLink("display", displayBtn); });
  const voiceSection = element("section", undefined, "section");
  const voiceSetup = button("Set up voice input", "secondary");
  const voiceMessage = element("p", undefined, "message"); voiceMessage.hidden = true; voiceMessage.setAttribute("role", "status");
  const voiceContainer = element("div");
  voiceSection.append(element("h3", "Speech input"),
    element("p", "Tap to talk or choose an optional wake word while this page is visible. Review and copy your text. Microphone access and model downloads need your consent.", "note"),
    voiceSetup, voiceMessage, voiceContainer);
  panel.append(voiceSection);
  voiceSetup.addEventListener("click", async event => {
    if (!event.isTrusted || disposed || voiceSetup.disabled) return;
    voiceSetup.disabled = true; voiceMessage.hidden = false; voiceMessage.textContent = "Opening voice controls…";
    try {
      // Optional presentation loads only on a local click. The headless kernel,
      // initial page graph and service worker never acquire a microphone.
      const url = api.assetUrl("voice.mjs");
      const module = await import(/* @vite-ignore */ url) as typeof import("./voice/index");
      if (disposed) return;
      voiceControls = module.mountVoiceControls(api, { container: voiceContainer });
      voiceSetup.hidden = true; voiceMessage.hidden = true;
      const toggle = voiceControls.element.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-controls="voice-panel"]');
      toggle?.focus();
    } catch {
      if (disposed) return;
      voiceSetup.disabled = false; voiceMessage.textContent = "Voice controls could not load. Check your connection and try again; typed input remains available.";
    }
  });
  const transportInspector = mountTransportInspector(api.transport); panel.append(transportInspector.element);
  const diagnostics = element("section", undefined, "section"); diagnostics.hidden = true;
  const diagHeading = element("h3", "Diagnostics");
  const diagList = element("ul", undefined, "diag-list");
  const diagCopy = button("Copy diagnostic report", "secondary");
  const diagShare = button("Share report", "secondary");
  diagShare.hidden = !canNativeShare();
  const diagClear = button("Clear");
  const diagActions = element("div", undefined, "diag-actions"); diagActions.append(diagCopy, diagShare, diagClear);
  const diagMessage = element("p", undefined, "message"); diagMessage.hidden = true; diagMessage.setAttribute("role", "status");
  diagnostics.append(diagHeading, diagList, diagActions, diagMessage);
  panel.append(diagnostics);
  const renderDiagnostics = () => {
    const entries = api.errors?.list?.() ?? [];
    diagnostics.hidden = entries.length === 0;
    diagHeading.textContent = `Diagnostics (${entries.length})`;
    while (diagList.firstChild) diagList.firstChild.remove();
    for (const entry of entries.slice(-3).reverse()) {
      const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      diagList.append(element("li", `[${time}] ${entry.kind}: ${entry.message}`, "diag-item"));
    }
  };
  const buildDiagReport = () => JSON.stringify({
    page: api.identity.page,
    version: api.identity.version,
    publication: api.identity.publication,
    documentPath: api.identity.documentPath,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    userAgent: navigator.userAgent,
    transport: api.transport?.status?.() ?? null,
    errors: api.errors?.list?.() ?? [],
  }, null, 2);
  diagCopy.addEventListener("click", async () => {
    const report = buildDiagReport();
    diagMessage.hidden = false;
    try {
      await navigator.clipboard.writeText(report);
      diagMessage.textContent = "Diagnostic report copied.";
    } catch {
      diagMessage.textContent = "Could not access clipboard on this device.";
    }
  });
  diagShare.addEventListener("click", async () => {
    const report = buildDiagReport();
    diagMessage.hidden = false;
    try {
      await navigator.share({ title: `${sharePageName} diagnostics`, text: report });
      diagMessage.textContent = "Diagnostic report shared.";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") { diagMessage.hidden = true; return; }
      diagMessage.textContent = "Could not share report on this device.";
    }
  });
  diagClear.addEventListener("click", () => {
    api.errors?.clear?.();
    diagMessage.hidden = true;
    renderDiagnostics();
  });
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
  root.append(style, update, suggestion, panel, nav);

  let engaged = false, suggested = false, suppressed = false, installing = false;
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
      if (disposed || document.hidden || editing || !panel.hidden || sensors.active.length || sensors.pending.length || sensors.resources?.length || !eligible()) return;
      suggested = true; suggestion.hidden = false;
    }, SUGGEST_AFTER_MS);
  };
  const openPanel = () => {
    suggested = true; suggestion.hidden = true; cancelSuggestion(); panel.hidden = false;
    nav.classList?.remove("tucked");
    options.setAttribute("aria-expanded", "true"); heading.focus(); transportInspector.open(); renderDiagnostics();
    void renderNotifications();
  };
  const closePanel = () => {
    panel.hidden = true; options.setAttribute("aria-expanded", "false"); options.focus();
    updateKeyboardLayout();
  };
  options.addEventListener("click", () => { if (panel.hidden) openPanel(); else closePanel(); });
  addPeople.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    selectTab(0);
    if (shareCurrentQrSlot.hidden) shareCurrentQrBtn.click();
    shareSection.scrollIntoView?.({ block: "start" }); shareHeading.focus();
  });
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
    if (state === "installed") {
      installMessage.hidden = true;
      // When already installed as an app, promote Share & invite above Home Screen info.
      if (typeof headingRow.after === "function" && shareSection.previousSibling !== headingRow) {
        headingRow.after(shareSection);
        shareSection.className = "";
        installSection.className = "section";
        shareSection.after(installSection);
      }
    } else if (typeof headingRow.after === "function" && installSection.previousSibling !== headingRow) {
      headingRow.after(installSection);
      installSection.className = "";
      shareSection.className = "section";
      installSection.after(shareSection);
    }
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

  let lastKeyboardHeight = 0;
  const updateKeyboardLayout = () => {
    if (disposed) return;
    const focused = document.activeElement;
    const editingExternal = Boolean(
      focused && !host.contains(focused)
      && focused.matches("input,textarea,select,[contenteditable]:not([contenteditable=false])"),
    );
    const hasSensors = !stop.hidden;
    const kbOpen = lastKeyboardHeight > 120;
    if (kbOpen && hasSensors) {
      nav.classList?.remove("tucked");
      host.style.setProperty?.("bottom", `calc(${utilityBottom} + ${lastKeyboardHeight}px)`, "important");
    } else {
      host.style.setProperty?.("bottom", utilityBottom, "important");
      nav.classList?.toggle("tucked", kbOpen && editingExternal && panel.hidden && !hasSensors);
    }
  };
  const renderSensors = () => {
    const summary = sensorSummary(api.sensors.status());
    active.hidden = stop.hidden = !summary.visible;
    active.textContent = summary.message;
    active.title = summary.message;
    stop.disabled = !summary.canStop;
    stop.setAttribute("aria-label", "Stop " + summary.names.join(", "));
    if (summary.visible) { suggestion.hidden = true; cancelSuggestion(); } else scheduleSuggestion();
    updateKeyboardLayout();
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
  document.addEventListener("focusin", updateKeyboardLayout);
  document.addEventListener("focusout", updateKeyboardLayout);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  const attach = () => { const parent = document.body || document.documentElement; if (host.parentNode !== parent) parent.append(host); };
  const observer = new MutationObserver(attach);
  const offSensors = api.sensors.on(renderSensors), offInstallation = api.installation.on(renderInstallation);
  const offErrors = api.errors?.on?.(renderDiagnostics) ?? (() => {});
  renderInstallation(); renderSensors(); renderDiagnostics(); attach(); observer.observe(document, { childList: true, subtree: true });
  const offGeometry = observeUtilityBar(nav);
  const offViewport = observeVisualViewport(({ keyboardHeight }) => {
    lastKeyboardHeight = keyboardHeight;
    updateKeyboardLayout();
  });
  return () => {
    disposed = true; voiceControls?.dispose(); transportInspector.close(); offUpdate(); cancelSuggestion(); observer.disconnect(); offGeometry(); offViewport(); offSensors(); offInstallation(); offErrors();
    document.removeEventListener("pointerup", interact); document.removeEventListener("keydown", keydown);
    document.removeEventListener("focusin", updateKeyboardLayout); document.removeEventListener("focusout", updateKeyboardLayout);
    window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); host.remove();
  };
}
