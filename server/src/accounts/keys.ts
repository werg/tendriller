import type { Env } from "../env";
import { errorResponse, HttpError, isPlainObject, json, readBody, toErrorResponse } from "../http";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";
import { renderQrSvg } from "../qr";
import { accountLimits, requireWritesOpen } from "../service-state";
import { getAccountEntitlements } from "../billing/entitlements";
import { planSpec } from "../billing/plans";
import { emojiIconSvg, iconSvg } from "../inject";
import { DEFAULT_THEME_COLOR, isEmojiIcon } from "../pwa";
import { avatar, icon, renderShell, servicePage } from "./ui";
import { copyAttrs, renderCopyText, SITE_COPY } from "../site-copy";
import { brandBase, brandMark } from "../brand";
import { cleanupPageCustomDomain } from "../custom-domains";
import { checkSubdomainAvailability, setPageSubdomain, subdomainPlanAllowed } from "../subdomains";
import { remixExistingPage } from "../owner-pages";
import { accountGrants, createJoinCode, listAccountAgents, revokeAgent, setAgentGrant, setPagePrimaryAgent } from "../agents";
import { listActiveBroadcasts } from "../broadcasts";

export interface DashboardPageSummary {
  name: string;
  page_url: string;
  bare_url?: string | null;
  fallback_page_url?: string | null;
  fallback_bare_url?: string | null;
  subdomain?: string | null;
  icon?: string | null;
  theme_color?: string | null;
  version: number;
  held: boolean;
  bytes: number;
  agents: number;
  primary_agent_id?: string | null;
  guests_waiting: number;
  open_readers?: boolean;
  open_writers?: boolean;
  last_activity: { ts: number; summary: string } | null;
}

export interface DashboardViewData {
  origin: string;
  pageBaseDomain?: string;
  who: string;
  email: string | null;
  planName: string;
  planId: string;
  unlimitedHost: boolean;
  inGracePeriod: boolean;
  subdomainAllowed?: boolean;
  subdomainUsed?: number;
  subdomainLimit?: number | null;
  limits: { pages: number | null; residents: number | null; agents?: number | null };
  mcpUsage?: { calls: number; cap: number | null } | null;
  tendrils: Array<{ id: string; lifetime: string; state: string; created_at: number }>;
  summaries: Array<DashboardPageSummary | null>;
  agents: Array<{ id: string; handle: string; bio: string | null; grants: number; created_at: number }>;
  grants: Map<string, Set<string>>;
  systemBroadcastsHtml?: string;
  noticeListHtml?: string;
  agentRevoked?: boolean;
  deleted?: boolean;
  subdomainSaved?: boolean;
  editable?: boolean;
}

const DASHBOARD_CSS = `
.upgrade-card{
  display:flex;flex-direction:column;justify-content:space-between;gap:.95rem;
  border:1.5px dashed color-mix(in srgb,var(--green) 48%,var(--line));
  background:linear-gradient(155deg,color-mix(in srgb,var(--green-soft) 55%,var(--surface)) 0%,var(--surface) 72%);
  box-shadow:var(--shadow-sm);
}
.upgrade-card.warn{
  border-color:color-mix(in srgb,var(--orange) 58%,var(--line));
  background:linear-gradient(155deg,color-mix(in srgb,var(--orange-soft) 55%,var(--surface)) 0%,var(--surface) 72%);
}
.upgrade-card-head{display:flex;align-items:flex-start;gap:.8rem}
.upgrade-card-ico{
  display:grid;place-items:center;flex:none;width:2.55rem;height:2.55rem;border-radius:12px;
  background:var(--green-soft);color:var(--green);
}
.upgrade-card.warn .upgrade-card-ico{background:var(--orange-soft);color:var(--orange)}
.upgrade-card h3{font-size:1.05rem;margin:0 0 .2rem}
.upgrade-card p{font-size:.86rem;line-height:1.48;color:var(--muted);margin:0}
.upgrade-meter{display:grid;gap:.35rem}
.upgrade-meter-row{display:flex;justify-content:space-between;gap:.75rem;flex-wrap:wrap;font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums}
.upgrade-meter-row strong{color:var(--ink)}
.upgrade-bar{height:.38rem;border-radius:999px;background:var(--line);overflow:hidden}
.upgrade-bar>span{display:block;height:100%;border-radius:999px;background:var(--green)}
.upgrade-card.warn .upgrade-bar>span{background:var(--orange)}
.upgrade-card.inline-strip{
  grid-column:1/-1;flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem 1.5rem;
  padding:1.15rem 1.35rem;
}
.upgrade-card.inline-strip .upgrade-card-head{flex:1 1 20rem;align-items:center}
.upgrade-card.inline-strip .actions{margin-top:0}
`;

export function renderPageActivityBody(options: {
  id: string;
  events: Array<{ ts: number; kind: string; summary: string }>;
  editable?: boolean;
}): string {
  const editable = Boolean(options.editable);
  const a = SITE_COPY.dashboard.activity;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  return `<a class="back-link" href="/dashboard">← Back to dashboard</a><div class="page-head"><span class="eyebrow">${icon("activity")} <span${c("dashboard.activity.eyebrow", a.eyebrow)}>${renderCopyText(a.eyebrow)}</span></span><h1>Page <code>${escape(options.id)}</code></h1><p class="lead"${c("dashboard.activity.lead", a.lead)}>${renderCopyText(a.lead)}</p></div>
      ${options.events.length ? `<ul class="list">${options.events.map(e => `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${escape(e.summary)}</div><p class="list-item-sub">${escape(e.kind.replaceAll("_", " "))} · <time datetime="${escape(new Date(e.ts).toISOString())}">${escape(new Date(e.ts).toISOString().slice(0, 16).replace("T", " "))} UTC</time></p></div></li>`).join("")}</ul>` : `<p class="empty"${c("dashboard.activity.empty", a.empty)}>${renderCopyText(a.empty)}</p>`}`;
}

export function renderPageActivityHtml(options: {
  id: string;
  events: Array<{ ts: number; kind: string; summary: string }>;
  editable?: boolean;
}): string {
  return renderShell({ title: "Page activity", body: renderPageActivityBody(options) });
}

