import type { CapabilityReport, RuntimeApi } from "../../../contract/index.mjs";
import { encodePublicationPath } from "../paths";
import { renderQrSvg } from "../qr";
import { nameTransportAgents } from "../transport";
import { mountTransportInspector } from "../transport-view";
import { btn, clearChildren, el, formatCountdown, formatExpiry, iconEl } from "./dom";

export type ShareLink = {
  id: string;
  url: string;
  role: "owner" | "guest" | "display";
  label: string | null;
  email?: string | null;
  view?: string | null;
  expires_at: number | null;
};

type PendingGuest = { account_id: string; link_id: string; created_at: number; email: string | null };

export interface ShareAgentsSharedState {
  pageName: string;
  canManage: boolean;
  ownerChecked: boolean;
  links: ShareLink[];
  pendingGuests: PendingGuest[];
  accountAgents: Array<{ id: string; handle: string; bio: string; granted: boolean }>;
  dashboardUrl: string;
  connectionsUrl: string;
  platformsUrl: string;
  mcpGrants: {
    configured: boolean;
    grants: Array<{ id: string; client_id: string; client_name: string; wrap_public_key: string }>;
    connections: Array<{ grant_id: string; handle: string; label: string }>;
  } | null;
}

const canNativeShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

function buildQrCard(url: string, caption: string): HTMLElement {
  const card = el("div", undefined, "qr-card");
  try {
    card.innerHTML = renderQrSvg(url, { label: caption, sizePx: 176 });
    card.append(el("span", caption, "qr-cap"));
  } catch {
    card.append(el("span", "Link is too long for a QR code.", "qr-cap"));
  }
  return card;
}

