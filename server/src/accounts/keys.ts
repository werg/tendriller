import type { Env } from "../env";
import { errorResponse } from "../http";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";
import { servicePage } from "./ui";

function escape(s: string): string { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
export async function dashboard(req: Request, env: Env, url: URL): Promise<Response> {
  const started = performance.now();
  const session = await serviceSession(req, env, true);
  const sessionMs = performance.now() - started;
  if (!session || !env.ACCOUNTS) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname)}` } });
  const db = env.ACCOUNTS;
  const notices = await db.prepare("SELECT kind, tendril_id, reason, created_at FROM account_notices WHERE account_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(session.accountId).all<{ kind: string; tendril_id: string | null; reason: string; created_at: number }>();
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
  const detail = /^\/dashboard\/t\/([a-z2-7]{12})$/.exec(url.pathname);
  if (detail && req.method === "GET") {
    const id = detail[1];
    const owned = await db.prepare("SELECT 1 FROM tendrils WHERE id = ? AND owner_account = ?").bind(id, session.accountId).first();
    if (!owned) return errorResponse(404, "not_found");
    const stub = env.TENDRIL.get(env.TENDRIL.idFromName(id));
    const response = await stub.fetch(new Request("https://tendril.internal/account/activity", { headers: { "x-account-id": session.accountId } }));
    if (!response.ok) return errorResponse(502, "unavailable", "Could not load page activity");
    const data = await response.json() as { events: { ts: number; kind: string; summary: string }[] };
    return servicePage("Page activity", `<a class="back-link" href="/dashboard">← Back to dashboard</a><div class="page-head"><span class="eyebrow">Activity</span><h1>Page <code>${escape(id)}</code></h1><p class="lead">Recent publication, access and host lifecycle events.</p></div>
      ${data.events.length ? `<ul class="list">${data.events.map(e => `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${escape(e.summary)}</div><p class="list-item-sub">${escape(e.kind)} · ${escape(new Date(e.ts).toISOString())}</p></div></li>`).join("")}</ul>` : '<p class="empty">No recorded activity yet.</p>'}`);
  }
  if (req.method === "GET") {
    const tendrils = await db.prepare("SELECT id, lifetime, state, created_at FROM tendrils WHERE owner_account = ? ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string; lifetime: string; state: string; created_at: number }>();
    const dbMs = performance.now() - started - sessionMs;
    const cards = await Promise.all(tendrils.results.map(async t => {
      type Summary = { name: string; page_url: string; version: number; held: boolean; bytes: number; agents: number; guests_waiting: number; last_activity: { ts: number; summary: string } | null };
      let info: Summary | null = null;
      try {
        const response = await env.TENDRIL.get(env.TENDRIL.idFromName(t.id)).fetch(new Request("https://tendril.internal/account/summary", {
          headers: { "x-account-id": session.accountId }, signal: AbortSignal.timeout(3000),
        }));
        if (response.ok) info = await response.json() as Summary;
      } catch { /* An unavailable page must not prevent account navigation. */ }
      const stateBadge = info?.held ? '<span class="badge danger">Held</span>' : t.state === 'active' ? '<span class="badge ok">Active</span>' : `<span class="badge">${escape(t.state)}</span>`;
      return `<article class="card"><div class="card-head"><div><span class="eyebrow">${escape(t.lifetime.replace("_", " "))}</span><h3>${escape(info?.name ?? t.id)}</h3></div>${stateBadge}</div><p class="muted" style="font-size:.88rem">${info?.version ? `v${info.version}` : "Preparing first release"} · ${info ? `${(info.bytes / 1048576).toFixed(1)} MB · ${info.agents} ${info.agents === 1 ? "agent" : "agents"}` : "Details unavailable"}</p>${info?.last_activity ? `<p><small>${escape(info.last_activity.summary)} · ${escape(new Date(info.last_activity.ts).toLocaleString())}</small></p>` : ""}${info?.guests_waiting ? `<p class="notice warn">${info.guests_waiting} guest ${info.guests_waiting === 1 ? "request" : "requests"} waiting</p>` : ""}<div class="actions">${info?.page_url && !info.held ? `<a class="button sm" href="${escape(info.page_url)}">Open</a><button class="secondary sm" data-share="${escape(info.page_url)}" data-title="${escape(info?.name ?? t.id)}" type="button" hidden>Share</button><button class="secondary sm" data-copy="${escape(info.page_url)}" type="button">Copy link</button><a class="button ghost sm" href="${escape(info.page_url)}_tendril/manage">Settings</a>` : ""}<a class="button ghost sm" href="/dashboard/t/${escape(t.id)}">Activity</a>${t.state === "held" ? `<a class="button sm danger" href="/appeal?tendril=${escape(t.id)}">Appeal hold</a>` : ""}</div></article>`;
    }));
    const body = `<div class="stack"><section class="card"><div class="page-head-row"><div><span class="eyebrow">Workspace</span><h1>Your pages</h1><p class="muted">Signed in as ${escape(session.email ?? session.accountId)}.</p></div><div class="actions tight"><a class="button secondary sm" href="/connections">Assistants</a><a class="button secondary sm" href="/dashboard/setups">Setups</a>${signOut}</div></div></section>${noticeList}<div class="grid">${cards.join("") || `<article class="card"><h3>Start with something useful</h3><p class="muted">Tell your agent what you want to build. Your first page will appear here.</p><div class="actions"><a class="button" href="https://cookbooks.tendriller.dev/">Explore cookbooks</a><a class="button secondary" href="/agent.md">Agent guide</a></div></article>`}</div><details class="disclosure"><summary>Account settings</summary><div class="disclosure-body stack"><div class="actions tight"><a class="button secondary sm" href="/dashboard/export">Download account data</a><a class="button secondary sm" href="/auth/link/github">Link GitHub</a><a class="button secondary sm" href="/auth/link/google">Link Google</a><a class="button secondary sm" href="/oauth/connections">OAuth clients</a></div><div class="card danger"><h3>Delete account</h3><p class="muted" style="font-size:.88rem">Permanently deletes your pages and stored files.</p><form method="post" action="/dashboard/delete"><div class="field"><label class="field-label" for="delete-confirm">Type DELETE to confirm</label><input id="delete-confirm" name="confirm" required></div><div class="actions"><button class="danger sm">Delete account</button></div></form></div></div></details></div>`;
    const script = `<script>document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='Copied!';setTimeout(()=>b.textContent='Copy link',1800)});if(typeof navigator.share==='function'){document.querySelectorAll('[data-share]').forEach(b=>{b.hidden=false;b.onclick=async()=>{try{await navigator.share({title:b.dataset.title,url:b.dataset.share})}catch{}}})}</script>`;
    const response = servicePage("Dashboard", body, script, 200, { wide: true });
    response.headers.set("Server-Timing", `session;dur=${sessionMs.toFixed(1)}, account-db;dur=${dbMs.toFixed(1)}, page-summaries;dur=${(performance.now() - started - sessionMs - dbMs).toFixed(1)}, total;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  }
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid dashboard origin");
  return errorResponse(404, "not_found");
}
