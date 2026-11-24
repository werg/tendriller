import type { Env } from "../env";
import { errorResponse, HttpError, isPlainObject, json, readBody, toErrorResponse } from "../http";
import { RESIDENT_LIMIT } from "../limits";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";
import { renderQrSvg } from "../qr";
import { requireWritesOpen } from "../service-state";
import { avatar, icon, servicePage } from "./ui";

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
    const response = await pageFetch(id, "delete", { method: "POST" });
    if (!response.ok) return errorResponse(502, "unavailable", "The page could not be deleted. Try again.");
    return new Response(null, { status: 303, headers: { Location: "/dashboard?deleted=1", "Cache-Control": "no-store" } });
  }
  const shareMatch = /^\/dashboard\/t\/([a-z2-7]{12})\/(invite|agent)$/.exec(url.pathname);
  if (shareMatch && req.method === "POST") {
    try {
      if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) throw new HttpError(403, "bad_origin", "Invalid dashboard origin");
      if (!(req.headers.get("Content-Type") ?? "").startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Expected JSON");
      await requireWritesOpen(env);
      if (!await owned(shareMatch[1])) throw new HttpError(404, "not_found");
      const body = JSON.parse(new TextDecoder().decode(await readBody(req, 4096)) || "{}");
      if (!isPlainObject(body)) throw new HttpError(400, "bad_request");
      const response = await pageFetch(shareMatch[1], shareMatch[2] === "agent" ? "agent-invite" : "invite", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok || shareMatch[2] === "agent") return response;
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
    return servicePage("Page activity", `<a class="back-link" href="/dashboard">← Back to dashboard</a><div class="page-head"><span class="eyebrow">${icon("activity")} Activity</span><h1>Page <code>${escape(id)}</code></h1><p class="lead">Recent publication, access and host lifecycle events.</p></div>
      ${data.events.length ? `<ul class="list">${data.events.map(e => `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${escape(e.summary)}</div><p class="list-item-sub">${escape(e.kind.replaceAll("_", " "))} · <time datetime="${escape(new Date(e.ts).toISOString())}">${escape(new Date(e.ts).toISOString().slice(0, 16).replace("T", " "))} UTC</time></p></div></li>`).join("")}</ul>` : '<p class="empty">No recorded activity yet.</p>'}`);
  }
  if (req.method === "GET") {
    const tendrils = await db.prepare("SELECT id, lifetime, state, created_at FROM tendrils WHERE owner_account = ? ORDER BY created_at DESC")
      .bind(session.accountId).all<{ id: string; lifetime: string; state: string; created_at: number }>();
    const dbMs = performance.now() - started - sessionMs;
    type Summary = { name: string; page_url: string; version: number; held: boolean; bytes: number; agents: number; guests_waiting: number; last_activity: { ts: number; summary: string } | null };
    const summaries = await Promise.all(tendrils.results.map(async t => {
      try {
        const response = await pageFetch(t.id, "summary", { signal: AbortSignal.timeout(3000) });
        if (response.ok) return await response.json() as Summary;
      } catch { /* An unavailable page must not prevent account navigation. */ }
      return null;
    }));
    const relative = (ts: number) => {
      const minutes = Math.round((Date.now() - ts) / 60000);
      if (minutes < 1) return "just now";
      if (minutes < 60) return `${minutes} min ago`;
      if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
      return `${Math.round(minutes / 1440)} d ago`;
    };
    const cards = tendrils.results.map((t, index) => {
      const info = summaries[index];
      const name = info?.name ?? t.id;
      const stateBadge = info?.held || t.state === "held" ? '<span class="badge danger">Held</span>' : t.state === 'active' ? '<span class="badge ok">Active</span>' : `<span class="badge">${escape(t.state)}</span>`;
      const meta = info ? `<span>${icon("layers")} ${info.version ? `v${info.version}` : "Not published"}</span><span>${icon("bot")} ${info.agents} ${info.agents === 1 ? "agent" : "agents"}</span><span>${icon("database")} ${(info.bytes / 1048576).toFixed(1)} MB</span><span>${icon("clock")} ${t.lifetime === "resident" ? "Resident" : "Temporary"}</span>` : `<span>Details unavailable right now</span>`;
      const openable = info?.page_url && !info.held;
      return `<article class="card interactive page-card"><div class="page-card-top">${avatar(name, t.id)}<div><h3>${escape(name)}</h3><div class="page-meta">${meta}</div></div>${stateBadge}</div>${info?.last_activity ? `<p class="activity">${escape(info.last_activity.summary)} · <span title="${escape(new Date(info.last_activity.ts).toISOString())}">${relative(info.last_activity.ts)}</span></p>` : ""}${info?.guests_waiting ? `<p class="notice warn" style="margin:0">${icon("users")}<span>${info.guests_waiting} guest ${info.guests_waiting === 1 ? "request" : "requests"} waiting · <a href="${escape(info.page_url)}_tendril/manage">Review</a></span></p>` : ""}<div class="actions">${openable ? `<a class="button sm" href="${escape(info!.page_url)}">${icon("external")} Open</a><button class="secondary sm" type="button" data-add="${escape(t.id)}" data-name="${escape(name)}" data-url="${escape(info!.page_url)}">${icon("user-plus")} Add people &amp; devices</button><button class="ghost sm icon-button" data-copy="${escape(info!.page_url)}" type="button" title="Copy page link" aria-label="Copy link to ${escape(name)}">${icon("copy")}</button><a class="button ghost sm icon-button" href="${escape(info!.page_url)}_tendril/manage" title="Page settings" aria-label="Settings for ${escape(name)}">${icon("settings")}</a>` : ""}<a class="button ghost sm icon-button" href="/dashboard/t/${escape(t.id)}" title="Activity" aria-label="Activity for ${escape(name)}">${icon("activity")}</a>${t.state === "held" ? `<a class="button sm danger" href="/appeal?tendril=${escape(t.id)}">Appeal hold</a>` : ""}<button class="ghost sm icon-button" type="button" data-delete="${escape(t.id)}" data-name="${escape(name)}" data-resident="${t.lifetime === "resident" ? "1" : ""}" title="Delete page" aria-label="Delete ${escape(name)}">${icon("trash")}</button></div></article>`;
    });
    const residents = tendrils.results.filter(t => t.lifetime === "resident" && t.state === "active").length;
    const totals = summaries.reduce((acc, info) => ({ agents: acc.agents + (info?.agents ?? 0), guests: acc.guests + (info?.guests_waiting ?? 0), published: acc.published + (info?.version ? 1 : 0) }), { agents: 0, guests: 0, published: 0 });
    const origin = publicBase(env);
    const who = session.email ?? session.accountId;
    const firstName = session.email ? session.email.split("@")[0]!.split(/[._+-]/)[0]! : "";
    const greeting = firstName ? `Welcome back, ${escape(firstName.charAt(0).toUpperCase() + firstName.slice(1))}` : "Welcome back";
    const buildPrompt = `Build me an app with Tendriller at ${origin}. Start by reading ${origin}/agent.md and follow it end to end. I will sign in as ${session.email ?? "my GitHub or Google account"}.\n\nWhat I want: `;
    const scopeChecks = [
      ["host:read", "Read host status", true], ["participants:connect", "Connect enrolled participants", true],
      ["control:write", "Update signed application control", false], ["publication:write", "Publish signed code", false], ["assistant:manage", "Propose assistant access", false],
    ].map(([value, label, on]) => `<label class="check-item"><input type="checkbox" name="scopes" value="${value}"${on ? " checked" : ""}><span class="check-copy"><span class="check-title">${label}</span><span class="check-desc"><code>${value}</code></span></span></label>`).join("");
    const dialog = `<dialog class="sheet" id="add-dialog" aria-labelledby="add-title">
      <div class="sheet-head"><div><span class="eyebrow">${icon("sparkles")} Add people &amp; devices</span><h2 id="add-title">…</h2><p>Open it on another device, invite a person, or connect another agent.</p></div><button class="ghost sm icon-button" type="button" data-close aria-label="Close">${icon("x")}</button></div>
      <div class="sheet-body"><div class="tabs">
        <input class="tab-input" type="radio" name="add-tab" id="tab-device" checked><input class="tab-input" type="radio" name="add-tab" id="tab-person"><input class="tab-input" type="radio" name="add-tab" id="tab-agent">
        <div class="tab-list"><label for="tab-device">${icon("phone")} My device</label><label for="tab-person">${icon("user-plus")} A person</label><label for="tab-agent">${icon("bot")} An agent</label></div>
        <div class="tab-panels">
          <div class="tab-panel"><div class="split"><div><h3>Open on your phone or another computer</h3><ol class="steps"><li>Scan the code with the other device’s camera, or send it the link.</li><li>Sign in with the same account (${escape(who)}).</li><li>Your app may ask you to enroll the new device.</li></ol><div class="copy-box"><label class="field-label" for="device-link">Your page link (keep it private)</label><div class="copy-line"><input id="device-link" type="text" readonly><button class="secondary sm" type="button" data-copy-from="device-link">${icon("copy")} Copy</button></div></div></div><div class="qr-frame"><img id="device-qr" alt="QR code for your page link" width="176" height="176"><span>Scan with your other device</span></div></div></div>
          <div class="tab-panel"><h3>Invite someone to join</h3><p class="muted" style="font-size:.9rem">They sign in with GitHub or Google. Lock the invite to their email for extra safety.</p>
            <form id="person-form"><div class="field-row"><div class="field"><label class="field-label" for="person-email">Their email (optional)</label><input id="person-email" name="email" type="email" maxlength="254" placeholder="Anyone with the link"></div><div class="field"><label class="field-label" for="person-label">Label (optional)</label><input id="person-label" name="label" maxlength="100" placeholder="e.g. Alex"></div></div>
            <div class="field-row"><div class="field"><label class="field-label" for="person-role">Access</label><select id="person-role" name="role"><option value="guest">Guest — signs in and joins</option><option value="display">Page-only — page files, no sign-in</option></select></div><div class="field"><label class="field-label" for="person-expiry">Expires</label><select id="person-expiry" name="expires_in"><option value="604800">In 7 days</option><option value="86400">In 24 hours</option><option value="2592000">In 30 days</option><option value="">Never</option></select></div></div>
            <div class="actions"><button type="submit">${icon("link")} Create invite link</button></div><p class="fine" role="status" data-status></p></form>
            <div class="result" id="person-result" hidden><h3>${icon("check")} Invite link ready</h3><div class="split"><div class="stack-sm"><div class="copy-box"><label class="field-label" for="person-link">Invite link</label><div class="copy-line"><input id="person-link" type="text" readonly><button class="secondary sm" type="button" data-copy-from="person-link">${icon("copy")} Copy</button></div></div><button class="secondary sm" type="button" id="person-share" hidden>${icon("share")} Share…</button></div><div class="qr-frame" id="person-qr"></div></div></div></div>
          <div class="tab-panel"><h3>Connect another agent</h3><p class="muted" style="font-size:.9rem">Creates a paste-ready invitation with a one-time code (valid 10 minutes). Existing agents keep their access.</p>
            <form id="agent-form"><div class="field"><label class="field-label" for="agent-name">Agent name</label><input id="agent-name" name="name" required maxlength="64" placeholder="e.g. reviewer or mobile-sync" autocomplete="off"><span class="field-hint">Letters, numbers, dots, dashes and underscores.</span></div>
            <details class="disclosure"><summary>Host permissions</summary><div class="disclosure-body"><div class="check-list">${scopeChecks}</div></div></details>
            <div class="actions"><button type="submit">${icon("bot")} Create agent invitation</button></div><p class="fine" role="status" data-status></p></form>
            <div class="result" id="agent-result" hidden><h3>${icon("check")} Paste this to the other agent</h3><div class="stack-sm"><div class="copy-box"><label class="field-label" for="agent-blurb">Full invitation (includes the one-time code)</label><textarea id="agent-blurb" class="blurb-full" readonly rows="13"></textarea><div class="cluster"><button class="sm" type="button" data-copy-from="agent-blurb">${icon("copy")} Copy invitation</button><button class="secondary sm" type="button" data-copy-from="agent-link">${icon("link")} Copy as short link message</button></div></div><input id="agent-link" type="hidden"><p class="fine">Single use. If the agent loses the reply, create a new invitation.</p></div></div></div>
        </div></div></div>
    </dialog>`;
    const empty = `<article class="card" style="grid-column:1/-1;text-align:center;padding:2.5rem 1.5rem"><div class="way-icon" style="display:inline-grid;place-items:center;width:3.2rem;height:3.2rem;border-radius:14px;background:var(--accent-soft);color:var(--accent-text);font-size:1.5rem;margin-bottom:.8rem">${icon("sparkles")}</div><h2>Start with something useful</h2><p class="muted" style="margin:0 auto 1rem">Tell your agent what you want to build. Your first page will appear here.</p><div class="actions" style="justify-content:center"><button type="button" data-copy-from="build-prompt">${icon("copy")} Copy a starter prompt</button><a class="button secondary" href="https://cookbooks.tendriller.dev/">Explore cookbooks</a><a class="button ghost" href="/agent.md">Agent guide</a></div></article>`;
    const body = `<section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("sparkles")} Workspace</span><h1>${greeting}</h1><p class="lead">Signed in as ${escape(who)}.</p></div><div class="actions tight"><a class="button secondary sm" href="/connections">${icon("key")} Assistants</a><a class="button secondary sm" href="/dashboard/setups">${icon("inbox")} Setups</a><form class="inline-form" method="post" action="/auth/logout"><button class="secondary sm" type="submit">${icon("logout")} Sign out</button></form></div></div>
      <div class="stats"><div class="stat"><strong>${tendrils.results.length}</strong><span>${tendrils.results.length === 1 ? "page" : "pages"}</span></div><div class="stat"><strong>${residents}<small style="font-size:.9rem;color:var(--hero-muted)"> / ${RESIDENT_LIMIT}</small></strong><span>resident pages</span></div><div class="stat"><strong>${totals.agents}</strong><span>connected agents</span></div><div class="stat"><strong>${totals.guests}</strong><span>guest requests</span></div></div></section>
      ${url.searchParams.get("deleted") === "1" ? `<p class="notice" role="status">${icon("check")}<span>Page deleted. Its files, links and agent access were removed.</span></p>` : ""}
      ${residents >= RESIDENT_LIMIT ? `<p class="notice warn">${icon("layers")}<span>You have reached ${RESIDENT_LIMIT} resident pages. Delete one you no longer need before an agent can make another page resident.</span></p>` : ""}
      ${noticeList}
      <section class="card" aria-labelledby="new-title"><div class="card-head"><div><span class="eyebrow">${icon("bot")} Bring in an agent</span><h2 id="new-title">Build a new page with any agent</h2><p>Paste this into Claude, ChatGPT, Codex or another coding agent, then describe what you want.</p></div></div><div class="copy-box"><textarea id="build-prompt" readonly rows="4" style="min-height:6.5rem">${escape(buildPrompt)}</textarea><div class="cluster"><button class="sm" type="button" data-copy-from="build-prompt">${icon("copy")} Copy prompt</button><a class="button ghost sm" href="/docs/BUILD_AN_APP.md">${icon("book")} Read the guide</a></div></div><p class="fine" style="margin-top:.75rem">To connect an extra agent to an <em>existing</em> page, use <strong>Add people &amp; devices → An agent</strong> on that page.</p></section>
      <div class="section-title"><h2>Your pages</h2><span class="badge">${tendrils.results.length}</span><span class="rule"></span></div>
      <div class="grid">${cards.join("") || empty}</div>
      <details class="disclosure"><summary>Account settings</summary><div class="disclosure-body stack"><div class="actions tight"><a class="button secondary sm" href="/dashboard/export">Download account data</a><a class="button secondary sm" href="/auth/link/github">Link GitHub</a><a class="button secondary sm" href="/auth/link/google">Link Google</a><a class="button secondary sm" href="/oauth/connections">OAuth clients</a></div><div class="card danger"><h3>Delete account</h3><p class="muted" style="font-size:.88rem">Permanently deletes your pages and stored files.</p><form method="post" action="/dashboard/delete"><div class="field"><label class="field-label" for="delete-confirm">Type DELETE to confirm</label><input id="delete-confirm" name="confirm" required></div><div class="actions"><button class="danger sm">Delete account</button></div></form></div></div></details>
      ${dialog}
      <dialog class="sheet" id="delete-dialog" aria-labelledby="delete-title" style="width:min(30rem,calc(100vw - 1.5rem))"><form method="post" id="delete-form"><div class="sheet-head"><div><span class="eyebrow" style="color:var(--danger)">${icon("trash")} Delete page</span><h2 id="delete-title">…</h2></div><button class="ghost sm icon-button" type="button" data-close aria-label="Close">${icon("x")}</button></div><div class="sheet-body"><p>This permanently deletes the page, its published files, invite links and agent credentials. People and devices lose access immediately. This cannot be undone.</p><p class="fine" id="delete-resident" hidden>This frees one of your ${RESIDENT_LIMIT} resident page slots.</p><input type="hidden" name="confirm" id="delete-confirm-id"><div class="actions"><button class="danger" type="submit">${icon("trash")} Delete permanently</button><button class="secondary" type="button" data-close>Cancel</button></div></div></form></dialog>`;
    const script = `<script>(()=>{
const $=id=>document.getElementById(id),dialog=$('add-dialog');let current=null,opener=null;
const flash=(b,t)=>{const old=b.innerHTML;b.textContent=t;b.disabled=true;setTimeout(()=>{b.innerHTML=old;b.disabled=false},1600)};
const copy=async(text,b)=>{try{await navigator.clipboard.writeText(text);flash(b,'Copied!')}catch{const f=b.closest('.copy-box')?.querySelector('textarea,input:not([type=hidden])');if(f){f.focus();f.select()}flash(b,'Press Ctrl+C')}};
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.copy)copy(b.dataset.copy,b);
 else if(b.dataset.copyFrom){const f=$(b.dataset.copyFrom);copy(f.value,b)}
 else if(b.dataset.add){opener=b;current=b.dataset.add;$('add-title').textContent=b.dataset.name;$('device-link').value=b.dataset.url;$('device-qr').src='/dashboard/t/'+current+'/qr.svg';
  $('person-result').hidden=$('agent-result').hidden=true;dialog.querySelectorAll('[data-status]').forEach(s=>s.textContent='');$('tab-device').checked=true;dialog.showModal()}
 else if(b.dataset.delete){opener=b;const d=$('delete-dialog');$('delete-title').textContent='Delete “'+b.dataset.name+'”?';$('delete-confirm-id').value=b.dataset.delete;$('delete-form').action='/dashboard/t/'+b.dataset.delete+'/delete';$('delete-resident').hidden=!b.dataset.resident;d.showModal()}
 else if(b.hasAttribute('data-close'))b.closest('dialog').close()});
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
$('agent-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,scopes=[...f.querySelectorAll('input[name=scopes]:checked')].map(i=>i.value);
 const invite=await post(f,'agent',{name:$('agent-name').value.trim(),scopes});if(!invite)return;$('agent-blurb').value=invite.blurb;$('agent-link').value=invite.link_blurb;$('agent-result').hidden=false;$('agent-name').value='';$('agent-blurb').focus();$('agent-blurb').select()});
})()</script>`;
    const response = servicePage("Dashboard", body, script, 200, { wide: true });
    response.headers.set("Server-Timing", `session;dur=${sessionMs.toFixed(1)}, account-db;dur=${dbMs.toFixed(1)}, page-summaries;dur=${(performance.now() - started - sessionMs - dbMs).toFixed(1)}, total;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  }
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin", "Invalid dashboard origin");
  return errorResponse(404, "not_found");
}