// ── 1. SHARE & INVITE MODAL ─────────────────────────────────────────────────
export function createShareModal(
  api: RuntimeApi,
  shared: ShareAgentsSharedState,
  onMetaChange: () => void,
) {
  let disposed = false;
  let activeTab: "device" | "person" | "links" = "device";
  let selectedRole: "guest" | "display" = "guest";
  let selectedExpiry = "604800";

  const body = el("div", undefined, "modal-body");
  const seg = el("div", undefined, "seg");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", "Share and invite");

  const tabSpecs = [
    ["device", "My device"],
    ["person", "Invite person"],
    ["links", "Links & requests"],
  ] as const;
  const tabBtns = tabSpecs.map(([id, label]) => {
    const b = btn(label);
    b.setAttribute("role", "tab");
    b.setAttribute("data-tab", id);
    return b;
  });
  seg.append(...tabBtns);

  const devicePanel = el("div", undefined, "stack"); devicePanel.setAttribute("role", "tabpanel");
  const personPanel = el("div", undefined, "stack"); personPanel.setAttribute("role", "tabpanel");
  const linksPanel = el("div", undefined, "stack"); linksPanel.setAttribute("role", "tabpanel");

  const statusMsg = el("p", undefined, "status-msg"); statusMsg.hidden = true; statusMsg.setAttribute("role", "status");
  const manualLink = el("input", undefined, "input"); manualLink.type = "text"; manualLink.readOnly = true; manualLink.hidden = true;
  manualLink.setAttribute("aria-label", "Link to copy");

  const setStatus = (msg: string, isError = false) => {
    statusMsg.hidden = !msg;
    statusMsg.textContent = msg;
    statusMsg.className = isError ? "status-msg error" : "status-msg";
  };

  const copyText = async (value: string, label = "Link copied.") => {
    manualLink.hidden = true;
    try {
      await navigator.clipboard.writeText(value);
      if (!disposed) setStatus(label);
      return true;
    } catch {
      if (disposed) return false;
      manualLink.value = value;
      manualLink.hidden = false;
      manualLink.focus();
      manualLink.select?.();
      setStatus("Copy the selected link below.");
      return false;
    }
  };

  const deliverLink = async (url: string, title: string, text: string) => {
    if (canNativeShare()) {
      try { await navigator.share({ title, text, url }); setStatus("Shared."); return; }
      catch (err) { if ((err as { name?: string })?.name === "AbortError") return; }
    }
    await copyText(url, "Link copied to clipboard.");
  };

  // ─ Tab 1: My Device ─
  const qrSlot = el("div");
  const deviceActions = el("div", undefined, "row");
  const shareCurrentBtn = btn(canNativeShare() ? "Share this page" : "Copy page link", "btn primary");
  shareCurrentBtn.style.flex = "1";
  const copyCurrentBtn = btn("Copy link", "btn");
  copyCurrentBtn.hidden = !canNativeShare();
  deviceActions.append(shareCurrentBtn, copyCurrentBtn);
  const deviceSteps = el("ol", undefined, "steps-list");
  for (const s of [
    "Scan this QR code with your phone or tablet camera, or send the link.",
    "Sign in with the same account you use here.",
    "Your device joins and syncs automatically.",
  ]) deviceSteps.append(el("li", s));
  const deviceStepsBox = el("div", undefined, "card-box");
  deviceStepsBox.append(el("strong", "Open on another device"), deviceSteps);
  devicePanel.append(qrSlot, deviceActions, deviceStepsBox);

  shareCurrentBtn.addEventListener("click", () => { void deliverLink(location.href, shared.pageName, `Open ${shared.pageName}`); });
  copyCurrentBtn.addEventListener("click", () => { void copyText(location.href, "Link copied to clipboard."); });

  // ─ Tab 2: Invite Person (Modern, clean card-based UI) ─
  const personLoading = el("p", "Loading sharing options…", "muted");
  const personVisitorNote = el("p", "Only the page owner can create invite or page-only links.", "muted"); personVisitorNote.hidden = true;
  const personOwnerWrap = el("div", undefined, "stack"); personOwnerWrap.hidden = true;

  const roleGrid = el("div", undefined, "role-grid");
  roleGrid.setAttribute("role", "radiogroup");
  roleGrid.setAttribute("aria-label", "Access level");
  const guestCard = btn("", "role-card"); guestCard.setAttribute("role", "radio"); guestCard.setAttribute("aria-checked", "true");
  guestCard.append(el("strong", "Collaborator"), el("span", "Signs in with GitHub or Google to join & sync"));
  const displayCard = btn("", "role-card"); displayCard.setAttribute("role", "radio"); displayCard.setAttribute("aria-checked", "false");
  displayCard.append(el("strong", "Page-only link"), el("span", "Opens page files without sign-in or private data"));
  roleGrid.append(guestCard, displayCard);

  const expiryWrap = el("div", undefined, "field");
  expiryWrap.append(el("label", "Link expiry"));
  const expiryChips = el("div", undefined, "chips");
  expiryChips.setAttribute("role", "group"); expiryChips.setAttribute("aria-label", "Link expiry");
  const EXPIRIES = [["86400", "24 hours"], ["604800", "7 days"], ["2592000", "30 days"], ["", "Never"]] as const;
  const expiryBtns = EXPIRIES.map(([val, label]) => {
    const c = btn(label, "chip");
    c.setAttribute("aria-pressed", String(val === selectedExpiry));
    c.addEventListener("click", () => {
      selectedExpiry = val;
      expiryBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(EXPIRIES[i]![0] === selectedExpiry)));
    });
    return c;
  });
  expiryChips.append(...expiryBtns);
  expiryWrap.append(expiryChips);

  const emailField = el("div", undefined, "field");
  emailField.append(el("label", "Lock to email (optional)"));
  const emailInput = el("input", undefined, "input");
  emailInput.type = "email"; emailInput.maxLength = 254; emailInput.placeholder = "name@example.com";
  emailInput.setAttribute("aria-label", "Restrict invite to email (optional)");
  emailField.append(emailInput);

  const labelField = el("div", undefined, "field");
  labelField.append(el("label", "Label (optional)"));
  const labelInput = el("input", undefined, "input");
  labelInput.type = "text"; labelInput.maxLength = 100; labelInput.placeholder = "e.g. Alex or Kitchen tablet";
  labelInput.setAttribute("aria-label", "Invite label (optional)");
  labelField.append(labelInput);

  const viewField = el("div", undefined, "field"); viewField.hidden = true;
  viewField.append(el("label", "Target view (optional)"));
  const viewSelect = el("select", undefined, "select");
  viewSelect.setAttribute("aria-label", "Target view (optional)");
  viewField.append(viewSelect);

  const refreshViewSelect = () => {
    const facets = api.publication?.facets ?? [];
    viewField.hidden = facets.length <= 1;
    if (viewField.hidden) return;
    const prev = viewSelect.value;
    clearChildren(viewSelect);
    const defOpt = el("option", "Default view for participant");
    defOpt.value = "";
    viewSelect.append(defOpt);
    for (const f of facets) {
      const opt = el("option", f.title ? `${f.title} (${f.id})` : f.id);
      opt.value = f.id;
      viewSelect.append(opt);
    }
    if (prev && facets.some(f => f.id === prev)) viewSelect.value = prev;
  };

  const createInviteBtn = btn("Create invite link", "btn primary full");
  const readyCard = el("div", undefined, "card-box highlight"); readyCard.hidden = true;

  const syncRoleUi = () => {
    guestCard.setAttribute("aria-checked", String(selectedRole === "guest"));
    displayCard.setAttribute("aria-checked", String(selectedRole === "display"));
    emailField.hidden = selectedRole !== "guest";
    createInviteBtn.textContent = selectedRole === "guest" ? "Create invite link" : "Create page-only link";
  };
  guestCard.addEventListener("click", () => { selectedRole = "guest"; syncRoleUi(); });
  displayCard.addEventListener("click", () => { selectedRole = "display"; syncRoleUi(); });
  syncRoleUi();

  personOwnerWrap.append(roleGrid, expiryWrap, emailField, labelField, viewField, createInviteBtn, readyCard);
  personPanel.append(personLoading, personOwnerWrap, personVisitorNote);

  // ─ Tab 3: Links & Pending Guest Requests ─
  const pendingBox = el("div", undefined, "stack-sm"); pendingBox.hidden = true;
  const pendingList = el("ul", undefined, "item-list");
  pendingBox.append(el("strong", "Waiting for approval"), pendingList);

  const linksHeader = el("div", undefined, "row-between");
  const linksCountLabel = el("strong", "Active links");
  const linksRefreshBtn = btn("Refresh", "btn sm");
  linksHeader.append(linksCountLabel, linksRefreshBtn);
  const linksList = el("ul", undefined, "item-list");
  const linksEmpty = el("p", "No invite or page-only links created yet.", "muted"); linksEmpty.hidden = true;
  const linksVisitor = el("p", "Only the page owner can view or revoke invite links.", "muted"); linksVisitor.hidden = true;
  const orgRulesBox = el("div", undefined, "stack-sm"); orgRulesBox.hidden = true;
  const orgRulesList = el("ul", undefined, "item-list");
  orgRulesBox.append(el("strong", "Team & org access rules"), orgRulesList);
  linksPanel.append(pendingBox, orgRulesBox, linksHeader, linksList, linksEmpty, linksVisitor);

  const showReadyLink = (link: ShareLink) => {
    clearChildren(readyCard);
    const title = link.role === "guest" ? "Invite link ready" : "Page-only link ready";
    readyCard.append(el("strong", title), el("div", link.url, "mono"));
    const qrHolder = el("div"); qrHolder.hidden = true;
    const actions = el("div", undefined, "row");
    if (canNativeShare()) {
      const shareNow = btn("Share", "btn sm primary");
      shareNow.addEventListener("click", () => { void deliverLink(link.url, shared.pageName, link.role === "guest" ? `Join ${shared.pageName}` : `View ${shared.pageName}`); });
      actions.append(shareNow);
    }
    const copyNow = btn("Copy link", "btn sm");
    copyNow.addEventListener("click", () => { void copyText(link.url, "Link copied."); });
    const qrNow = btn("QR code", "btn sm");
    qrNow.addEventListener("click", () => {
      const show = qrHolder.hidden;
      qrHolder.hidden = !show;
      if (show && !qrHolder.firstChild) qrHolder.append(buildQrCard(link.url, "Scan to open on another device"));
    });
    actions.append(copyNow, qrNow);
    readyCard.append(actions, qrHolder);
    readyCard.hidden = false;
  };

  const renderLinksAndGuests = () => {
    const active = shared.links.filter(l => l.role !== "owner");
    const badgeTotal = active.length + shared.pendingGuests.length;
    tabBtns[2]!.textContent = badgeTotal > 0 ? `Links (${badgeTotal})` : "Links & requests";

    // Pending guests
    pendingBox.hidden = !shared.canManage || shared.pendingGuests.length === 0;
    clearChildren(pendingList);
    for (const g of shared.pendingGuests) {
      const li = el("li", undefined, "item-card");
      const top = el("div", undefined, "row-between");
      top.append(el("strong", g.email || g.account_id), el("span", "Pending", "pill warn"));
      const row = el("div", undefined, "row");
      const approveBtn = btn("Approve", "btn sm primary");
      const declineBtn = btn("Decline", "btn sm danger");
      approveBtn.addEventListener("click", async () => {
        approveBtn.disabled = declineBtn.disabled = true;
        try {
          const res = await fetch(`${api.identity.base}_tendril/guests/${encodeURIComponent(g.account_id)}/${encodeURIComponent(g.link_id)}/approve`, { method: "POST", credentials: "same-origin" });
          if (!res.ok) throw Error();
          setStatus("Guest approved.");
          await refreshShare();
        } catch {
          approveBtn.disabled = declineBtn.disabled = false;
          setStatus("Could not approve guest.", true);
        }
      });
      declineBtn.addEventListener("click", async () => {
        approveBtn.disabled = declineBtn.disabled = true;
        try {
          const res = await fetch(`${api.identity.base}_tendril/guests/${encodeURIComponent(g.account_id)}/${encodeURIComponent(g.link_id)}/decline`, { method: "POST", credentials: "same-origin" });
          if (!res.ok) throw Error();
          setStatus("Guest request declined.");
          await refreshShare();
        } catch {
          approveBtn.disabled = declineBtn.disabled = false;
          setStatus("Could not decline guest.", true);
        }
      });
      row.append(approveBtn, declineBtn);
      li.append(top, row);
      pendingList.append(li);
    }

    linksVisitor.hidden = !shared.ownerChecked || shared.canManage;
    linksHeader.hidden = !shared.canManage;
    linksList.hidden = !shared.canManage || active.length === 0;
    linksEmpty.hidden = !shared.canManage || active.length > 0;
    linksCountLabel.textContent = `Active links (${active.length})`;
    clearChildren(linksList);
    for (const link of active) {
      const expired = link.expires_at !== null && link.expires_at <= Date.now();
      const li = el("li", undefined, "item-card");
      const top = el("div", undefined, "row-between");
      const roleText = link.role === "guest" ? "Collaborator" : "Page-only";
      const pills = el("div", undefined, "row");
      pills.append(el("span", roleText, link.role === "guest" ? "pill accent" : "pill"));
      if (link.email) pills.append(el("span", link.email, "pill"));
      if (link.view) pills.append(el("span", `View: ${link.view}`, "pill"));
      pills.append(el("span", formatExpiry(link.expires_at), expired ? "pill danger" : "pill"));
      top.append(el("strong", link.label || roleText), pills);

      const urlLine = el("div", expired ? "Expired" : link.url, "mono");
      const qrHolder = el("div"); qrHolder.hidden = true;
      const actions = el("div", undefined, "row");
      if (!expired && canNativeShare()) {
        const sBtn = btn("Share", "btn sm");
        sBtn.addEventListener("click", () => { void deliverLink(link.url, shared.pageName, link.role === "guest" ? `Join ${shared.pageName}` : `View ${shared.pageName}`); });
        actions.append(sBtn);
      }
      const cBtn = btn("Copy", "btn sm");
      cBtn.disabled = expired;
      cBtn.addEventListener("click", () => { void copyText(link.url, `${roleText} link copied.`); });
      actions.append(cBtn);
      if (!expired) {
        const qBtn = btn("QR", "btn sm");
        qBtn.addEventListener("click", () => {
          const show = qrHolder.hidden;
          qrHolder.hidden = !show;
          if (show && !qrHolder.firstChild) qrHolder.append(buildQrCard(link.url, "Scan to open on another device"));
        });
        actions.append(qBtn);
      }
      const rBtn = btn("Revoke", "btn sm danger");
      rBtn.addEventListener("click", async () => {
        rBtn.disabled = true;
        try {
          const res = await fetch(`${api.identity.base}_tendril/links/${encodeURIComponent(link.id)}`, { method: "DELETE", credentials: "same-origin" });
          if (!res.ok) throw Error();
          setStatus("Link revoked.");
          await refreshShare();
        } catch {
          rBtn.disabled = false;
          setStatus("Could not revoke link.", true);
        }
      });
      actions.append(rBtn);
      li.append(top, urlLine, actions, qrHolder);
      linksList.append(li);
    }
  };

  const syncOwnerVisibility = () => {
    personLoading.hidden = shared.ownerChecked;
    personOwnerWrap.hidden = !shared.ownerChecked || !shared.canManage;
    personVisitorNote.hidden = !shared.ownerChecked || shared.canManage;
    renderLinksAndGuests();
    onMetaChange();
  };

  const refreshShare = async () => {
    if (disposed || !api.identity?.base) return;
    try {
      const res = await fetch(`${api.identity.base}_tendril/links`, { credentials: "same-origin", cache: "no-store" });
      if (disposed) return;
      if (res.status === 401 || res.status === 403) {
        shared.ownerChecked = true; shared.canManage = false; shared.links = []; shared.pendingGuests = [];
        syncOwnerVisibility();
        return;
      }
      if (!res.ok) throw Error();
      const data = await res.json() as { name?: string; links?: ShareLink[] };
      if (data.name) shared.pageName = data.name;
      shared.ownerChecked = true; shared.canManage = true; shared.links = data.links ?? [];
      // Also fetch pending guest approvals and active org/group rules if available
      try {
        const gRes = await fetch(`${api.identity.base}_tendril/guests`, { credentials: "same-origin", cache: "no-store" });
        if (gRes.ok) {
          const gData = await gRes.json() as { guests?: PendingGuest[] };
          shared.pendingGuests = Array.isArray(gData.guests) ? gData.guests : [];
        }
      } catch { /* ignore */ }
      try {
        const grpRes = await fetch(`${api.identity.base}_tendril/groups`, { credentials: "same-origin", cache: "no-store" });
        if (grpRes.ok && !disposed) {
          const grpData = await grpRes.json() as { policy?: { payload?: { rules?: Array<{ ruleId: string; group: string; role: string; label?: string }> } } };
          const rules = grpData.policy?.payload?.rules ?? [];
          clearChildren(orgRulesList);
          orgRulesBox.hidden = rules.length === 0;
          for (const rule of rules) {
            const li = el("li", undefined, "item-card");
            const top = el("div", undefined, "row-between");
            top.append(el("strong", rule.label || rule.group), el("span", rule.role, "pill accent"));
            li.append(top);
            if (rule.label) li.append(el("div", rule.group, "mono"));
            orgRulesList.append(li);
          }
        }
      } catch { /* ignore */ }
      if (!disposed) syncOwnerVisibility();
    } catch {
      if (disposed) return;
      shared.ownerChecked = true; shared.canManage = false;
      personVisitorNote.textContent = "Could not load sharing options while offline.";
      syncOwnerVisibility();
    }
  };

  createInviteBtn.addEventListener("click", async () => {
    if (createInviteBtn.disabled) return;
    createInviteBtn.disabled = true;
    setStatus(selectedRole === "guest" ? "Creating invite link…" : "Creating page-only link…");
    try {
      const payload: Record<string, unknown> = { role: selectedRole };
      if (selectedRole === "guest" && emailInput.value.trim()) payload.email = emailInput.value.trim();
      if (labelInput.value.trim()) payload.label = labelInput.value.trim();
      if (!viewField.hidden && viewSelect.value) payload.view = viewSelect.value;
      if (selectedExpiry) payload.expires_in = Number(selectedExpiry);
      const res = await fetch(`${api.identity.base}_tendril/links`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw Error(err?.error?.message || "Could not create link.");
      }
      const created = await res.json() as ShareLink;
      emailInput.value = "";
      labelInput.value = "";
      viewSelect.value = "";
      showReadyLink(created);
      await refreshShare();
      if (canNativeShare()) setStatus("Link ready. Tap Share, Copy, or QR below.");
      else await copyText(created.url, "Link created and copied to clipboard.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not create link.", true);
    } finally {
      if (!disposed) createInviteBtn.disabled = false;
    }
  });
  linksRefreshBtn.addEventListener("click", () => { void refreshShare(); });

  const selectTab = (tab: "device" | "person" | "links") => {
    activeTab = tab;
    tabBtns.forEach((b, i) => {
      const on = tabSpecs[i]![0] === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    devicePanel.hidden = tab !== "device";
    personPanel.hidden = tab !== "person";
    linksPanel.hidden = tab !== "links";
    if (tab === "device" && !qrSlot.firstChild) {
      qrSlot.append(buildQrCard(location.href, "Scan to open this page on another device"));
    }
    if (tab !== "device" && !shared.ownerChecked) void refreshShare();
  };
  tabBtns.forEach((b, i) => {
    b.addEventListener("click", () => selectTab(tabSpecs[i]![0]));
    b.addEventListener("keydown", (e: KeyboardEvent) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = (i + step + tabBtns.length) % tabBtns.length;
      selectTab(tabSpecs[next]![0]);
      tabBtns[next]!.focus();
      e.preventDefault();
    });
  });

  body.append(seg, devicePanel, personPanel, linksPanel, statusMsg, manualLink);
  selectTab("device");

  return {
    body,
    onOpen(initialTab?: "device" | "person" | "links") {
      setStatus("");
      manualLink.hidden = true;
      refreshViewSelect();
      selectTab(initialTab ?? activeTab);
      if (activeTab !== "device") void refreshShare();
    },
    dispose() { disposed = true; },
  };
}

