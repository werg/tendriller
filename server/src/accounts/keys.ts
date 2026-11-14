import type { Env } from "../env";
import { errorResponse } from "../http";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";
import { servicePage } from "./ui";

function escape(s: string): string { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
export async function dashboard(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env, true);
  if (!session || !env.ACCOUNTS) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname)}` } });
  const db = env.ACCOUNTS;
  const notices = await db.prepare("SELECT kind, tendril_id, reason, created_at FROM account_notices WHERE account_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(session.accountId).all<{ kind: string; tendril_id: string | null; reason: string; created_at: number }>();
  const noticeList = `<h2>Notices</h2><ul>${notices.results.map(n => `<li><strong>${escape(n.kind.replaceAll("_", " "))}</strong>${n.tendril_id ? ` · ${escape(n.tendril_id)}` : ""}: ${escape(n.reason)} · ${escape(new Date(n.created_at).toISOString())}</li>`).join("") || "<li>No notices</li>"}</ul>`;
  const signOut = `<form method="post" action="/auth/logout"><button class="secondary" type="submit">Sign out</button></form>`;
  if (session.suspendedAt) {
    if (req.method !== "GET" || url.pathname !== "/dashboard") return errorResponse(403, "suspended", "Account access is limited to notices and appeals");
    const held = await db.prepare("SELECT id FROM tendrils WHERE owner_account = ? AND state = 'held' ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string }>();
    return servicePage("Account suspended", `<section class="hero"><h1>Your account is suspended</h1><p>Your pages are unavailable. You can review notices and submit an appeal.</p>${signOut}</section>
      <p><a class="button" href="/appeal/account">Appeal account suspension</a></p>
      <h2>Held pages</h2><ul>${held.results.map(t => `<li>${escape(t.id)} · <a href="/appeal?tendril=${escape(t.id)}">Appeal this hold</a></li>`).join("") || "<li>No held pages</li>"}</ul>${noticeList}`);
  }
  const detail = /^\/dashboard\/t\/([a-z2-7]{12})$/.exec(url.pathname);
  if (detail && req.method === "GET") {
    const id = detail[1];
    const owned = await db.prepare("SELECT 1 FROM tendrils WHERE id = ? AND owner_account = ?").bind(id, session.accountId).first();
    if (!owned) return errorResponse(404, "not_found");
    const stub = env.TENDRIL.get(env.TENDRIL.idFromName(id));
    const response = await stub.fetch(new Request("https://tendril.internal/account/sensors", { headers: { "x-account-id": session.accountId } }));
    if (!response.ok) return errorResponse(502, "unavailable", "Could not load sensor history");
    const data = await response.json() as { devices: { id: string; name: string | null }[];
      events: { ts: number; device: string | null; summary: string }[] };
    const names = new Map(data.devices.map(d => [d.id, d.name ?? d.id]));
    return servicePage("Sensor history", `
      <p><a href="/dashboard">Back to dashboard</a></p><h1>Sensor history for ${escape(id)}</h1>
      <p>Recent page sensor activity reported by connected devices.</p><ul>${data.events.map(e =>
        `<li>${escape(new Date(e.ts).toISOString())} · ${escape(names.get(e.device ?? "") ?? e.device ?? "Unknown device")} · ${escape(e.summary)}</li>`).join("")}</ul>
      `);
  }
  if (req.method === "GET") {
    const tendrils = await db.prepare("SELECT id, lifetime, state, created_at FROM tendrils WHERE owner_account = ? ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string; lifetime: string; state: string; created_at: number }>();
    const cards = await Promise.all(tendrils.results.map(async t => {
      const response = await env.TENDRIL.get(env.TENDRIL.idFromName(t.id)).fetch(new Request("https://tendril.internal/account/summary", { headers: { "x-account-id": session.accountId } }));
      const info = response.ok ? await response.json() as { name: string; page_url: string; version: number; held: boolean; bytes: number; agents: number; guests_waiting: number; last_activity: { ts: number; summary: string } | null } : null;
      return `<article class="card"><span class="eyebrow">${escape(t.lifetime.replace("_", " "))} · ${info?.held ? "Held for review" : escape(t.state)}</span><h3>${escape(info?.name ?? t.id)}</h3><p class="muted">${info?.version ? `Version ${info.version}` : "Agent is preparing the first page"} · ${info ? `${(info.bytes / 1048576).toFixed(1)} MB stored · ${info.agents} agents` : "Details temporarily unavailable"}</p>${info?.last_activity ? `<p><small>Latest: ${escape(info.last_activity.summary)} · ${escape(new Date(info.last_activity.ts).toLocaleString())}</small></p>` : ""}${info?.guests_waiting ? `<p class="notice">${info.guests_waiting} guest ${info.guests_waiting === 1 ? "request" : "requests"} waiting</p>` : ""}<div class="actions">${info?.page_url && !info.held ? `<a class="button" href="${escape(info.page_url)}">Open page</a><button class="secondary" data-copy="${escape(info.page_url)}" type="button">Copy link</button><a href="${escape(info.page_url)}">Manage agents and guests ↗</a>` : ""}<a href="/dashboard/t/${escape(t.id)}">Sensor history</a>${t.state === "held" ? `<a href="/appeal?tendril=${escape(t.id)}">Appeal hold</a>` : ""}</div></article>`;
    }));
    const body = `<section class="hero"><span class="eyebrow">Your workspace</span><h1>Pages made with your agents.</h1><p>Open a page to talk to its agent, share its link, or manage access. You're signed in as ${escape(session.email ?? session.accountId)}.</p>${signOut}</section>${noticeList}<h2>Your pages</h2><div class="grid">${cards.join("") || `<article class="card"><h3>Your first page will appear here</h3><p>Give an agent the <a href="/agent.md">Tendriller guide</a> to create one for you.</p></article>`}</div><details><summary>Account settings</summary><p><a href="/dashboard/export">Download account data</a> · <a href="/auth/link/github">Link GitHub</a> · <a href="/auth/link/google">Link Google</a></p><div class="card danger"><h2>Delete account</h2><p>Permanently deletes your pages and stored files.</p><form method="post" action="/dashboard/delete"><label>Type DELETE <input name="confirm" required></label><button>Delete account</button></form></div></details>`;
    const script = `<script>document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='Copied!'})</script>`;
    return servicePage("Dashboard", body, script);
  }
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid dashboard origin");
  return errorResponse(404, "not_found");
}
