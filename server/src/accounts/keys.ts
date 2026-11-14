import type { Env } from "../env";
import { errorResponse, json, readJson } from "../http";
import { sha256Hex } from "../ids";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";
import { servicePage } from "./ui";

function escape(s: string): string { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "ak_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function apiKeyAccount(req: Request, env: Env): Promise<string | null> {
  const token = /^Bearer\s+(ak_[A-Za-z0-9_-]+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token || !env.ACCOUNTS) return null;
  const hash = await sha256Hex(token);
  const row = await env.ACCOUNTS.prepare(`SELECT k.account_id FROM api_keys k JOIN accounts a ON a.id = k.account_id
    WHERE k.hash = ? AND a.suspended_at IS NULL AND a.deleting_at IS NULL`).bind(hash).first<{ account_id: string }>();
  if (!row) return null;
  await env.ACCOUNTS.prepare("UPDATE api_keys SET last_used = ? WHERE hash = ?").bind(Date.now(), hash).run();
  return row.account_id;
}

export async function dashboard(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env, true);
  if (!session || !env.ACCOUNTS) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname)}` } });
  const db = env.ACCOUNTS;
  const notices = await db.prepare("SELECT kind, tendril_id, reason, created_at FROM account_notices WHERE account_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(session.accountId).all<{ kind: string; tendril_id: string | null; reason: string; created_at: number }>();
  const noticeList = `<h2>Notices</h2><ul>${notices.results.map(n => `<li><strong>${escape(n.kind.replaceAll("_", " "))}</strong>${n.tendril_id ? ` · ${escape(n.tendril_id)}` : ""}: ${escape(n.reason)} · ${escape(new Date(n.created_at).toISOString())}</li>`).join("") || "<li>No notices</li>"}</ul>`;
  if (session.suspendedAt) {
    if (req.method !== "GET" || url.pathname !== "/dashboard") return errorResponse(403, "suspended", "Account access is limited to notices and appeals");
    const held = await db.prepare("SELECT id FROM tendrils WHERE owner_account = ? AND state = 'held' ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string }>();
    return servicePage("Account suspended", `<section class="hero"><h1>Your account is suspended</h1><p>Your pages and agent keys are unavailable. You can review notices and submit an appeal.</p></section>
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
    const [keys, tendrils] = await Promise.all([
      db.prepare("SELECT name, created_at, last_used FROM api_keys WHERE account_id = ? ORDER BY created_at").bind(session.accountId).all<{ name: string; created_at: number; last_used: number | null }>(),
      db.prepare("SELECT id, lifetime, state, created_at FROM tendrils WHERE owner_account = ? ORDER BY created_at DESC").bind(session.accountId).all<{ id: string; lifetime: string; state: string; created_at: number }>(),
    ]);
    const cards = await Promise.all(tendrils.results.map(async t => {
      const response = await env.TENDRIL.get(env.TENDRIL.idFromName(t.id)).fetch(new Request("https://tendril.internal/account/summary", { headers: { "x-account-id": session.accountId } }));
      const info = response.ok ? await response.json() as { name: string; page_url: string; version: number; held: boolean; bytes: number; agents: number; guests_waiting: number; last_activity: { ts: number; summary: string } | null } : null;
      return `<article class="card"><span class="eyebrow">${escape(t.lifetime.replace("_", " "))} · ${info?.held ? "Held for review" : escape(t.state)}</span><h3>${escape(info?.name ?? t.id)}</h3><p class="muted">${info?.version ? `Version ${info.version}` : "Agent is preparing the first page"} · ${info ? `${(info.bytes / 1048576).toFixed(1)} MB stored · ${info.agents} agents` : "Details temporarily unavailable"}</p>${info?.last_activity ? `<p><small>Latest: ${escape(info.last_activity.summary)} · ${escape(new Date(info.last_activity.ts).toLocaleString())}</small></p>` : ""}${info?.guests_waiting ? `<p class="notice">${info.guests_waiting} guest ${info.guests_waiting === 1 ? "request" : "requests"} waiting</p>` : ""}<div class="actions">${info?.page_url && !info.held ? `<a class="button" href="${escape(info.page_url)}">Open page</a><button class="secondary" data-copy="${escape(info.page_url)}" type="button">Copy link</button><a href="${escape(info.page_url)}">Manage agents and guests ↗</a>` : ""}<a href="/dashboard/t/${escape(t.id)}">Sensor history</a>${t.state === "held" ? `<a href="/appeal?tendril=${escape(t.id)}">Appeal hold</a>` : ""}</div></article>`;
    }));
    const body = `<section class="hero"><span class="eyebrow">Your workspace</span><h1>Pages made with your agents.</h1><p>Open a page to talk to its agent, share its link, or manage access. You're signed in as ${escape(session.email ?? session.accountId)}.</p></section>${noticeList}<h2>Your pages</h2><div class="grid">${cards.join("") || `<article class="card"><h3>Your first page will appear here</h3><p>Give an agent the <a href="/agent.md">Tendriller guide</a> to create one for you.</p></article>`}</div><section class="card"><h2>Agent keys</h2><p>Keys let an agent create pages for your account. Store each key in your agent's secret storage. You can see a new key only once.</p><div class="grid">${keys.results.map(k => `<div class="card"><strong>${escape(k.name)}</strong><p><small>Last used ${k.last_used ? escape(new Date(k.last_used).toLocaleString()) : "never"}</small></p><button class="secondary" data-revoke="${escape(k.name)}">Revoke key</button></div>`).join("") || "<p>No agent keys yet.</p>"}</div><form id="new-key"><label>Key name<br><input name="name" maxlength="64" placeholder="My agent" required></label><button>Create key</button></form><div id="key-result" class="notice" hidden role="status"><p id="key-message"></p><code id="key-value"></code><p><button id="copy-key" type="button">Copy key</button> <button id="dismiss-key" class="secondary" type="button">Done</button></p></div></section><details><summary>Account settings</summary><p><a href="/dashboard/export">Download account data</a> · <a href="/auth/link/github">Link GitHub</a> · <a href="/auth/link/google">Link Google</a></p><div class="card danger"><h2>Delete account</h2><p>Permanently deletes your keys, pages, and stored files.</p><form method="post" action="/dashboard/delete"><label>Type DELETE <input name="confirm" required></label><button>Delete account</button></form></div></details>`;
    const script = `<script>const result=document.querySelector('#key-result');document.querySelector('#new-key').onsubmit=async e=>{e.preventDefault();const name=new FormData(e.target).get('name');const r=await fetch('/dashboard/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});const d=await r.json();result.hidden=false;document.querySelector('#key-message').textContent=r.ok?'Copy this key now. It will not be shown again.':(d.error?.message||'Could not create key.');document.querySelector('#key-value').textContent=r.ok?d.key:'';document.querySelector('#copy-key').hidden=!r.ok;if(r.ok)e.target.reset()};document.querySelector('#copy-key').onclick=async()=>{await navigator.clipboard.writeText(document.querySelector('#key-value').textContent);document.querySelector('#key-message').textContent='Copied. Store it in your agent’s secret storage.'};document.querySelector('#dismiss-key').onclick=()=>{document.querySelector('#key-value').textContent='';result.hidden=true};document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='Copied!'});document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{if(!confirm('Revoke this key? Its agent will lose account access.'))return;const r=await fetch('/dashboard/keys/'+encodeURIComponent(b.dataset.revoke),{method:'DELETE'});if(r.ok)location.reload()})</script>`;
    return servicePage("Dashboard", body, script);
  }
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid dashboard origin");
  if (url.pathname === "/dashboard/keys" && req.method === "POST") {
    const body = await readJson(req, 4096);
    const name = body.name;
    if (typeof name !== "string" || !/^[A-Za-z0-9 _.@-]{1,64}$/.test(name)) return errorResponse(400, "bad_request", "Key name must be 1–64 plain characters");
    const existing = await db.prepare("SELECT 1 FROM api_keys WHERE account_id = ? AND name = ?").bind(session.accountId, name).first();
    if (existing) return errorResponse(409, "exists", "A key already has this name");
    const token = newKey();
    await db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), name, session.accountId, Date.now()).run();
    return json({ name, key: token }, 201);
  }
  const revoke = /^\/dashboard\/keys\/([A-Za-z0-9_.@%+-]+)$/.exec(url.pathname);
  if (revoke && req.method === "DELETE") {
    await db.prepare("DELETE FROM api_keys WHERE account_id = ? AND name = ?").bind(session.accountId, decodeURIComponent(revoke[1])).run();
    return new Response(null, { status: 204 });
  }
  return errorResponse(404, "not_found");
}