// ── 2. AGENTS & MCP MODAL (FIXED & FULL-FEATURED) ───────────────────────────
export function createAgentsModal(
  api: RuntimeApi,
  shared: ShareAgentsSharedState,
  onMetaChange: () => void,
) {
  let disposed = false;
  let activeTab: "roster" | "add" | "mcp" = "roster";
  let joinCodeData: { code: string; expires_at: number; blurb: string; command: string } | null = null;
  let joinViewMode: "prompt" | "cli" = "prompt";
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  const body = el("div", undefined, "modal-body");
  const seg = el("div", undefined, "seg");
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", "Agents and MCP");
  const tabSpecs = [
    ["roster", "On this page"],
    ["add", "Add agent"],
    ["mcp", "Hosted MCP"],
  ] as const;
  const tabBtns = tabSpecs.map(([id, label]) => {
    const b = btn(label);
    b.setAttribute("role", "tab");
    b.setAttribute("data-tab", id);
    return b;
  });
  seg.append(...tabBtns);

  const rosterPanel = el("div", undefined, "stack"); rosterPanel.setAttribute("role", "tabpanel");
  const addPanel = el("div", undefined, "stack"); addPanel.setAttribute("role", "tabpanel");
  const mcpPanel = el("div", undefined, "stack"); mcpPanel.setAttribute("role", "tabpanel");

  const statusMsg = el("p", undefined, "status-msg"); statusMsg.hidden = true; statusMsg.setAttribute("role", "status");
  const setStatus = (msg: string, isError = false) => {
    statusMsg.hidden = !msg;
    statusMsg.textContent = msg;
    statusMsg.className = isError ? "status-msg error" : "status-msg";
  };

  // ─ Tab 1: On This Page Roster ─
  const rosterLoading = el("p", "Loading agents…", "muted");
  const rosterList = el("ul", undefined, "item-list agent-roster");
  const rosterEmpty = el("div", undefined, "card-box"); rosterEmpty.hidden = true;
  const rosterEmptyCta = btn("Add an agent", "btn primary");
  rosterEmpty.append(
    el("strong", "No agents on this page yet"),
    el("p", "Add a workspace agent (Claude Code, Codex, OpenClaw, Hermes) or connect ChatGPT via Hosted MCP.", "muted"),
    rosterEmptyCta,
  );
  const primaryField = el("div", undefined, "field"); primaryField.hidden = true;
  primaryField.append(el("label", "Primary agent (answers general messages)"));
  const primarySelect = el("select", undefined, "select");
  primarySelect.setAttribute("aria-label", "Primary agent");
  primaryField.append(primarySelect);
  rosterPanel.append(rosterLoading, rosterList, rosterEmpty, primaryField);

  // ─ Tab 2: Add Agent (Account toggles + REAL one-time Join Code generator!) ─
  const addVisitorNote = el("p", "Only the page owner can grant or add agents.", "muted"); addVisitorNote.hidden = true;
  const addOwnerWrap = el("div", undefined, "stack"); addOwnerWrap.hidden = true;

  const accountBox = el("div", undefined, "stack-sm");
  const accountHead = el("div", undefined, "row-between");
  const refreshAgentsBtn = btn("Refresh", "btn sm");
  accountHead.append(el("strong", "Your account agents"), refreshAgentsBtn);
  const accountChecks = el("div", undefined, "stack-sm");
  accountChecks.setAttribute("role", "group");
  accountChecks.setAttribute("aria-label", "Account agents granted access");
  accountBox.append(accountHead, el("p", "Toggle an agent on to grant it access to this page.", "muted"), accountChecks);

  const newAgentBox = el("div", undefined, "card-box");
  const genJoinBtn = btn("Generate agent join code", "btn primary full");
  const joinResultBox = el("div", undefined, "stack-sm"); joinResultBox.hidden = true;
  const joinHeaderRow = el("div", undefined, "row-between");
  const joinCodeBadge = el("span", "", "pill accent code-pill");
  const joinCountdown = el("span", "", "pill warn");
  joinHeaderRow.append(joinCodeBadge, joinCountdown);
  const joinModeSeg = el("div", undefined, "seg");
  const promptModeBtn = btn("Agent prompt"); promptModeBtn.setAttribute("aria-selected", "true");
  const cliModeBtn = btn("CLI command"); cliModeBtn.setAttribute("aria-selected", "false");
  joinModeSeg.append(promptModeBtn, cliModeBtn);
  const joinTextPre = el("pre", "", "code-box");
  const joinCopyRow = el("div", undefined, "row");
  const joinCopyBtn = btn("Copy invitation", "btn primary sm"); joinCopyBtn.style.flex = "1";
  const joinRegenBtn = btn("New code", "btn sm");
  joinCopyRow.append(joinCopyBtn, joinRegenBtn);
  joinResultBox.append(
    joinHeaderRow,
    joinModeSeg,
    joinTextPre,
    joinCopyRow,
    el("p", "Paste this to your agent. Once it joins, click Refresh above to toggle it on for this page.", "muted"),
  );

  const agentLinksRow = el("div", undefined, "row");
  const platformsLink = el("a", "Platform guides", "btn sm"); platformsLink.target = "_blank"; platformsLink.rel = "noopener";
  const dashboardLink = el("a", "Add an agent on your dashboard", "btn sm"); dashboardLink.target = "_blank"; dashboardLink.rel = "noopener";
  agentLinksRow.append(platformsLink, dashboardLink);

  newAgentBox.append(
    el("strong", "Connect a new agent"),
    el("p", "Generate a one-time 10-minute join code to pair Claude Code, Codex, OpenClaw, Hermes, or any workspace agent.", "muted"),
    genJoinBtn,
    joinResultBox,
    agentLinksRow,
  );
  addOwnerWrap.append(accountBox, newAgentBox);
  addPanel.append(addOwnerWrap, addVisitorNote);

  // ─ Tab 3: Hosted MCP & External OAuth Connections ─
  const mcpBox = el("div", undefined, "stack agent-mcp-box");
  const mcpList = el("ul", undefined, "item-list");
  const extConnBox = el("div", undefined, "stack-sm"); extConnBox.hidden = true;
  const extConnList = el("ul", undefined, "item-list");
  extConnBox.append(el("strong", "External OAuth connections"), extConnList);
  const mcpActionsRow = el("div", undefined, "row");
  const connectionsLink = el("a", "Hosted MCP connections", "btn sm"); connectionsLink.target = "_blank"; connectionsLink.rel = "noopener";
  const mcpRefreshBtn = btn("Refresh grants", "btn sm");
  mcpActionsRow.append(connectionsLink, mcpRefreshBtn);
  mcpBox.append(
    el("p", "Connect an OAuth client (such as ChatGPT) directly to this page. Keys are X25519-sealed to its Bearer token with zero plaintext keys stored on Tendriller.", "muted"),
    mcpList,
    extConnBox,
    mcpActionsRow,
  );
  const mcpVisitorNote = el("p", "Only the page owner can manage Hosted MCP connections.", "muted"); mcpVisitorNote.hidden = true;
  mcpPanel.append(mcpBox, mcpVisitorNote);

  const agentSnap = () => api.agents?.snapshot?.() ?? { primary_agent_id: null, agents: [], live: {} };

  const renderJoinCode = () => {
    if (!joinCodeData) { joinResultBox.hidden = true; return; }
    joinResultBox.hidden = false;
    joinCodeBadge.textContent = joinCodeData.code;
    joinCountdown.textContent = `Valid ${formatCountdown(joinCodeData.expires_at)}`;
    promptModeBtn.setAttribute("aria-selected", String(joinViewMode === "prompt"));
    cliModeBtn.setAttribute("aria-selected", String(joinViewMode === "cli"));
    joinTextPre.textContent = joinViewMode === "prompt" ? joinCodeData.blurb : joinCodeData.command;
    joinCopyBtn.textContent = joinViewMode === "prompt" ? "Copy agent prompt" : "Copy CLI command";
  };

  const renderRoster = () => {
    const snap = agentSnap();
    clearChildren(rosterList);
    rosterEmpty.hidden = snap.agents.length > 0;
    for (const agent of snap.agents) {
      const li = el("li", undefined, "item-card agent-card");
      const top = el("div", undefined, "row-between");
      const pills = el("div", undefined, "row");
      const isPrimary = agent.is_primary || agent.id === snap.primary_agent_id;
      if (isPrimary) pills.append(el("span", "Primary", "pill accent"));
      if (agent.kind === "hosted-mcp") {
        pills.append(el("span", "Hosted MCP", "pill ok"));
      } else {
        const live = snap.live?.[agent.public_key] ?? snap.live?.[agent.id];
        if (live?.state === "online") pills.append(el("span", "Online", "pill ok"));
        else if (live?.state === "busy") pills.append(el("span", "Busy", "pill warn"));
        else if (live?.enrolled === false) pills.append(el("span", "Awaiting data enrollment", "pill warn"));
        else pills.append(el("span", live?.enrolled ? "Enrolled · Offline" : "Offline", "pill"));
      }
      top.append(el("strong", `@${agent.handle}`), pills);
      li.append(top);
      if (agent.bio) li.append(el("p", agent.bio, "muted"));
      if (shared.canManage && !isPrimary) {
        const row = el("div", undefined, "row");
        const makePri = btn("Set as primary", "btn sm");
        makePri.addEventListener("click", async () => {
          makePri.disabled = true;
          try { await api.agents?.setPrimary?.(agent.id); setStatus(`@${agent.handle} is now primary.`); }
          catch (err) { setStatus(err instanceof Error ? err.message : "Could not update primary agent.", true); }
          finally { if (!disposed) makePri.disabled = false; }
        });
        row.append(makePri);
        li.append(row);
      }
      rosterList.append(li);
    }

    primaryField.hidden = !shared.canManage || snap.agents.length === 0;
    if (!primaryField.hidden) {
      clearChildren(primarySelect);
      const noneOpt = el("option", "None (only direct @mentions)"); noneOpt.value = "";
      noneOpt.selected = !snap.primary_agent_id;
      primarySelect.append(noneOpt);
      for (const agent of snap.agents) {
        const opt = el("option", `@${agent.handle}${agent.kind === "hosted-mcp" ? " (Hosted MCP)" : ""}`);
        opt.value = agent.id;
        opt.selected = agent.id === snap.primary_agent_id;
        primarySelect.append(opt);
      }
    }
    onMetaChange();
  };

  const renderAccountAgents = () => {
    dashboardLink.href = shared.dashboardUrl || "/dashboard#agents";
    connectionsLink.href = shared.connectionsUrl || "/connections";
    platformsLink.href = shared.platformsUrl || "/agents";
    addOwnerWrap.hidden = !shared.canManage;
    addVisitorNote.hidden = shared.canManage;
    clearChildren(accountChecks);
    if (shared.accountAgents.length === 0) {
      accountChecks.append(el("p", "No workspace agents on your account yet. Generate a join code below to connect your first agent.", "muted"));
      return;
    }
    for (const agent of shared.accountAgents) {
      const row = el("label", undefined, "switch-row");
      const copy = el("div", undefined, "switch-copy");
      copy.append(el("strong", `@${agent.handle}`));
      if (agent.bio) copy.append(el("span", agent.bio));
      const box = el("input", undefined, "switch-input");
      box.type = "checkbox"; box.value = agent.id;
      box.defaultChecked = box.checked = agent.granted;
      box.setAttribute("aria-label", `@${agent.handle}`);
      box.addEventListener("change", async () => {
        const want = box.checked;
        box.disabled = true;
        setStatus("Saving…");
        try {
          const res = await fetch(`${api.identity.base}_tendril/agents`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: agent.id, granted: want }),
          });
          const data = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          if (!res.ok) throw Error(data?.error?.message || "Could not change access. Try again.");
          box.defaultChecked = want;
          agent.granted = want;
          await api.agents?.refresh?.().catch(() => {});
          if (!disposed) {
            renderRoster();
            setStatus(want ? `@${agent.handle} can now maintain this page.` : `@${agent.handle} no longer has access.`);
          }
        } catch (err) {
          if (disposed) return;
          box.checked = !want;
          setStatus(err instanceof Error ? err.message : "Could not change access. Try again.", true);
        } finally {
          if (!disposed) box.disabled = false;
        }
      });
      row.append(copy, box);
      accountChecks.append(row);
    }
  };

  const renderHostedMcp = () => {
    mcpBox.hidden = !shared.canManage;
    mcpVisitorNote.hidden = shared.canManage;
    if (!shared.canManage) return;
    clearChildren(mcpList);
    if (!shared.mcpGrants) {
      mcpList.append(el("li", "Loading Hosted MCP grants…", "muted"));
      return;
    }
    if (!shared.mcpGrants.configured) {
      const li = el("li", undefined, "item-card");
      li.append(el("p", "Hosted MCP OAuth is not configured on this service.", "muted"));
      mcpList.append(li);
      return;
    }
    if (shared.mcpGrants.grants.length === 0) {
      const li = el("li", undefined, "item-card");
      li.append(
        el("strong", "No authorized OAuth clients yet"),
        el("p", "Authorize ChatGPT or another MCP assistant on your connections page first, then click Refresh grants here.", "muted"),
      );
      mcpList.append(li);
      return;
    }
    const byGrant = new Map(shared.mcpGrants.connections.map(c => [c.grant_id, c]));
    for (const grant of shared.mcpGrants.grants) {
      const conn = byGrant.get(grant.id);
      const li = el("li", undefined, "item-card agent-card");
      const top = el("div", undefined, "row-between");
      top.append(
        el("strong", grant.client_name || grant.client_id),
        el("span", conn ? `Connected as @${conn.handle}` : "Not connected", conn ? "pill ok" : "pill"),
      );
      li.append(top);
      const actions = el("div", undefined, "row");
      if (conn) {
        const discBtn = btn("Disconnect", "btn sm danger");
        discBtn.addEventListener("click", async () => {
          discBtn.disabled = true;
          setStatus(`Disconnecting @${conn.handle}…`);
          try {
            const res = await fetch(`${api.identity.base}_tendril/mcp/${encodeURIComponent(grant.id)}`, { method: "DELETE", credentials: "same-origin" });
            if (!res.ok) throw Error("Could not disconnect hosted MCP.");
            await api.agents?.refresh?.().catch(() => {});
            await refreshMcpGrants();
            if (!disposed) setStatus(`Disconnected @${conn.handle}.`);
          } catch (err) {
            if (!disposed) setStatus(err instanceof Error ? err.message : "Could not disconnect hosted MCP.", true);
          } finally { if (!disposed) discBtn.disabled = false; }
        });
        actions.append(discBtn);
      } else if (api.agents?.canConnectMcp) {
        const defaultHandle = (grant.client_id || "assistant").toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z]+/, "") || "assistant";
        const handleInput = el("input", undefined, "input");
        handleInput.type = "text"; handleInput.value = defaultHandle.slice(0, 32);
        handleInput.placeholder = "handle (e.g. chatgpt)";
        handleInput.setAttribute("aria-label", `Handle for ${grant.client_name || grant.client_id}`);
        handleInput.style.flex = "1"; handleInput.style.minWidth = "120px";
        const connBtn = btn("Connect to this page", "btn sm primary");
        connBtn.addEventListener("click", async () => {
          const handle = handleInput.value.trim().replace(/^@+/, "").toLowerCase();
          if (!/^[a-z][a-z0-9_-]{1,31}$/.test(handle)) {
            setStatus("Choose a lowercase handle (2–32 chars: a-z, 0-9, _, -).", true);
            return;
          }
          connBtn.disabled = handleInput.disabled = true;
          setStatus(`Connecting @${handle}…`);
          try {
            await api.agents?.connectMcp?.({
              grantId: grant.id,
              wrapPublicKey: grant.wrap_public_key,
              handle,
              bio: `Hosted MCP (${grant.client_name || grant.client_id})`,
              label: shared.pageName,
            });
            await refreshMcpGrants();
            if (!disposed) setStatus(`Connected @${handle} to this page.`);
          } catch (err) {
            if (!disposed) setStatus(err instanceof Error ? err.message : "Could not connect hosted MCP.", true);
          } finally { if (!disposed) connBtn.disabled = handleInput.disabled = false; }
        });
        actions.append(handleInput, connBtn);
      } else {
        actions.append(el("p", "Open this page's app session to enable one-click key wrapping, or manage connections on the dashboard.", "muted"));
      }
      li.append(actions);
      mcpList.append(li);
    }
  };

  const refreshMcpGrants = async () => {
    if (disposed || !api.identity?.base || !shared.canManage) return;
    try {
      const res = await fetch(`${api.identity.base}_tendril/mcp/grants`, { credentials: "same-origin", cache: "no-store" });
      if (res.ok) {
        shared.mcpGrants = await res.json();
        if (!disposed) renderHostedMcp();
      }
    } catch { /* offline */ }
    try {
      const cRes = await fetch(`${api.identity.base}_tendril/connections`, { credentials: "same-origin", cache: "no-store" });
      if (!cRes.ok || disposed) return;
      const cData = await cRes.json() as {
        connections?: Array<{ id: string; provider: string; label: string; tier: string; custody: string; external_label?: string | null; actions?: string[] }>;
      };
      const conns = cData.connections ?? [];
      clearChildren(extConnList);
      extConnBox.hidden = conns.length === 0;
      for (const conn of conns) {
        const li = el("li", undefined, "item-card");
        const top = el("div", undefined, "row-between");
        const pills = el("div", undefined, "row");
        pills.append(el("span", conn.tier === "agent-held" ? "Zero-Trust" : "Wrapped Proxy", conn.tier === "agent-held" ? "pill ok" : "pill accent"));
        if (conn.tier === "host-brokered") pills.append(el("span", conn.custody === "page" ? "Team" : "Personal", "pill"));
        top.append(el("strong", conn.label || conn.provider), pills);
        li.append(top);
        if (conn.external_label) li.append(el("p", conn.external_label, "muted"));
        const remBtn = btn("Remove from page", "btn sm danger");
        remBtn.addEventListener("click", async () => {
          remBtn.disabled = true;
          try {
            const del = await fetch(`${api.identity.base}_tendril/connections/${encodeURIComponent(conn.id)}`, { method: "DELETE", credentials: "same-origin" });
            if (!del.ok) throw Error();
            if (!disposed) { setStatus(`Removed ${conn.label || conn.provider} from this page.`); await refreshMcpGrants(); }
          } catch {
            remBtn.disabled = false;
            if (!disposed) setStatus("Could not remove external connection.", true);
          }
        });
        li.append(el("div", undefined, "row"));
        (li.lastChild as HTMLElement).append(remBtn);
        extConnList.append(li);
      }
    } catch { /* offline */ }
  };

  const refreshAgents = async () => {
    if (disposed || !api.identity?.base) return;
    try {
      const res = await fetch(`${api.identity.base}_tendril/agents`, { credentials: "same-origin", cache: "no-store" });
      if (disposed) return;
      rosterLoading.hidden = true;
      if (res.status === 401 || res.status === 403) {
        shared.canManage = false;
        renderRoster(); renderAccountAgents(); renderHostedMcp();
        return;
      }
      if (!res.ok) throw Error();
      const data = await res.json() as {
        primary_agent_id?: string | null;
        can_manage?: boolean;
        dashboard?: string;
        connections?: string;
        platforms?: string;
        account_agents?: { id: string; handle: string; bio: string; granted: boolean }[];
      };
      shared.canManage = Boolean(data.can_manage);
      if (data.dashboard) shared.dashboardUrl = data.dashboard;
      if (data.connections) shared.connectionsUrl = data.connections;
      if (data.platforms) shared.platformsUrl = data.platforms;
      if (data.account_agents) shared.accountAgents = data.account_agents;
      // Sync runtime store without double-fetching when possible, or refresh store if needed
      await api.agents?.refresh?.().catch(() => {});
      if (disposed) return;
      renderRoster();
      renderAccountAgents();
      if (shared.canManage) void refreshMcpGrants();
      else renderHostedMcp();
    } catch {
      if (!disposed) {
        rosterLoading.hidden = true;
        renderRoster();
        renderAccountAgents();
      }
    }
  };

  const generateJoinCode = async () => {
    if (genJoinBtn.disabled) return;
    genJoinBtn.disabled = joinRegenBtn.disabled = true;
    setStatus("Creating one-time join code…");
    try {
      const res = await fetch(`${api.identity.base}_tendril/agents/join`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => null) as { code?: string; expires_at?: number; blurb?: string; command?: string; error?: { message?: string } } | null;
      if (!res.ok || !data?.code) throw Error(data?.error?.message || "Could not create a join code. Try again.");
      joinCodeData = {
        code: data.code,
        expires_at: Number(data.expires_at ?? Date.now() + 600_000),
        blurb: data.blurb ?? `Run: tendril workspace join --code ${data.code} --handle <handle>`,
        command: data.command ?? `tendril workspace join --code ${data.code} --handle <handle>`,
      };
      genJoinBtn.hidden = true;
      renderJoinCode();
      if (countdownTimer !== null) clearInterval(countdownTimer);
      countdownTimer = setInterval(() => { if (!disposed) renderJoinCode(); }, 1000);
      setStatus("Join code created. Paste the invitation to your agent.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not create a join code.", true);
    } finally {
      if (!disposed) genJoinBtn.disabled = joinRegenBtn.disabled = false;
    }
  };

  primarySelect.addEventListener("change", async () => {
    const next = primarySelect.value || null;
    primarySelect.disabled = true;
    setStatus("Updating primary agent…");
    try {
      await api.agents?.setPrimary?.(next);
      if (!disposed) setStatus(next ? "Primary agent updated." : "Primary agent cleared.");
    } catch (err) {
      if (!disposed) setStatus(err instanceof Error ? err.message : "Could not update primary agent.", true);
      renderRoster();
    } finally { if (!disposed) primarySelect.disabled = false; }
  });

  rosterEmptyCta.addEventListener("click", () => selectTab("add"));
  refreshAgentsBtn.addEventListener("click", () => { void refreshAgents(); });
  mcpRefreshBtn.addEventListener("click", () => { void refreshMcpGrants(); });
  genJoinBtn.addEventListener("click", () => { void generateJoinCode(); });
  joinRegenBtn.addEventListener("click", () => { void generateJoinCode(); });
  promptModeBtn.addEventListener("click", () => { joinViewMode = "prompt"; renderJoinCode(); });
  cliModeBtn.addEventListener("click", () => { joinViewMode = "cli"; renderJoinCode(); });
  joinCopyBtn.addEventListener("click", async () => {
    if (!joinCodeData) return;
    const text = joinViewMode === "prompt" ? joinCodeData.blurb : joinCodeData.command;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(joinViewMode === "prompt" ? "Agent invitation copied." : "CLI command copied.");
    } catch {
      setStatus("Could not copy automatically. Select the text above and copy it.", true);
    }
  });

  const selectTab = (tab: "roster" | "add" | "mcp") => {
    activeTab = tab;
    tabBtns.forEach((b, i) => {
      const on = tabSpecs[i]![0] === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    rosterPanel.hidden = tab !== "roster";
    addPanel.hidden = tab !== "add";
    mcpPanel.hidden = tab !== "mcp";
    if (tab === "mcp" && shared.canManage && !shared.mcpGrants) void refreshMcpGrants();
  };
  tabBtns.forEach((b, i) => {
    b.addEventListener("click", () => selectTab(tabSpecs[i]![0]));
    b.addEventListener("keydown", (e: KeyboardEvent) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = (i + step + tabBtns.length) % tabBtns.length;
      selectTab(tabSpecs[next]![0]);
      tabBtns[next]!.focus();
      e.preventDefault();
    });
  });

  const offAgents = api.agents?.onChange?.(() => {
    if (!disposed) { renderRoster(); renderHostedMcp(); }
  }) ?? (() => {});

  body.append(seg, rosterPanel, addPanel, mcpPanel, statusMsg);
  selectTab("roster");

  return {
    body,
    onOpen(initialTab?: "roster" | "add" | "mcp") {
      setStatus("");
      selectTab(initialTab ?? activeTab);
      void refreshAgents();
    },
    dispose() {
      disposed = true;
      if (countdownTimer !== null) clearInterval(countdownTimer);
      offAgents();
    },
  };
}

