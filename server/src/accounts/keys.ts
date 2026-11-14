import type { Env } from "../env";
import { errorResponse, json, readJson } from "../http";
import { sha256Hex } from "../ids";
import { publicBase } from "../urls";
import { serviceSession } from "./auth";

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
  const session = await serviceSession(req, env);
  if (!session || !env.ACCOUNTS) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname)}` } });
  const db = env.ACCOUNTS;
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
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Sensor history · Tendriller</title></head><body><main>
      <p><a href="/dashboard">Back to dashboard</a></p><h1>Sensor history for ${escape(id)}</h1>
      <p>Recent page sensor activity reported by connected devices.</p><ul>${data.events.map(e =>
        `<li>${escape(new Date(e.ts).toISOString())} · ${escape(names.get(e.device ?? "") ?? e.device ?? "Unknown device")} · ${escape(e.summary)}</li>`).join("")}</ul>
      </main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" } });
  }
  if (req.method === "GET") {
    const [keys, tendrils] = await Promise.all([
      db.prepare("SELECT name, created_at, last_used FROM api_keys WHERE account_id = ? ORDER BY created_at").bind(session.accountId).all<{ name: string; created_at: number; last_used: number | null }>(),
      db.prepare("SELECT id, lifetime, state, created_at FROM tendrils WHERE owner_account = ? ORDER BY created_at DESC").bind(session.accountId).all<{ id: string; lifetime: string; state: string; created_at: number }>(),
    ]);
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard · Tendriller</title></head><body><main><h1>Your Tendriller account</h1>
      <p>${escape(session.email ?? session.accountId)}</p><h2>Agent keys</h2><ul>${keys.results.map(k => `<li>${escape(k.name)} · last used ${k.last_used ? new Date(k.last_used).toISOString() : "never"} <button data-revoke="${escape(k.name)}">Revoke</button></li>`).join("")}</ul>
      <form id="new-key"><label>Key name <input name="name" maxlength="64" required></label><button>Create key</button></form><pre id="key-result"></pre>
      <h2>Tendrils</h2><ul>${tendrils.results.map(t => `<li>${escape(t.id)} · ${escape(t.lifetime)} · ${escape(t.state)} · <a href="/dashboard/t/${escape(t.id)}">Sensor history</a></li>`).join("")}</ul>
      <p><a href="/dashboard/export">Download account data</a></p>
      <h2>Delete account</h2><p>This permanently deletes your keys, tendrils, and stored files.</p>
      <form method="post" action="/dashboard/delete"><label>Type DELETE <input name="confirm" required></label><button>Delete account</button></form>
      <p><a href="/auth/link/github">Link GitHub</a> · <a href="/auth/link/google">Link Google</a></p>
      <script>document.querySelector('#new-key').onsubmit=async e=>{e.preventDefault();const name=new FormData(e.target).get('name');const r=await fetch('/dashboard/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});document.querySelector('#key-result').textContent=JSON.stringify(await r.json(),null,2);if(r.ok)e.target.reset()};document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{if(!confirm('Revoke this key?'))return;const r=await fetch('/dashboard/keys/'+encodeURIComponent(b.dataset.revoke),{method:'DELETE'});if(r.ok)location.reload()})</script></main></body></html>`;
    return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" } });
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