export function renderDashboardContent(view: DashboardViewData): { body: string; script: string; extraCss: string } {
  const editable = Boolean(view.editable);
  const d = SITE_COPY.dashboard;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const firstNameRaw = view.email ? view.email.split("@")[0]!.split(/[._+-]/)[0]! : "";
  const firstName = firstNameRaw ? firstNameRaw.charAt(0).toUpperCase() + firstNameRaw.slice(1) : "";
  const vars = { plan: view.planName, name: firstName, who: view.who };
  const txt = (t: string) => renderCopyText(t, vars);

  const relative = (ts: number) => {
    const minutes = Math.round((Date.now() - ts) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
    return `${Math.round(minutes / 1440)} d ago`;
  };
  const favicon = (info: DashboardPageSummary | null, name: string, id: string) => {
    if (!info) return avatar(name, id);
    if (info.icon && isEmojiIcon(info.icon)) return `<span class="avatar favicon emoji" aria-hidden="true">${emojiIconSvg(info.icon)}</span>`;
    if (info.icon && /^https:\/\//.test(info.icon))
      return `<span class="avatar favicon" aria-hidden="true"><img src="${escape(info.icon)}" alt="" width="44" height="44" loading="lazy" referrerpolicy="no-referrer"></span>`;
    return `<span class="avatar favicon" aria-hidden="true">${iconSvg(name, info.theme_color ?? DEFAULT_THEME_COLOR)}</span>`;
  };
  const pageDomain = view.pageBaseDomain || "tendriller.dev";
  const subAllowed = Boolean(view.subdomainAllowed);
  const subLimit = view.subdomainLimit ?? null;
  const subUsed = view.subdomainUsed ?? 0;
  const subQuotaLabel = subLimit === null ? "Unlimited" : `${subUsed} / ${subLimit}`;
  const cards = view.tendrils.map((t, index) => {
    const info = view.summaries[index];
    const name = info?.name ?? t.id;
    const stateBadge = info?.held || t.state === "held" ? '<span class="badge danger">Held</span>' : t.state === 'active' ? '<span class="badge ok">Active</span>' : `<span class="badge">${escape(t.state)}</span>`;
    const visibilityBadge = info?.open_readers
      ? (info.open_writers
        ? '<span class="badge warn" title="Unencrypted public log: anyone with the link can read and submit signed entries without signing in">Public · Open write</span> '
        : '<span class="badge" title="Unencrypted public log: anyone with the link can view without signing in">Public · Read-only</span> ')
      : '';
    const hasSub = Boolean(info?.subdomain);
    const subPaused = hasSub && !subAllowed;
    const activeUrl = subPaused ? (info?.fallback_page_url ?? info?.page_url ?? "") : (info?.page_url ?? "");
    const activeBareUrl = subPaused ? (info?.fallback_bare_url ?? activeUrl) : (info?.bare_url ?? activeUrl);
    const subLine = hasSub
      ? `<p class="fine" style="margin:.2rem 0 0">${icon("link")} ${subPaused
          ? `<code>${escape(info!.subdomain!)}.${escape(pageDomain)}</code> <span class="badge warn">Paused</span>`
          : `<a href="${escape(activeBareUrl)}"><code>${escape(info!.subdomain!)}.${escape(pageDomain)}</code></a>`}</p>`
      : "";
    const meta = info ? `<span>${icon("layers")} ${info.version ? `v${info.version}` : "Not published"}</span><span>${icon("bot")} ${info.agents} ${info.agents === 1 ? "agent" : "agents"}</span><span>${icon("database")} ${(info.bytes / 1048576).toFixed(1)} MB</span><span>${icon("clock")} ${t.lifetime === "resident" ? "Resident" : "Temporary"}</span>` : `<span>Details unavailable right now</span>`;
    const openable = Boolean(activeUrl) && !info?.held;
    return `<article class="card interactive page-card"><div class="page-card-top">${favicon(info, name, t.id)}<div><h3>${escape(name)}</h3>${subLine}<div class="page-meta">${meta}</div></div><div class="cluster">${visibilityBadge}${stateBadge}</div></div>${info?.last_activity ? `<p class="activity">${escape(info.last_activity.summary)} · <span title="${escape(new Date(info.last_activity.ts).toISOString())}">${relative(info.last_activity.ts)}</span></p>` : ""}${info?.guests_waiting ? `<p class="notice warn" style="margin:0">${icon("users")}<span>${info.guests_waiting} guest ${info.guests_waiting === 1 ? "request" : "requests"} waiting · <a href="${escape(activeUrl)}_tendril/manage">Review</a></span></p>` : ""}<div class="actions">${openable ? `<a class="button sm" href="${escape(activeUrl)}">${icon("external")} Open</a><button class="secondary sm" type="button" data-add="${escape(t.id)}" data-name="${escape(name)}" data-url="${escape(activeUrl)}" data-agents="${escape([...view.grants.get(t.id) ?? []].sort().join(" "))}">${icon("user-plus")} Add people &amp; devices</button><button class="ghost sm icon-button" data-subdomain="${escape(t.id)}" data-name="${escape(name)}" data-current-sub="${escape(info?.subdomain ?? "")}" type="button" title="${hasSub ? "Edit named subdomain" : "Set named subdomain"}" aria-label="Named subdomain for ${escape(name)}">${icon("link")}</button><button class="ghost sm icon-button" data-copy="${escape(activeBareUrl)}" type="button" title="Copy page link" aria-label="Copy link to ${escape(name)}">${icon("copy")}</button>${info?.version ? `<form class="inline-form" method="post" action="/dashboard/t/${escape(t.id)}/remix"><button class="ghost sm" type="submit" title="Fork app code into a fresh encrypted page (no private data copied)">Remix</button></form>` : ""}<a class="button ghost sm icon-button" href="${escape(activeUrl)}_tendril/manage" title="Page settings" aria-label="Settings for ${escape(name)}">${icon("settings")}</a>` : ""}<a class="button ghost sm icon-button" href="/dashboard/t/${escape(t.id)}" title="Activity" aria-label="Activity for ${escape(name)}">${icon("activity")}</a>${t.state === "held" ? `<a class="button sm danger" href="/appeal?tendril=${escape(t.id)}">Appeal hold</a>` : ""}<button class="ghost sm icon-button" type="button" data-delete="${escape(t.id)}" data-name="${escape(name)}" data-resident="${t.lifetime === "resident" ? "1" : ""}" title="Delete page" aria-label="Delete ${escape(name)}">${icon("trash")}</button></div></article>`;
  });
  const residents = view.tendrils.filter(t => t.lifetime === "resident" && t.state === "active").length;
  const totals = view.summaries.reduce((acc, info) => ({ guests: acc.guests + (info?.guests_waiting ?? 0), published: acc.published + (info?.version ? 1 : 0) }), { guests: 0, published: 0 });
  const buildPrompt = `Build me an app with Tendriller at ${view.origin}. Start by reading ${view.origin}/agent.md and follow it end to end. I will sign in as ${view.email ?? "my GitHub or Google account"}.\n\nWhat I want: `;
  const agentChecks = view.agents.map(agent => `<label class="check-item"><input type="checkbox" name="agent" value="${escape(agent.id)}" data-grant><span class="check-copy"><span class="check-title">${icon("bot")} @${escape(agent.handle)}</span><span class="check-desc">${agent.bio ? `${escape(agent.bio)} · ` : ""}Full host access to this page</span></span></label>`).join("");
  const agentRows = view.agents.map(agent => `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${icon("bot")} @${escape(agent.handle)}</div><p class="list-item-sub">${agent.bio ? `${escape(agent.bio)} · ` : ""}${agent.grants} ${agent.grants === 1 ? "page" : "pages"} · added ${escape(new Date(agent.created_at).toISOString().slice(0, 10))}</p></div><form class="inline-form" method="post" action="/dashboard/agents/${escape(agent.id)}/revoke"><button class="sm danger" type="submit" aria-label="Revoke @${escape(agent.handle)}">Revoke</button></form></li>`).join("");
  const agentsSection = `<section class="card" id="agents" aria-labelledby="agents-title"><div class="card-head"><div><span class="eyebrow">${icon("bot")} <span${c("dashboard.agents.eyebrow", d.agents.eyebrow)}>${txt(d.agents.eyebrow)}</span></span><h2 id="agents-title"${c("dashboard.agents.title", d.agents.title)}>${txt(d.agents.title)}</h2><p${c("dashboard.agents.lead", d.agents.lead)}>${txt(d.agents.lead)}</p></div><button class="sm" type="button" id="agent-add">${icon("bot")} Add agent</button></div>
      ${agentRows ? `<ul class="list">${agentRows}</ul>` : `<p class="empty"${c("dashboard.agents.empty", d.agents.empty)}>${txt(d.agents.empty)}</p>`}
      <div class="result" id="join-result" hidden><h3>${icon("check")} <span${c("dashboard.agents.inviteTitle", d.agents.inviteTitle)}>${txt(d.agents.inviteTitle)}</span></h3><div class="stack-sm"><div class="copy-box"><label class="field-label" for="join-blurb"${c("dashboard.agents.inviteLabel", d.agents.inviteLabel)}>${txt(d.agents.inviteLabel)}</label><textarea id="join-blurb" class="blurb-full" readonly rows="14"></textarea><div class="cluster"><button class="sm" type="button" data-copy-from="join-blurb">${icon("copy")} Copy invitation</button></div></div><p class="fine"${c("dashboard.agents.inviteFine", d.agents.inviteFine)}>${txt(d.agents.inviteFine)}</p></div></div><p class="fine" role="status" id="join-status"></p></section>`;
  const dialog = `<dialog class="sheet" id="add-dialog" aria-labelledby="add-title">
      <div class="sheet-head"><div><span class="eyebrow">${icon("sparkles")} <span${c("dashboard.addDialog.eyebrow", d.addDialog.eyebrow)}>${txt(d.addDialog.eyebrow)}</span></span><h2 id="add-title">…</h2><p${c("dashboard.addDialog.lead", d.addDialog.lead)}>${txt(d.addDialog.lead)}</p></div><button class="ghost sm icon-button" type="button" data-close aria-label="Close">${icon("x")}</button></div>
      <div class="sheet-body"><div class="tabs">
        <input class="tab-input" type="radio" name="add-tab" id="tab-device" checked><input class="tab-input" type="radio" name="add-tab" id="tab-person"><input class="tab-input" type="radio" name="add-tab" id="tab-agent">
        <div class="tab-list"><label for="tab-device">${icon("phone")} My device</label><label for="tab-person">${icon("user-plus")} A person</label><label for="tab-agent">${icon("bot")} An agent</label></div>
        <div class="tab-panels">
          <div class="tab-panel"><div class="split"><div><h3${c("dashboard.addDialog.deviceTitle", d.addDialog.deviceTitle)}>${txt(d.addDialog.deviceTitle)}</h3><ol class="steps">${d.addDialog.deviceSteps.map((step, i) => `<li><span${c(`dashboard.addDialog.deviceSteps.${i}`, step)}>${txt(step)}</span></li>`).join("")}</ol><div class="copy-box"><label class="field-label" for="device-link"${c("dashboard.addDialog.deviceLinkLabel", d.addDialog.deviceLinkLabel)}>${txt(d.addDialog.deviceLinkLabel)}</label><div class="copy-line"><input id="device-link" type="text" readonly><button class="secondary sm" type="button" data-copy-from="device-link">${icon("copy")} Copy</button></div></div></div><div class="qr-frame"><img id="device-qr" alt="QR code for your page link" width="176" height="176"><span>Scan with your other device</span></div></div></div>
          <div class="tab-panel"><h3${c("dashboard.addDialog.personTitle", d.addDialog.personTitle)}>${txt(d.addDialog.personTitle)}</h3><p class="muted" style="font-size:.9rem"${c("dashboard.addDialog.personLead", d.addDialog.personLead)}>${txt(d.addDialog.personLead)}</p>
            <form id="person-form"><div class="field-row"><div class="field"><label class="field-label" for="person-email">Their email (optional)</label><input id="person-email" name="email" type="email" maxlength="254" placeholder="Anyone with the link"></div><div class="field"><label class="field-label" for="person-label">Label (optional)</label><input id="person-label" name="label" maxlength="100" placeholder="e.g. Alex"></div></div>
            <div class="field-row"><div class="field"><label class="field-label" for="person-role">Access</label><select id="person-role" name="role"><option value="guest">Guest — signs in and joins</option><option value="display">Page-only — page files, no sign-in</option></select></div><div class="field"><label class="field-label" for="person-expiry">Expires</label><select id="person-expiry" name="expires_in"><option value="604800">In 7 days</option><option value="86400">In 24 hours</option><option value="2592000">In 30 days</option><option value="">Never</option></select></div></div>
            <div class="actions"><button type="submit">${icon("link")} Create invite link</button></div><p class="fine" role="status" data-status></p></form>
            <div class="result" id="person-result" hidden><h3>${icon("check")} Invite link ready</h3><div class="split"><div class="stack-sm"><div class="copy-box"><label class="field-label" for="person-link">Invite link</label><div class="copy-line"><input id="person-link" type="text" readonly><button class="secondary sm" type="button" data-copy-from="person-link">${icon("copy")} Copy</button></div></div><button class="secondary sm" type="button" id="person-share" hidden>${icon("share")} Share…</button></div><div class="qr-frame" id="person-qr"></div></div></div></div>
          <div class="tab-panel"><h3${c("dashboard.addDialog.agentTitle", d.addDialog.agentTitle)}>${txt(d.addDialog.agentTitle)}</h3><p class="muted" style="font-size:.9rem"${c("dashboard.addDialog.agentLead", d.addDialog.agentLead)}>${txt(d.addDialog.agentLead)}</p>
            ${view.agents.length ? `<div class="check-list" id="agent-grants">${agentChecks}</div><p class="fine" role="status" id="grant-status"></p>` : `<p class="empty">No agents yet. Use <a href="#agents">Your agents → Add agent</a> first.</p>`}</div>
        </div></div></div>
    </dialog>`;
  const empty = `<article class="card" style="grid-column:1/-1;text-align:center;padding:2.5rem 1.5rem"><div class="way-icon" style="display:inline-grid;place-items:center;width:3.2rem;height:3.2rem;border-radius:14px;background:var(--accent-soft);color:var(--accent-text);font-size:1.5rem;margin-bottom:.8rem">${icon("sparkles")}</div><h2${c("dashboard.pages.emptyTitle", d.pages.emptyTitle)}>${txt(d.pages.emptyTitle)}</h2><p class="muted" style="margin:0 auto 1rem"${c("dashboard.pages.emptyLead", d.pages.emptyLead)}>${txt(d.pages.emptyLead)}</p><div class="actions" style="justify-content:center"><button type="button" data-copy-from="build-prompt">${icon("copy")} Copy a starter prompt</button><a class="button secondary" href="https://cookbooks.tendriller.dev/">Explore cookbooks</a><a class="button ghost" href="/agent.md">Agent guide</a></div></article>`;
  const nearResident = view.limits.residents !== null && residents >= Math.ceil(view.limits.residents * 0.8) && residents < view.limits.residents;
  const atResident = view.limits.residents !== null && residents >= view.limits.residents;
  const atPages = view.limits.pages !== null && view.tendrils.length >= view.limits.pages;
  const nearPages = view.limits.pages !== null && view.tendrils.length >= Math.ceil(view.limits.pages * 0.8) && !atPages;
  const nearMcp = Boolean(view.mcpUsage && view.mcpUsage.cap !== null && view.mcpUsage.calls >= Math.ceil(view.mcpUsage.cap * 0.8));
  const canUpgrade = !view.unlimitedHost && (view.planId === "free" || view.planId === "pro");
  const isPro = view.planId === "pro";
  const upgradeWarn = atResident || atPages || nearResident || nearPages;
  const pagePct = view.limits.pages ? Math.min(100, Math.round((view.tendrils.length / view.limits.pages) * 100)) : 0;
  const upgradeTitleKey = isPro ? "dashboard.upgrade.proTitle" : "dashboard.upgrade.freeTitle";
  const upgradeCopyKey = isPro ? "dashboard.upgrade.proCopy" : "dashboard.upgrade.freeCopy";
  const upgradeCtaKey = isPro ? "dashboard.upgrade.proCta" : "dashboard.upgrade.freeCta";
  const upgradeTitle = isPro ? d.upgrade.proTitle : d.upgrade.freeTitle;
  const upgradeCopy = isPro ? d.upgrade.proCopy : d.upgrade.freeCopy;
  const upgradeCta = isPro ? d.upgrade.proCta : d.upgrade.freeCta;
  const upgradeMeter = view.limits.pages !== null
    ? `<div class="upgrade-meter"><div class="upgrade-meter-row"><span><strong>${view.tendrils.length}</strong> / ${view.limits.pages} pages</span><span>${escape(view.planName)} plan</span></div><div class="upgrade-bar" aria-hidden="true"><span style="width:${pagePct}%"></span></div></div>`
    : "";
  const upgradeCard = canUpgrade
    ? (cards.length > 0
        ? `<article class="card upgrade-card${upgradeWarn ? " warn" : ""}"><div class="stack-sm"><div class="upgrade-card-head"><span class="upgrade-card-ico">${icon("sparkles")}</span><div><h3${c(upgradeTitleKey, upgradeTitle)}>${txt(upgradeTitle)}</h3><p${c(upgradeCopyKey, upgradeCopy)}>${txt(upgradeCopy)}</p></div></div>${upgradeMeter}</div><div class="actions tight"><a class="button sm" href="/dashboard/billing">${icon("sparkles")} <span${c(upgradeCtaKey, upgradeCta)}>${txt(upgradeCta)}</span></a><a class="button ghost sm" href="/pricing"><span${c("dashboard.upgrade.compareCta", d.upgrade.compareCta)}>${txt(d.upgrade.compareCta)}</span></a></div></article>`
        : `<article class="card upgrade-card inline-strip${upgradeWarn ? " warn" : ""}"><div class="upgrade-card-head"><span class="upgrade-card-ico">${icon("sparkles")}</span><div><h3${c(upgradeTitleKey, upgradeTitle)}>${txt(upgradeTitle)}</h3><p${c(upgradeCopyKey, upgradeCopy)}>${txt(upgradeCopy)}</p></div></div><div class="actions tight"><a class="button sm" href="/dashboard/billing">${icon("sparkles")} <span${c(upgradeCtaKey, upgradeCta)}>${txt(upgradeCta)}</span></a><a class="button ghost sm" href="/pricing"><span${c("dashboard.upgrade.compareCta", d.upgrade.compareCta)}>${txt(d.upgrade.compareCta)}</span></a></div></article>`)
    : "";
  const greetingKey = firstName ? "dashboard.hero.greetingNamed" : "dashboard.hero.greetingDefault";
  const greetingTemplate = firstName ? d.hero.greetingNamed : d.hero.greetingDefault;
  const body = `<section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("sparkles")} <span${c("dashboard.hero.eyebrow", d.hero.eyebrow)}>${txt(d.hero.eyebrow)}</span></span><h1${c(greetingKey, greetingTemplate)}>${txt(greetingTemplate)}</h1><p class="lead"${c("dashboard.hero.lead", d.hero.lead)}>${txt(d.hero.lead)}</p></div><div class="actions tight"><a class="button secondary sm" href="/dashboard/billing">${icon("sliders")} Plan &amp; usage</a><a class="button secondary sm" href="/dashboard/domains">${icon("link")} Domains</a><a class="button secondary sm" href="/connections">${icon("key")} Assistants</a><a class="button secondary sm" href="#agents">${icon("bot")} Agents</a><form class="inline-form" method="post" action="/auth/logout"><button class="secondary sm" type="submit">${icon("logout")} Sign out</button></form></div></div>
      <div class="stats"><div class="stat"><strong>${view.tendrils.length}${view.limits.pages !== null ? `<small style="font-size:.9rem;color:var(--hero-muted)"> / ${view.limits.pages}</small>` : ""}</strong><span>${view.tendrils.length === 1 ? "page" : "pages"}</span></div><div class="stat"><strong>${view.agents.length}${view.limits.agents !== null && view.limits.agents !== undefined ? `<small style="font-size:.9rem;color:var(--hero-muted)"> / ${view.limits.agents}</small>` : ""}</strong><span>${view.agents.length === 1 ? "agent" : "agents"}</span></div><div class="stat"><strong>${totals.published}</strong><span>published</span></div><div class="stat"><strong>${totals.guests}</strong><span>guest requests</span></div></div></section>
      ${view.agentRevoked ? `<p class="notice" role="status">${icon("check")}<span>Agent revoked. Its credential stopped working and its page connections were closed.</span></p>` : ""}
      ${view.deleted ? `<p class="notice" role="status">${icon("check")}<span>Page deleted. Its files, links and agent access were removed.</span></p>` : ""}
      ${view.subdomainSaved ? `<p class="notice" role="status">${icon("check")}<span>Named subdomain updated. Your original generated address keeps working as a fallback.</span></p>` : ""}
      ${view.inGracePeriod ? `<p class="notice warn">${icon("shield")}<span>Your subscription renewal failed; your ${escape(view.planName)} plan remains active during your 7-day grace period. <a href="/dashboard/billing">Update payment method</a>.</span></p>` : ""}
      ${atResident ? `<p class="notice warn">${icon("layers")}<span>You have reached ${view.limits.residents} resident pages on ${escape(view.planName)}. Your existing pages keep working; delete one you no longer need, <a href="/dashboard/billing">upgrade your plan</a>, or <a href="/self-host">self-host on Cloudflare</a> for unlimited slots.</span></p>` : nearResident ? `<p class="notice">${icon("layers")}<span>You are using ${residents} of ${view.limits.residents} resident pages on ${escape(view.planName)}. <a href="/dashboard/billing">View usage &amp; plans</a> or <a href="/self-host">self-host</a> anytime.</span></p>` : ""}
      ${nearMcp ? `<p class="notice warn">${icon("cpu")}<span>Hosted MCP usage: ${view.mcpUsage!.calls.toLocaleString("en-US")} / ${view.mcpUsage!.cap!.toLocaleString("en-US")} calls this month. <a href="/dashboard/billing">Manage plan or pay-as-you-go</a>, or run <code>npm run agent</code> locally for unlimited access.</span></p>` : ""}
      ${view.systemBroadcastsHtml ?? ""}
      ${view.noticeListHtml ?? ""}
      <section class="card" aria-labelledby="new-title"><div class="card-head"><div><span class="eyebrow">${icon("bot")} <span${c("dashboard.newPage.eyebrow", d.newPage.eyebrow)}>${txt(d.newPage.eyebrow)}</span></span><h2 id="new-title"${c("dashboard.newPage.title", d.newPage.title)}>${txt(d.newPage.title)}</h2><p${c("dashboard.newPage.lead", d.newPage.lead)}>${txt(d.newPage.lead)}</p></div><a class="button secondary sm" href="/agents">Platform guides</a></div><div class="copy-box"><textarea id="build-prompt" readonly rows="4" style="min-height:6.5rem">${escape(buildPrompt)}</textarea><div class="cluster"><button class="sm" type="button" data-copy-from="build-prompt">${icon("copy")} Copy prompt</button><a class="button ghost sm" href="/docs/BUILD_AN_APP.md">${icon("terminal")} Agent instructions</a></div></div><p class="fine" style="margin-top:.75rem"${c("dashboard.newPage.existingHint", d.newPage.existingHint)}>${txt(d.newPage.existingHint)}</p></section>
      ${agentsSection}
      <div class="section-title"><h2${c("dashboard.pages.title", d.pages.title)}>${txt(d.pages.title)}</h2><span class="badge">${view.tendrils.length}${view.limits.pages !== null ? ` / ${view.limits.pages}` : ""}</span><span class="rule"></span>${canUpgrade ? `<a class="button ghost sm" href="/dashboard/billing">${icon("sparkles")} Upgrade plan</a>` : ""}</div>
      <div class="grid">${cards.join("") || empty}${upgradeCard}</div>
      <details class="disclosure"><summary><span${c("dashboard.account.summary", d.account.summary)}>${txt(d.account.summary)}</span></summary><div class="disclosure-body stack"><div class="actions tight"><a class="button secondary sm" href="/dashboard/export">Download account data</a><a class="button secondary sm" href="/auth/link/github">Link GitHub</a><a class="button secondary sm" href="/auth/link/google">Link Google</a><a class="button secondary sm" href="/oauth/connections">OAuth clients</a></div><div class="card danger"><h3${c("dashboard.account.deleteTitle", d.account.deleteTitle)}>${txt(d.account.deleteTitle)}</h3><p class="muted" style="font-size:.88rem"${c("dashboard.account.deleteLead", d.account.deleteLead)}>${txt(d.account.deleteLead)}</p><form method="post" action="/dashboard/delete"><div class="field"><label class="field-label" for="delete-confirm"${c("dashboard.account.deleteConfirmLabel", d.account.deleteConfirmLabel)}>${txt(d.account.deleteConfirmLabel)}</label><input id="delete-confirm" name="confirm" required></div><div class="actions"><button class="danger sm">Delete account</button></div></form></div></div></details>
      ${dialog}
      <dialog class="sheet" id="subdomain-dialog" aria-labelledby="sub-dialog-title" style="width:min(32rem,calc(100vw - 1.5rem))">
        <div class="sheet-head"><div><span class="eyebrow">${icon("link")} Named subdomain</span><h2 id="sub-dialog-title">…</h2><p>Replace this page’s generated subdomain with a unique name under <code>.${escape(pageDomain)}</code>.</p></div><button class="ghost sm icon-button" type="button" data-close aria-label="Close">${icon("x")}</button></div>
        <div class="sheet-body stack-sm">
          ${subAllowed
            ? `<form id="subdomain-form" class="stack-sm">
                <div class="field">
                  <label class="field-label" for="sub-input">Unique subdomain name (${escape(subQuotaLabel)} slots)</label>
                  <input id="sub-input" name="subdomain" type="text" minlength="3" maxlength="45" pattern="[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])" placeholder="e.g. my-app" autocomplete="off">
                  <span class="field-hint">Becomes <code id="sub-preview">https://&lt;name&gt;.${escape(pageDomain)}/</code>. The original generated link stays active as a fallback.</span>
                </div>
                <div class="actions tight">
                  <button type="submit" class="sm">${icon("link")} Save subdomain</button>
                  <button type="button" class="secondary sm" id="sub-reassign" hidden>Move / swap from other page</button>
                  <button type="button" class="danger sm" id="sub-clear" hidden>Remove</button>
                  <button type="button" class="secondary sm" data-close>Cancel</button>
                </div>
                <p class="fine" role="status" id="sub-status"></p>
              </form>`
            : `<p class="muted">Named page subdomains are included on <strong>Pro</strong> (25 pages), <strong>Team</strong> (100 pages), and <strong>Self-Hosted</strong> (unlimited).</p>
               <div class="actions tight"><a class="button sm" href="/dashboard/billing">${icon("sparkles")} Upgrade to Pro — $12/mo</a><a class="button secondary sm" href="/pricing">Compare plans</a><button type="button" class="danger sm" id="sub-clear" hidden>Remove paused subdomain</button></div>
               <p class="fine" role="status" id="sub-status"></p>`}
        </div>
      </dialog>
      <dialog class="sheet" id="delete-dialog" aria-labelledby="delete-title" style="width:min(30rem,calc(100vw - 1.5rem))"><form method="post" id="delete-form"><div class="sheet-head"><div><span class="eyebrow" style="color:var(--danger)">${icon("trash")} <span${c("dashboard.deleteDialog.eyebrow", d.deleteDialog.eyebrow)}>${txt(d.deleteDialog.eyebrow)}</span></span><h2 id="delete-title">…</h2></div><button class="ghost sm icon-button" type="button" data-close aria-label="Close">${icon("x")}</button></div><div class="sheet-body"><p${c("dashboard.deleteDialog.body", d.deleteDialog.body)}>${txt(d.deleteDialog.body)}</p>${view.limits.residents !== null ? `<p class="fine" id="delete-resident" hidden>This frees one of your ${view.limits.residents} resident page slots.</p>` : `<p class="fine" id="delete-resident" hidden></p>`}<input type="hidden" name="confirm" id="delete-confirm-id"><div class="actions"><button class="danger" type="submit">${icon("trash")} Delete permanently</button><button class="secondary" type="button" data-close>Cancel</button></div></div></form></dialog>`;

  const script = `<script>(()=>{
const $=id=>document.getElementById(id),dialog=$('add-dialog');let current=null,opener=null;
const flash=(b,t)=>{const old=b.innerHTML;b.textContent=t;b.disabled=true;setTimeout(()=>{b.innerHTML=old;b.disabled=false},1600)};
const copy=async(text,b)=>{try{await navigator.clipboard.writeText(text);flash(b,'Copied!')}catch{const f=b.closest('.copy-box')?.querySelector('textarea,input:not([type=hidden])');if(f){f.focus();f.select()}flash(b,'Press Ctrl+C')}};
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.copy)copy(b.dataset.copy,b);
 else if(b.dataset.copyFrom){const f=$(b.dataset.copyFrom);copy(f.value,b)}
 else if(b.dataset.add){opener=b;current=b.dataset.add;$('add-title').textContent=b.dataset.name;$('device-link').value=b.dataset.url;$('device-qr').src='/dashboard/t/'+current+'/qr.svg';
  const granted=new Set((b.dataset.agents||'').split(' ').filter(Boolean));dialog.querySelectorAll('[data-grant]').forEach(i=>i.checked=granted.has(i.value));if($('grant-status'))$('grant-status').textContent='';
  $('person-result').hidden=true;dialog.querySelectorAll('[data-status]').forEach(s=>s.textContent='');$('tab-device').checked=true;dialog.showModal()}
 else if(b.id==='agent-add')join(b);
 else if(b.dataset.delete){opener=b;const d=$('delete-dialog');$('delete-title').textContent='Delete “'+b.dataset.name+'”?';$('delete-confirm-id').value=b.dataset.delete;$('delete-form').action='/dashboard/t/'+b.dataset.delete+'/delete';$('delete-resident').hidden=!b.dataset.resident;d.showModal()}
 else if(b.dataset.subdomain){opener=b;current=b.dataset.subdomain;const d=$('subdomain-dialog');$('sub-dialog-title').textContent=b.dataset.name;const inp=$('sub-input'),clr=$('sub-clear'),re=$('sub-reassign'),st=$('sub-status'),prev=$('sub-preview');if(st)st.textContent='';if(re)re.hidden=true;if(inp){inp.value=b.dataset.currentSub||'';if(prev)prev.textContent='https://'+(inp.value||'<name>')+'.${escape(pageDomain)}/'}if(clr)clr.hidden=!b.dataset.currentSub;d.showModal()}
 else if(b.hasAttribute('data-close'))b.closest('dialog').close()});
$('subdomain-dialog')?.addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.close()});
$('sub-input')?.addEventListener('input',e=>{const v=e.target.value.trim().toLowerCase(),p=$('sub-preview'),re=$('sub-reassign');if(p)p.textContent='https://'+(v||'<name>')+'.${escape(pageDomain)}/';if(re)re.hidden=true});
const saveSub=async(val,opts={})=>{const st=$('sub-status'),re=$('sub-reassign');if(st)st.textContent='Saving…';if(re)re.hidden=true;
 try{const r=await fetch('/dashboard/t/'+current+'/subdomain',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({subdomain:val,...opts}),credentials:'same-origin'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){if(r.status===409&&data.error?.owned_by_account&&re){re.hidden=false;re.textContent='Move / swap from '+data.error.existing_tendril_id}throw Error(data.error?.message||'Could not update subdomain.')}
  location.href='/dashboard?subdomain_saved=1'}
 catch(err){if(st)st.textContent=err.message}};
$('subdomain-form')?.addEventListener('submit',e=>{e.preventDefault();const v=$('sub-input')?.value.trim().toLowerCase()||'';saveSub(v||null)});
$('sub-reassign')?.addEventListener('click',()=>{const v=$('sub-input')?.value.trim().toLowerCase()||'';if(v)saveSub(v,{reassign:true,swap:true})});
$('sub-clear')?.addEventListener('click',()=>saveSub(null));
$('delete-dialog').addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.close()});
dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
dialog.addEventListener('close',()=>opener&&opener.focus());
const post=async(form,kind,body)=>{const status=form.querySelector('[data-status]'),btn=form.querySelector('[type=submit]');btn.disabled=true;status.textContent='Creating…';
 try{const r=await fetch('/dashboard/t/'+current+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error?.message||'Could not create it. Try again.');status.textContent='';return data}
 catch(err){status.textContent=err.message;return null}finally{btn.disabled=false}};
$('person-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,v=id=>$(id).value.trim(),body={role:v('person-role'),label:v('person-label')||undefined,email:v('person-email')||undefined,expires_in:v('person-expiry')?Number(v('person-expiry')):undefined};
 const link=await post(f,'invite',body);if(!link)return;$('person-link').value=link.url;const qr=$('person-qr');qr.innerHTML=link.qr_svg?link.qr_svg+'<span>Scan to join</span>':'<span>Copy the link instead.</span>';
 const share=$('person-share');share.hidden=typeof navigator.share!=='function';share.onclick=()=>navigator.share({title:$('add-title').textContent,url:link.url}).catch(()=>{});$('person-result').hidden=false;$('person-email').value=$('person-label').value=''});
async function join(btn){const status=$('join-status');btn.disabled=true;status.textContent='Creating…';
 try{const r=await fetch('/dashboard/agents/join',{method:'POST',credentials:'same-origin'});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error?.message||'Could not create a join code. Try again.');
  status.textContent='';$('join-blurb').value=data.blurb;$('join-result').hidden=false;$('join-blurb').focus();$('join-blurb').select()}
 catch(err){status.textContent=err.message}finally{btn.disabled=false}}
dialog.addEventListener('change',async e=>{const box=e.target.closest('[data-grant]');if(!box||!current)return;const status=$('grant-status'),want=box.checked;box.disabled=true;status.textContent='Saving…';
 try{const r=await fetch('/dashboard/t/'+current+'/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:box.value,granted:want}),credentials:'same-origin'});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error?.message||'Could not change access. Try again.');status.textContent=want?'Access granted.':'Access removed.';
  const opener=document.querySelector('[data-add="'+current+'"]'),set=new Set((opener?.dataset.agents||'').split(' ').filter(Boolean));want?set.add(box.value):set.delete(box.value);if(opener)opener.dataset.agents=[...set].join(' ')}
 catch(err){box.checked=!want;status.textContent=err.message}finally{box.disabled=false}});
})()</script>`;

  return { body, script, extraCss: DASHBOARD_CSS };
}

export function renderDashboardHtml(view: DashboardViewData): string {
  const { body, script, extraCss } = renderDashboardContent(view);
  return renderShell({
    title: "Dashboard",
    body,
    script,
    width: "wide",
    brand: brandMark(brandBase, "/?home=1"),
    extraCss,
  });
}

function escape(s: string): string { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
export async function dashboard(req: Request, env: Env, url: URL): Promise<Response> {
  const started = performance.now();
  const session = await serviceSession(req, env, true);
  const sessionMs = performance.now() - started;
  if (!session || !env.ACCOUNTS) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname)}` } });
  const db = env.ACCOUNTS;
  const [notices, broadcastFeed] = await Promise.all([
    db.prepare("SELECT kind, tendril_id, reason, created_at FROM account_notices WHERE account_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(session.accountId).all<{ kind: string; tendril_id: string | null; reason: string; created_at: number }>(),
    listActiveBroadcasts(env, { audiences: ["dashboard", "page_owners"] }),
  ]);
  const systemBroadcasts = broadcastFeed.broadcasts.length
    ? `<section class="card" aria-labelledby="system-broadcasts-title"><div class="card-head"><div><span class="eyebrow">Service</span><h2 id="system-broadcasts-title">System announcements</h2></div><span class="badge ${broadcastFeed.broadcasts.some(b => b.payload.severity === "critical" || b.payload.severity === "urgent") ? "danger" : "warn"}">${broadcastFeed.broadcasts.length}</span></div><ul class="list">${broadcastFeed.broadcasts.map(({ payload }) => {
        const badge = payload.severity === "critical" || payload.severity === "urgent" ? "danger" : payload.severity === "recommended" ? "warn" : "";
        return `<li class="list-item"><div class="list-item-main"><div class="list-item-title"><span class="badge ${badge}">${escape(payload.kind)} · ${escape(payload.severity)}</span> ${escape(payload.title)}</div><p class="list-item-sub">${escape(payload.summary)}${payload.docs_url ? ` · <a href="${escape(payload.docs_url)}" target="_blank" rel="noopener">Details</a>` : ""}</p>${payload.body ? `<p class="fine" style="margin-top:.35rem;white-space:pre-wrap">${escape(payload.body)}</p>` : ""}</div></li>`;
      }).join("")}</ul></section>`
    : "";
  const noticeList = notices.results.length
    ? `<section class="card"><div class="card-head"><div><h2>Notices</h2></div><span class="badge warn">${notices.results.length}</span></div><ul class="list">${notices.results.map(n => `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${escape(n.kind.replaceAll("_", " "))}${n.tendril_id ? ` <code>${escape(n.tendril_id)}</code>` : ""}</div><p class="list-item-sub">${escape(n.reason)} · ${escape(new Date(n.created_at).toISOString())}</p></div></li>`).join("")}</ul></section>`
    : "";
  const signOut = `<form class="inline-form" method="post" action="/auth/logout"><button class="secondary sm" type="submit">Sign out</button></form>`;
  if (session.suspendedAt) {
    if (req.method !== "GET" || url.pathname !== "/dashboard") return errorResponse(403, "suspended", "Account access is limited to notices and appeals");
    const held = await db.prepare("SELECT id FROM tendrils WHERE owner_account = ? AND state = 'held' ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string }>();
    return servicePage("Account suspended", `<div class="stack"><section class="card danger"><div class="card-head"><div><span class="eyebrow">Account</span><h1>Your account is suspended</h1><p>Your pages are unavailable. You can review notices and submit an appeal.</p></div>${signOut}</div><div class="actions"><a class="button" href="/appeal/account">Appeal account suspension</a></div></section>
      <section class="card"><h2>Held pages</h2>${held.results.length ? `<ul class="list">${held.results.map(t => `<li class="list-item"><div class="list-item-main"><code>${escape(t.id)}</code></div><a class="button sm secondary" href="/appeal?tendril=${escape(t.id)}">Appeal hold</a></li>`).join("")}</ul>` : '<p class="empty">No held pages.</p>'}</section>${noticeList}</div>`);
  }
  const owned = async (id: string) => !!await db.prepare("SELECT 1 FROM tendrils WHERE id = ? AND owner_account = ?").bind(id, session.accountId).first();
  const pageFetch = (id: string, path: string, init: RequestInit = {}) => env.TENDRIL.get(env.TENDRIL.idFromName(id)).fetch(new Request(`https://tendril.internal/account/${path}`, {
    ...init, headers: { ...init.headers as Record<string, string>, "x-account-id": session.accountId },
  }));
  const qrMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/qr\.svg$/.exec(url.pathname);
  if (qrMatch && req.method === "GET") {
    if (!await owned(qrMatch[1])) return errorResponse(404, "not_found");
    const response = await pageFetch(qrMatch[1], "summary");
    if (!response.ok) return errorResponse(502, "unavailable", "Could not load the page link");
    const { page_url } = await response.json() as { page_url: string };
    let svg: string;
    try { svg = renderQrSvg(page_url, { sizePx: 176, label: "Scan to open your page on another device" }); }
    catch { return errorResponse(422, "too_long", "This page link is too long for a QR code"); }
    return new Response(svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" '), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  const deleteMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/delete$/.exec(url.pathname);
  if (deleteMatch && req.method === "POST") {
    if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid dashboard origin");
    const id = deleteMatch[1];
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
    if (form.get("confirm") !== id) return errorResponse(400, "confirmation_required", "Confirm deleting this page");
    if (!await owned(id)) return errorResponse(404, "not_found");
    await cleanupPageCustomDomain(env, id);
    const response = await pageFetch(id, "delete", { method: "POST" });
    if (!response.ok) return errorResponse(502, "unavailable", "The page could not be deleted. Try again.");
    return new Response(null, { status: 303, headers: { Location: "/dashboard?deleted=1", "Cache-Control": "no-store" } });
  }
  const remixMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/remix$/.exec(url.pathname);
  if (remixMatch && req.method === "POST") {
    try {
      if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) throw new HttpError(403, "bad_origin", "Invalid dashboard origin");
      await requireWritesOpen(env);
      const isJson = (req.headers.get("Content-Type") ?? "").startsWith("application/json");
      let name: string | undefined;
      if (isJson) {
        const body = JSON.parse(new TextDecoder().decode(await readBody(req, 4096)) || "{}") as { name?: unknown };
        if (typeof body?.name === "string" && body.name.trim()) name = body.name.trim();
      } else {
        const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
        const raw = form.get("name")?.trim();
        if (raw) name = raw;
      }
      const created = await remixExistingPage(env, session.accountId, remixMatch[1], { name });
      if (isJson || req.headers.get("Accept")?.includes("application/json")) {
        return json(created, 201, { "Cache-Control": "no-store" });
      }
      return new Response(null, { status: 303, headers: { Location: created.page_url, "Cache-Control": "no-store" } });
    } catch (error) { return toErrorResponse(error); }
  }
  const sameOrigin = () => { if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) throw new HttpError(403, "bad_origin", "Invalid dashboard origin"); };
  const jsonBody = async () => {
    if (!(req.headers.get("Content-Type") ?? "").startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Expected JSON");
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(await readBody(req, 4096)) || "{}"); }
    catch { throw new HttpError(400, "bad_json", "Request body is not valid JSON"); }
    if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
    return body;
  };
  // Agents belong to the account. A join code adds one; grants are per page.
  if (url.pathname === "/dashboard/agents/join" && req.method === "POST") {
    try {
      sameOrigin();
      await requireWritesOpen(env);
      return json(await createJoinCode(env, session.accountId), 201, { "Cache-Control": "no-store" });
    } catch (error) { return toErrorResponse(error); }
  }
  const revokeMatch = /^\/dashboard\/agents\/(ag_[a-z2-7]{26})\/revoke$/.exec(url.pathname);
  if (revokeMatch && req.method === "POST") {
    try {
      sameOrigin();
      await requireWritesOpen(env);
      if (!await revokeAgent(env, revokeMatch[1], session.accountId)) throw new HttpError(404, "not_found", "No such agent");
      return new Response(null, { status: 303, headers: { Location: "/dashboard?agent_revoked=1#agents", "Cache-Control": "no-store" } });
    } catch (error) { return toErrorResponse(error); }
  }
  if (url.pathname === "/dashboard/subdomains/check" && req.method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    const pageId = url.searchParams.get("page_id");
    return json(await checkSubdomainAvailability(env, name, pageId && /^[a-z2-7]{12}$/.test(pageId) ? pageId : null));
  }
  const subdomainMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/subdomain$/.exec(url.pathname);
  if (subdomainMatch && req.method === "POST") {
    try {
      sameOrigin();
      await requireWritesOpen(env);
      const isJson = (req.headers.get("Content-Type") ?? "").startsWith("application/json");
      let rawSub: string | null = null;
      let reassign = false;
      let swap = false;
      if (isJson) {
        const body = await jsonBody();
        if (body.subdomain !== null && body.subdomain !== undefined && typeof body.subdomain !== "string") {
          throw new HttpError(400, "invalid_subdomain", "Expected { subdomain: string | null }");
        }
        rawSub = body.subdomain === undefined || body.subdomain === null ? null : body.subdomain;
        reassign = body.reassign === true;
        swap = body.swap === true;
      } else {
        const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
        const val = form.get("subdomain")?.trim() ?? "";
        rawSub = val || null;
        reassign = form.get("reassign") === "1" || form.get("reassign") === "true";
        swap = form.get("swap") === "1" || form.get("swap") === "true";
      }
      const result = await setPageSubdomain(env, session.accountId, subdomainMatch[1], rawSub, `owner:${session.accountId}`, { reassign, swap });
      if (isJson || req.headers.get("Accept")?.includes("application/json")) {
        return json(result, 200, { "Cache-Control": "no-store" });
      }
      return new Response(null, { status: 303, headers: { Location: "/dashboard?subdomain_saved=1", "Cache-Control": "no-store" } });
    } catch (error) { return toErrorResponse(error); }
  }
  const grantMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/agents$/.exec(url.pathname);
  if (grantMatch && req.method === "POST") {
    try {
      sameOrigin();
      await requireWritesOpen(env);
      const body = await jsonBody();
      if (typeof body.agent !== "string" || typeof body.granted !== "boolean") throw new HttpError(400, "bad_request", "Expected { agent, granted }");
      await setAgentGrant(env, session.accountId, body.agent, grantMatch[1], body.granted);
      return json({ page: grantMatch[1], agent: body.agent, granted: body.granted });
    } catch (error) { return toErrorResponse(error); }
  }
  const primaryMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/primary$/.exec(url.pathname);
  if (primaryMatch && req.method === "POST") {
    try {
      sameOrigin();
      await requireWritesOpen(env);
      const body = await jsonBody();
      if (body.agent_id !== null && typeof body.agent_id !== "string") throw new HttpError(400, "bad_request", "Expected { agent_id: string | null }");
      const roster = await setPagePrimaryAgent(env, session.accountId, primaryMatch[1], body.agent_id);
      return json(roster);
    } catch (error) { return toErrorResponse(error); }
  }
  const shareMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/invite$/.exec(url.pathname);
  if (shareMatch && req.method === "POST") {
    try {
      if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) throw new HttpError(403, "bad_origin", "Invalid dashboard origin");
      if (!(req.headers.get("Content-Type") ?? "").startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Expected JSON");
      await requireWritesOpen(env);
      if (!await owned(shareMatch[1])) throw new HttpError(404, "not_found");
      const body = JSON.parse(new TextDecoder().decode(await readBody(req, 4096)) || "{}");
      if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
      const response = await pageFetch(shareMatch[1], "invite", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) return response;
      const link = await response.json() as { url: string };
      let qr = "";
      try { qr = renderQrSvg(link.url, { sizePx: 176, label: "Scan to join" }); } catch { /* copy the link instead */ }
      return json({ ...link, qr_svg: qr }, 201);
    } catch (error) {
      if (error instanceof SyntaxError) return errorResponse(400, "bad_json", "Request body is not valid JSON");
      return toErrorResponse(error);
    }
  }
  const detail = /^\/dashboard\/t\/([a-z2-7]{12})$/.exec(url.pathname);
  if (detail && req.method === "GET") {
    const id = detail[1];
    if (!await owned(id)) return errorResponse(404, "not_found");
    const response = await pageFetch(id, "activity");
    if (!response.ok) return errorResponse(502, "unavailable", "Could not load page activity");
    const data = await response.json() as { events: { ts: number; kind: string; summary: string }[] };
    return servicePage("Page activity", renderPageActivityBody({ id, events: data.events }));
  }
  if (req.method === "GET") {
    const tendrils = await db.prepare("SELECT id, lifetime, state, created_at FROM tendrils WHERE owner_account = ? ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string; lifetime: string; state: string; created_at: number }>();
    const [agents, grants, limits, ent, subCount] = await Promise.all([
      listAccountAgents(env, session.accountId),
      accountGrants(env, session.accountId),
      accountLimits(env, session.accountId),
      getAccountEntitlements(env, session.accountId).catch(() => null),
      db.prepare("SELECT COUNT(*) AS n FROM page_subdomains WHERE account_id = ?").bind(session.accountId).first<{ n: number }>().catch(() => null),
    ]);
    const dbMs = performance.now() - started - sessionMs;
    const summaries = await Promise.all(tendrils.results.map(async t => {
      try {
        const response = await pageFetch(t.id, "summary", { signal: AbortSignal.timeout(3000) });
        if (response.ok) return await response.json() as DashboardPageSummary;
      } catch { /* An unavailable page must not prevent account navigation. */ }
      return null;
    }));
    const planName = ent ? planSpec(ent.plan).name : "Free";
    const { body, script, extraCss } = renderDashboardContent({
      origin: publicBase(env),
      pageBaseDomain: env.PAGE_BASE_DOMAIN || "tendriller.dev",
      who: session.email ?? session.accountId,
      email: session.email,
      planName,
      planId: ent?.plan ?? "free",
      unlimitedHost: Boolean(ent?.unlimitedHost),
      inGracePeriod: Boolean(ent?.inGracePeriod),
      subdomainAllowed: Boolean(ent && subdomainPlanAllowed(ent)),
      subdomainUsed: subCount?.n ?? 0,
      subdomainLimit: ent ? (ent.unlimitedHost ? null : ent.quotas.customSubdomains) : 0,
      limits: {
        pages: limits.pages,
        residents: limits.residents,
        agents: ent?.quotas.agents ?? null,
      },
      mcpUsage: ent ? { calls: ent.usage.mcpCalls, cap: ent.quotas.mcpCallsPerMonth } : null,
      tendrils: tendrils.results,
      summaries,
      agents,
      grants,
      systemBroadcastsHtml: systemBroadcasts,
      noticeListHtml: noticeList,
      agentRevoked: url.searchParams.get("agent_revoked") === "1",
      deleted: url.searchParams.get("deleted") === "1",
      subdomainSaved: url.searchParams.get("subdomain_saved") === "1",
    });
    const response = servicePage("Dashboard", body, script, 200, {
      wide: true,
      remoteImages: true,
      brand: brandMark(brandBase, "/?home=1"),
      extraCss,
    });
    response.headers.set("Server-Timing", `session;dur=${sessionMs.toFixed(1)}, account-db;dur=${dbMs.toFixed(1)}, page-summaries;dur=${(performance.now() - started - sessionMs - dbMs).toFixed(1)}, total;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  }
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid dashboard origin");
  return errorResponse(404, "not_found");
}