// ── 3. VOICE & AUDIO STUDIO MODAL (LAZY LOADED) ─────────────────────────────
export function createVoiceModal(api: RuntimeApi) {
  let disposed = false;
  let mountedControls: { dispose(): void; element: HTMLElement } | null = null;
  const body = el("div", undefined, "modal-body");
  const intro = el("p", "Tap to talk or choose an optional on-device wake word while this page is visible. Audio stays on this device and requires your explicit consent.", "muted");
  const setupBtn = btn("Set up voice input", "btn primary full");
  const msg = el("p", undefined, "status-msg"); msg.hidden = true; msg.setAttribute("role", "status");
  const container = el("div");
  body.append(intro, setupBtn, msg, container);

  setupBtn.addEventListener("click", async event => {
    if (!event.isTrusted || disposed || setupBtn.disabled) return;
    setupBtn.disabled = true;
    msg.hidden = false;
    msg.className = "status-msg";
    msg.textContent = "Opening voice controls…";
    try {
      const url = api.assetUrl("voice.mjs");
      const mod = await import(/* @vite-ignore */ url) as typeof import("../voice/index");
      if (disposed) return;
      mountedControls = mod.mountVoiceControls(api, { container });
      setupBtn.hidden = true;
      msg.hidden = true;
      const toggle = mountedControls.element.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-controls="voice-panel"]');
      toggle?.focus();
    } catch (err) {
      if (disposed) return;
      setupBtn.disabled = false;
      msg.className = "status-msg error";
      const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
      msg.textContent = `Voice controls could not load${detail}. Check your connection and try again; typed input remains available.`;
    }
  });

  return {
    body,
    onOpen() { /* stays zero-network until trusted click on Set up voice input */ },
    dispose() { disposed = true; mountedControls?.dispose(); },
  };
}

// ── 4. SYNC & CONNECTIONS MODAL ─────────────────────────────────────────────
export function createSyncModal(api: RuntimeApi) {
  let disposed = false;
  const body = el("div", undefined, "modal-body");

  // Application Session Card (only visible when an application backend is installed)
  const appCard = el("div", undefined, "card-box"); appCard.hidden = true;
  const appTitleRow = el("div", undefined, "row-between");
  const appPhasePill = el("span", "", "pill");
  appTitleRow.append(el("strong", "Local application session"), appPhasePill);
  const appMeta = el("p", "", "muted");
  appCard.append(appTitleRow, appMeta);

  const renderAppStatus = () => {
    if (disposed || !api.application?.available) { appCard.hidden = true; return; }
    appCard.hidden = false;
    const st = api.application.backend.status;
    appPhasePill.textContent = st.canAuthor ? "Authoring ready" : st.phase === "awaiting-keys" ? "Awaiting keys" : st.phase;
    appPhasePill.className = st.canAuthor ? "pill ok" : "pill warn";
    appMeta.textContent = `Database: ${st.database} · Connected peers: ${st.connectedPeers} · Pending local ops: ${st.pendingOperations}${st.materializationError ? ` · Error: ${st.materializationError}` : ""}`;
  };

  let offAppStatus = () => {};
  const bindApp = () => {
    if (!api.application?.available) return;
    renderAppStatus();
    offAppStatus();
    offAppStatus = api.application.backend.onStatus(() => renderAppStatus());
  };
  const offAppReady = api.on?.("application_ready", bindApp) ?? (() => {});
  if (api.application?.available) bindApp();

  // Transport inspector (authenticated local links only; samples explicitly on open/Refresh)
  const inspector = mountTransportInspector(api.transport);
  // Links to a page agent show its public @handle; admission state names the rest.
  const nameLinks = () => nameTransportAgents(api.transport, () => api.agents?.snapshot?.()?.agents ?? []);
  nameLinks();
  const offAgents = api.agents?.onChange?.(() => { if (!disposed) nameLinks(); }) ?? (() => {});

  body.append(appCard, inspector.element);

  return {
    body,
    onOpen() {
      renderAppStatus();
      inspector.open();
    },
    dispose() {
      disposed = true;
      offAppStatus();
      offAppReady();
      offAgents();
      inspector.close();
      nameTransportAgents(api.transport, null);
    },
  };
}

// ── 5. APP, OFFLINE & ALERTS MODAL ──────────────────────────────────────────
export function createAppModal(
  api: RuntimeApi,
  hooks: { onInstalledChange(): void; onDismissInstallSuggestion(): void },
) {
  let disposed = false;
  let installing = false;
  let notifSubscribed = false;

  const body = el("div", undefined, "modal-body");

  // ─ Install / Home Screen Card ─
  const installCard = el("div", undefined, "card-box");
  const installHead = el("div", undefined, "row-between");
  const installBadge = el("span", "", "pill");
  installHead.append(el("strong", "Home Screen app"), installBadge);
  const installIntro = el("p", "Add a shortcut to your Home Screen for one-tap access.", "muted");
  const nativeInstallBtn = btn("Add to Home Screen", "btn primary full");
  const steps = el("ol", undefined, "steps-list");
  const fallback = el("p", undefined, "muted");
  const iosNote = el("p", "When you first open the Home Screen app, it may ask you to sign in or connect this device again.", "muted");
  const installMsg = el("p", undefined, "status-msg"); installMsg.hidden = true; installMsg.setAttribute("role", "status");
  installCard.append(installHead, installIntro, nativeInstallBtn, steps, fallback, iosNote, installMsg);

  // ─ Push Notifications Card ─
  const notifCard = el("div", undefined, "card-box");
  const notifHead = el("div", undefined, "row-between");
  const notifBadge = el("span", "Off", "pill");
  notifHead.append(el("strong", "Push notifications"), notifBadge);
  const notifNote = el("p", "Receive alerts from this page even when it is closed.", "muted");
  const notifBtn = btn("Enable notifications", "btn full");
  const notifMsg = el("p", undefined, "status-msg"); notifMsg.hidden = true; notifMsg.setAttribute("role", "status");
  notifCard.append(notifHead, notifNote, notifBtn, notifMsg);
  notifCard.hidden = !api.notifications;

  // ─ Offline Use Card ─
  const offlineCard = el("div", undefined, "card-box");
  const offlineHead = el("div", undefined, "row-between");
  const offlineBadge = el("span", "Not saved", "pill");
  offlineHead.append(el("strong", "Use without a connection"), offlineBadge);
  const offlineBtn = btn("Save for offline use", "btn full");
  const offlineMsg = el("p", undefined, "status-msg"); offlineMsg.hidden = true; offlineMsg.setAttribute("role", "status");
  offlineCard.append(
    offlineHead,
    el("p", "Save this version’s page files on this device. Your app’s data and connections are managed separately.", "muted"),
    offlineBtn,
    offlineMsg,
  );
  offlineCard.hidden = !api.identity?.publication || !("serviceWorker" in navigator);

  // ─ Publication & Management Card ─
  const pubCard = el("div", undefined, "card-box");
  const pubHead = el("div", undefined, "row-between");
  const versionBadge = el("span", api.identity?.version ? `v${api.identity.version}` : "Draft", "pill accent");
  pubHead.append(el("strong", "Page release"), versionBadge);
  const pubMeta = el("p", "", "muted");
  const updateNowBtn = btn("Open update", "btn primary full"); updateNowBtn.hidden = true;
  const pubActions = el("div", undefined, "row");
  const latestLink = el("a", "Open latest version", "btn sm");
  latestLink.href = api.identity?.base || "/";
  latestLink.hidden = !(api.identity?.version > 0);
  const manageLink = el("a", "Manage page", "btn sm");
  manageLink.href = api.identity?.managementUrl || "_tendril/manage";
  manageLink.target = "_blank"; manageLink.rel = "noopener";
  const reportLink = el("a", "Report page", "btn sm");
  reportLink.href = `${api.identity?.base || ""}_tendril/report`;
  reportLink.target = "_blank"; reportLink.rel = "noopener";
  pubActions.append(latestLink, manageLink, reportLink);
  pubCard.append(pubHead, pubMeta, updateNowBtn, pubActions);

  const renderPub = () => {
    const pinned = api.publication?.pinned;
    const pubId = api.identity?.publication ? ` · Release ${api.identity.publication.slice(0, 12)}` : "";
    pubMeta.textContent = `${pinned ? "Pinned to this version" : "Live auto-update"}${pubId}`;
    updateNowBtn.hidden = !api.publication?.updateAvailable;
  };
  updateNowBtn.addEventListener("click", () => {
    if (typeof api.publication?.update === "function") api.publication.update();
    else location.href = api.identity.documentPath && api.identity.documentPath !== "index.html"
      ? new URL(encodePublicationPath(api.identity.documentPath), api.identity.base).href : api.identity.base;
  });

  const renderInstallation = () => {
    const { state, platform } = api.installation.status();
    installBadge.textContent = state === "installed" ? "Installed" : state === "available" ? "Ready" : state === "manual" ? "Manual steps" : "Unavailable";
    installBadge.className = state === "installed" ? "pill ok" : state === "available" ? "pill accent" : "pill";
    nativeInstallBtn.hidden = state !== "available";
    nativeInstallBtn.disabled = installing;
    iosNote.hidden = platform !== "ios" || state === "installed" || state === "unavailable";
    steps.hidden = state !== "manual";
    fallback.hidden = state !== "manual";
    installIntro.textContent = state === "installed"
      ? "This page is available as an app on this device."
      : state === "unavailable"
        ? "Open this page in a secure browser window to add it to your Home Screen."
        : "Add it to your Home Screen for a shortcut back to this page.";
    clearChildren(steps);
    if (platform === "ios") {
      for (const text of [
        "Tap Share. It may be inside your browser’s page menu.",
        "Choose Add to Home Screen.",
        "Keep Open as Web App enabled if shown, then tap Add.",
      ]) steps.append(el("li", text));
      fallback.textContent = "If the option is missing, open this page in Safari and check Share → Edit Actions.";
    } else if (platform === "android") {
      for (const text of [
        "Open your browser’s menu.",
        "Choose Add to Home Screen or Install app, then confirm.",
      ]) steps.append(el("li", text));
      fallback.textContent = "If the option is missing, open this page in Chrome or another browser that supports web apps.";
    } else {
      steps.append(el("li", "Look for Install in the address bar or browser menu. In Safari on Mac, choose File → Add to Dock."));
      fallback.textContent = "Available options depend on your browser. You can also bookmark this page.";
    }
    if (state === "installed") installMsg.hidden = true;
    hooks.onInstalledChange();
  };

  const triggerInstall = async () => {
    if (installing) return;
    installing = true;
    nativeInstallBtn.disabled = true;
    try {
      const result = await api.installation.prompt();
      if (disposed) return;
      if (result === "accepted") {
        hooks.onDismissInstallSuggestion();
        installMsg.textContent = "Installation requested. Follow your browser’s confirmation, then open the new app icon.";
      } else if (result === "dismissed") {
        hooks.onDismissInstallSuggestion();
        installMsg.textContent = "You can add this page later from Page options.";
      } else {
        installMsg.textContent = "Use your browser’s menu to add this page. The steps above will help.";
      }
      installMsg.className = "status-msg";
      installMsg.hidden = false;
    } catch {
      if (!disposed) {
        installMsg.className = "status-msg error";
        installMsg.hidden = false;
        installMsg.textContent = "The browser could not start installation. Try its menu to add this page.";
      }
    } finally {
      installing = false;
      if (!disposed) renderInstallation();
    }
  };
  nativeInstallBtn.addEventListener("click", () => { void triggerInstall(); });

  const renderNotifications = async () => {
    if (!api.notifications || disposed) return;
    try {
      const st = await api.notifications.status();
      if (disposed) return;
      notifSubscribed = st.subscribed;
      if (st.state === "unsupported") { notifCard.hidden = true; return; }
      notifCard.hidden = false;
      if (st.state === "install_required") {
        notifBadge.textContent = "Install first"; notifBadge.className = "pill warn";
        notifNote.textContent = "Add this page to your Home Screen first to enable push notifications on iOS.";
        notifBtn.hidden = true;
      } else if (st.state === "denied") {
        notifBadge.textContent = "Blocked"; notifBadge.className = "pill danger";
        notifNote.textContent = "Notifications are blocked in your browser settings for this site.";
        notifBtn.hidden = true;
      } else {
        notifBadge.textContent = st.subscribed ? "Enabled" : "Off";
        notifBadge.className = st.subscribed ? "pill ok" : "pill";
        notifNote.textContent = st.subscribed ? "Push notifications are enabled on this device." : "Receive alerts from this page even when it is closed.";
        notifBtn.hidden = false; notifBtn.disabled = false;
        notifBtn.textContent = st.subscribed ? "Disable notifications" : "Enable notifications";
      }
    } catch { /* ignore */ }
  };

  notifBtn.addEventListener("click", async () => {
    if (!api.notifications || notifBtn.disabled) return;
    notifBtn.disabled = true;
    notifMsg.hidden = false;
    notifMsg.className = "status-msg";
    try {
      if (notifSubscribed) {
        notifMsg.textContent = "Disabling notifications…";
        await api.notifications.disable();
        if (!disposed) notifMsg.textContent = "Notifications disabled on this device.";
      } else {
        notifMsg.textContent = "Enabling notifications…";
        const next = await api.notifications.enable();
        if (!disposed) {
          notifMsg.textContent = next.subscribed ? "Notifications enabled."
            : next.state === "denied" ? "Notifications were blocked."
            : next.state === "install_required" ? "Add this page to your Home Screen first."
            : "Notifications were not enabled.";
        }
      }
    } catch (err) {
      if (!disposed) { notifMsg.className = "status-msg error"; notifMsg.textContent = err instanceof Error ? err.message : "Could not update notifications."; }
    } finally {
      if (!disposed) { notifBtn.disabled = false; void renderNotifications(); }
    }
  });

  offlineBtn.addEventListener("click", async () => {
    if (offlineBtn.disabled) return;
    offlineBtn.disabled = true;
    offlineBtn.textContent = "Saving page files…";
    offlineMsg.hidden = false;
    offlineMsg.className = "status-msg";
    offlineMsg.textContent = "Keep this page open while its files are saved.";
    try {
      await api.publication.saveOffline();
      if (disposed) return;
      offlineBtn.textContent = "Page files saved";
      offlineBadge.textContent = "Saved"; offlineBadge.className = "pill ok";
      offlineMsg.textContent = "This version’s page files are saved on this device. App data and live features depend on the page.";
    } catch {
      if (disposed) return;
      offlineBtn.disabled = false;
      offlineBtn.textContent = "Try saving again";
      offlineBadge.textContent = "Retry needed"; offlineBadge.className = "pill danger";
      offlineMsg.className = "status-msg error";
      offlineMsg.textContent = "Could not save the page files. Check your connection and try again.";
    }
  });

  const offInstall = api.installation.on(renderInstallation);
  const offUpdate = api.publication.onUpdate(() => { if (!disposed) renderPub(); });
  body.append(installCard, notifCard, offlineCard, pubCard);
  renderInstallation();
  renderPub();

  return {
    body,
    triggerInstall,
    onOpen() {
      renderInstallation();
      renderPub();
      void renderNotifications();
    },
    dispose() { disposed = true; offInstall(); offUpdate(); },
  };
}

// ── 6. DEVICE, PERMISSIONS & DIAGNOSTICS MODAL ──────────────────────────────
const FEATURED_CAPS: ReadonlyArray<[string, string]> = [
  ["camera", "Camera"], ["microphone", "Microphone"], ["notifications", "Notifications"],
  ["location", "Location"], ["wake_lock", "Wake Lock"], ["clipboard_write", "Clipboard"],
  ["web_share", "Web Share"], ["screen_capture", "Screen Share"], ["motion", "Motion"],
  ["bluetooth", "Bluetooth"], ["usb", "USB"], ["serial", "Serial"],
];

export function createDiagnosticsModal(api: RuntimeApi, shared: ShareAgentsSharedState) {
  let disposed = false;
  const body = el("div", undefined, "modal-body");

  // ─ Capabilities & Permissions Card (queried lazily ONLY when modal opens!) ─
  const capsCard = el("div", undefined, "card-box");
  const capsHead = el("div", undefined, "row-between");
  const capsRefresh = btn("Refresh", "btn sm");
  capsHead.append(el("strong", "Device permissions & capabilities"), capsRefresh);
  const capsGrid = el("div", undefined, "cap-grid");
  capsCard.append(capsHead, el("p", "Read-only inspection on this device. Never prompts for permissions.", "muted"), capsGrid);
  capsCard.hidden = typeof api.capabilities !== "function";

  const renderCaps = async () => {
    if (disposed || typeof api.capabilities !== "function") return;
    try {
      const report = await api.capabilities(FEATURED_CAPS.map(([k]) => k)) as CapabilityReport;
      if (disposed || !report?.capabilities) return;
      clearChildren(capsGrid);
      for (const [key, label] of FEATURED_CAPS) {
        const cap = report.capabilities[key];
        if (!cap) continue;
        const chip = el("div", undefined, "cap-chip");
        const stateText = cap.active ? "Active" : !cap.available ? "Off" : cap.permission === "granted" ? "Granted" : cap.permission === "denied" ? "Blocked" : cap.permission === "prompt" ? "Ask" : "Ready";
        const tone = cap.active ? "pill danger" : cap.permission === "granted" ? "pill ok" : cap.permission === "denied" ? "pill danger" : cap.available ? "pill" : "pill";
        chip.append(el("span", label, "cap-name"), el("span", stateText, tone));
        capsGrid.append(chip);
      }
    } catch { /* ignore */ }
  };
  capsRefresh.addEventListener("click", () => { void renderCaps(); });

  // ─ System Broadcasts / Notices Card ─
  const noticesCard = el("div", undefined, "card-box"); noticesCard.hidden = true;
  const noticesHead = el("div", undefined, "row-between");
  const noticesRefresh = btn("Check notices", "btn sm");
  noticesHead.append(el("strong", "System notices"), noticesRefresh);
  const noticesList = el("ul", undefined, "item-list");
  noticesCard.append(noticesHead, noticesList);

  const renderNotices = () => {
    const all = api.broadcasts?.list?.() ?? [];
    noticesCard.hidden = !api.broadcasts || all.length === 0;
    clearChildren(noticesList);
    for (const item of all) {
      const li = el("li", undefined, "item-card");
      const top = el("div", undefined, "row-between");
      const tone = item.severity === "critical" || item.severity === "urgent" ? "pill danger" : item.severity === "recommended" ? "pill warn" : "pill accent";
      top.append(el("strong", item.title), el("span", `${item.kind} · ${item.severity}`, tone));
      li.append(top, el("p", item.summary, "muted"));
      if (item.docs_url) {
        const link = el("a", "Details", "btn sm");
        link.href = item.docs_url; link.target = "_blank"; link.rel = "noopener";
        li.append(link);
      }
      noticesList.append(li);
    }
  };
  noticesRefresh.addEventListener("click", () => { void api.broadcasts?.refresh?.().then(renderNotices).catch(() => {}); });

  // ─ Diagnostics & Error Log Card ─
  const diagCard = el("div", undefined, "card-box");
  const diagHead = el("div", undefined, "row-between");
  const diagCount = el("span", "0 errors", "pill ok");
  diagHead.append(el("strong", "Diagnostics & error log"), diagCount);
  const diagList = el("ul", undefined, "diag-list");
  const diagEmpty = el("p", "No runtime errors recorded on this page.", "muted");
  const diagActions = el("div", undefined, "row");
  const diagCopy = btn("Copy report", "btn sm");
  const diagShare = btn("Share report", "btn sm"); diagShare.hidden = !canNativeShare();
  const diagClear = btn("Clear", "btn sm danger");
  diagActions.append(diagCopy, diagShare, diagClear);
  const diagMsg = el("p", undefined, "status-msg"); diagMsg.hidden = true; diagMsg.setAttribute("role", "status");
  diagCard.append(diagHead, diagEmpty, diagList, diagActions, diagMsg);

  const renderDiagnostics = () => {
    const entries = api.errors?.list?.() ?? [];
    diagCount.textContent = entries.length === 0 ? "Healthy" : `${entries.length} ${entries.length === 1 ? "error" : "errors"}`;
    diagCount.className = entries.length === 0 ? "pill ok" : "pill danger";
    diagEmpty.hidden = entries.length > 0;
    diagList.hidden = entries.length === 0;
    diagClear.hidden = entries.length === 0;
    clearChildren(diagList);
    for (const entry of entries.slice(-8).reverse()) {
      const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      diagList.append(el("li", `[${time}] ${entry.kind}: ${entry.message}`, "diag-item"));
    }
  };

  const buildReport = () => JSON.stringify({
    page: api.identity?.page,
    version: api.identity?.version,
    publication: api.identity?.publication,
    documentPath: api.identity?.documentPath,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    userAgent: navigator.userAgent,
    transport: api.transport?.status?.() ?? null,
    errors: api.errors?.list?.() ?? [],
  }, null, 2);

  diagCopy.addEventListener("click", async () => {
    diagMsg.hidden = false;
    try { await navigator.clipboard.writeText(buildReport()); diagMsg.className = "status-msg"; diagMsg.textContent = "Diagnostic report copied."; }
    catch { diagMsg.className = "status-msg error"; diagMsg.textContent = "Could not access clipboard on this device."; }
  });
  diagShare.addEventListener("click", async () => {
    diagMsg.hidden = false;
    try { await navigator.share({ title: `${shared.pageName} diagnostics`, text: buildReport() }); diagMsg.className = "status-msg"; diagMsg.textContent = "Diagnostic report shared."; }
    catch (err) {
      if ((err as { name?: string })?.name === "AbortError") { diagMsg.hidden = true; return; }
      diagMsg.className = "status-msg error"; diagMsg.textContent = "Could not share report on this device.";
    }
  });
  diagClear.addEventListener("click", () => {
    api.errors?.clear?.();
    diagMsg.hidden = true;
    renderDiagnostics();
  });

  const offErrors = api.errors?.on?.(renderDiagnostics) ?? (() => {});
  const offBroadcasts = api.broadcasts?.onChange?.(renderNotices) ?? (() => {});
  body.append(capsCard, noticesCard, diagCard);
  renderDiagnostics();
  renderNotices();

  return {
    body,
    onOpen() {
      renderDiagnostics();
      renderNotices();
      void renderCaps();
    },
    dispose() { disposed = true; offErrors(); offBroadcasts(); },
  };
}
