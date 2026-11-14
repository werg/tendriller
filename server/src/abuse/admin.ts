import type { Env } from "../env";
import { serviceSession } from "../accounts/auth";
import { errorResponse, HttpError, readBody } from "../http";
import { TENDRIL_ID_RE } from "../ids";
import { publicBase } from "../urls";
import { accountSuspendedNotice, ownerNotice } from "./notices";
import ipaddr from "ipaddr.js";

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (body: string, status = 200) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Tendriller</title></head><body><main>${body}</main></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
const form = async (req: Request) => new URLSearchParams(new TextDecoder().decode(await readBody(req, 8192)));

export async function appealPage(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env, true);
  const id = url.searchParams.get("tendril") ?? "";
  if (url.pathname === "/appeal/account") {
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth?return_to=%2Fappeal%2Faccount" } });
    if (!session.suspendedAt) return errorResponse(409, "not_suspended", "Account is not suspended");
    if (req.method === "GET") return page(`<h1>Appeal account suspension</h1><p><a href="/dashboard">Back to dashboard</a></p><form method="post"><label>Why should this suspension be reviewed? <textarea name="reason" required maxlength="2000"></textarea></label><button>Submit appeal</button></form>`);
    if (req.method !== "POST") return errorResponse(405, "method_not_allowed");
    if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin");
    const reason = (await form(req)).get("reason")?.trim() ?? "";
    if (!reason || reason.length > 2000) return errorResponse(400, "bad_request", "Reason must be 1–2000 characters");
    const existing = await env.ACCOUNTS.prepare("SELECT 1 FROM account_appeals WHERE account_id = ? AND resolved_at IS NULL")
      .bind(session.accountId).first();
    if (!existing) await env.ACCOUNTS.prepare("INSERT INTO account_appeals (id, account_id, reason, created_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), session.accountId, reason, Date.now()).run();
    return page("<h1>Appeal received</h1><p>Your account remains suspended while the appeal is reviewed.</p><p><a href=\"/dashboard\">Back to dashboard</a></p>");
  }
  if (!TENDRIL_ID_RE.test(id)) return errorResponse(400, "bad_request", "Invalid tendril id");
  const accountId = session?.accountId;
  if (!accountId) return new Response(null, { status: 302, headers: { Location: `/auth?return_to=${encodeURIComponent(url.pathname + url.search)}` } });
  const owned = await env.ACCOUNTS.prepare("SELECT state FROM tendrils WHERE id = ? AND owner_account = ?")
    .bind(id, accountId).first<{ state: string }>();
  if (!owned) return errorResponse(404, "not_found");
  if (req.method === "GET") return page(`<h1>Appeal a hold</h1><p>Tendril ${escape(id)} is ${escape(owned.state)}.</p>
    <form method="post"><textarea name="reason" required maxlength="2000"></textarea><button>Submit appeal</button></form>`);
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed");
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin");
  if (owned.state !== "held") return errorResponse(409, "not_held", "This tendril is not held");
  const reason = (await form(req)).get("reason")?.trim() ?? "";
  if (!reason || reason.length > 2000) return errorResponse(400, "bad_request", "Reason must be 1–2000 characters");
  const existing = await env.ACCOUNTS.prepare("SELECT 1 FROM appeals WHERE tendril_id = ? AND account_id = ? AND resolved_at IS NULL")
    .bind(id, accountId).first();
  if (!existing) await env.ACCOUNTS.prepare("INSERT INTO appeals (id, tendril_id, account_id, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), id, accountId, reason, Date.now()).run();
  return page("<h1>Appeal received</h1><p>Your page remains held while the appeal is reviewed.</p>");
}

async function adminAccount(req: Request, env: Env): Promise<string | null> {
  const session = await serviceSession(req, env);
  if (!session) return null;
  const allow = new Set((env.ADMIN_IDENTITIES ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (!allow.size) return null;
  const identities = await env.ACCOUNTS.prepare("SELECT provider, subject FROM identities WHERE account_id = ?")
    .bind(session.accountId).all<{ provider: string; subject: string }>();
  return identities.results.some(i => allow.has(`${i.provider}:${i.subject}`)) ? session.accountId : null;
}

async function setDisabled(env: Env, id: string, disabled: boolean): Promise<void> {
  const stub = env.TENDRIL.get(env.TENDRIL.idFromName(id));
  const res = await stub.fetch(new Request("https://tendril.internal/abuse/state", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled }) }));
  if (!res.ok) throw new HttpError(502, "state_failed", "Could not update tendril state");
}

export async function adminPage(req: Request, env: Env, url: URL): Promise<Response> {
  const actor = await adminAccount(req, env);
  if (!actor) return errorResponse(404, "not_found");
  const detail = /^\/admin\/t\/([a-z2-7]{12})$/.exec(url.pathname);
  if (detail && req.method === "GET") {
    const id = detail[1];
    const index = await env.ACCOUNTS.prepare("SELECT owner_account, state, created_at FROM tendrils WHERE id = ?")
      .bind(id).first<{ owner_account: string | null; state: string; created_at: number }>();
    if (!index) return errorResponse(404, "not_found");
    const stub = env.TENDRIL.get(env.TENDRIL.idFromName(id));
    const preview = await stub.fetch("https://tendril.internal/abuse/preview");
    if (!preview.ok) return errorResponse(502, "preview_failed");
    const data = await preview.json() as { name: string; versions: { version: number; status: string; risk_score: number; risk_flags: string }[];
      files: { version: number; path: string; type: string; size: number }[]; activity: { ts: number; kind: string; summary: string }[] };
    const reports = await env.ACCOUNTS.prepare("SELECT source, reason, created_at FROM reports WHERE tendril_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(id).all<{ source: string; reason: string; created_at: number }>();
    return page(`<p><a href="/admin">Back to queue</a></p><h1>${escape(data.name)}</h1>
      <p>ID ${escape(id)} · ${escape(index.state)} · owner ${escape(index.owner_account ?? "none")}</p>
      <h2>Version screening</h2><ul>${data.versions.map(v => `<li>Version ${v.version}: ${escape(v.status)}, score ${v.risk_score}, flags ${escape(v.risk_flags)}</li>`).join("")}</ul>
      <h2>Static file listing</h2><ul>${data.files.map(f => `<li>Version ${f.version}: ${escape(f.path)} (${escape(f.type)}, ${f.size} bytes)</li>`).join("")}</ul>
      <h2>Reports</h2><ul>${reports.results.map(r => `<li>${escape(r.source)}: ${escape(r.reason)}</li>`).join("")}</ul>
      <h2>Activity</h2><ul>${data.activity.map(a => `<li>${escape(a.kind)}: ${escape(a.summary)}</li>`).join("")}</ul>`);
  }
  if (req.method === "GET") {
    const [held, reports, appeals, accountAppeals] = await Promise.all([
      env.ACCOUNTS.prepare("SELECT id, owner_account, created_at FROM tendrils WHERE state = 'held' ORDER BY created_at DESC LIMIT 100").all<{ id: string; owner_account: string | null; created_at: number }>(),
      env.ACCOUNTS.prepare("SELECT tendril_id, source, reason, created_at FROM reports ORDER BY created_at DESC LIMIT 100").all<{ tendril_id: string; source: string; reason: string; created_at: number }>(),
      env.ACCOUNTS.prepare("SELECT id, tendril_id, account_id, reason, created_at FROM appeals WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100").all<{ id: string; tendril_id: string; account_id: string; reason: string; created_at: number }>(),
      env.ACCOUNTS.prepare("SELECT id, account_id, reason, created_at FROM account_appeals WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100").all<{ id: string; account_id: string; reason: string; created_at: number }>(),
    ]);
    return page(`<h1>Abuse administration</h1><h2>Open account appeals</h2><ul>${accountAppeals.results.map(a => `<li>${escape(a.account_id)}: ${escape(a.reason)}</li>`).join("")}</ul><h2>Open page appeals</h2><ul>${appeals.results.map(a => `<li>${escape(a.tendril_id)}: ${escape(a.reason)}</li>`).join("")}</ul>
      <h2>Held tendrils</h2><ul>${held.results.map(t => `<li><a href="/admin/t/${escape(t.id)}">${escape(t.id)}</a> · owner ${escape(t.owner_account ?? "none")}</li>`).join("")}</ul>
      <h2>Recent reports</h2><ul>${reports.results.map(r => `<li><a href="/admin/t/${escape(r.tendril_id)}">${escape(r.tendril_id)}</a> · ${escape(r.source)} · ${escape(r.reason)}</li>`).join("")}</ul>
      <h2>Action</h2><form method="post" action="/admin/action"><label>Action <select name="action"><option>disable</option><option>restore</option><option>suspend</option><option>unsuspend</option><option>reject_account_appeal</option><option>block_ip</option></select></label>
      <label>Tendril id, account id, or IP <input name="target" required></label><label>Reason <textarea name="reason" required maxlength="2000"></textarea></label><button>Apply action</button></form>`);
  }
  if (req.method !== "POST" || url.pathname !== "/admin/action") return errorResponse(405, "method_not_allowed");
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin");
  const input = await form(req);
  const action = input.get("action") ?? "";
  const target = input.get("target")?.trim() ?? "";
  const reason = input.get("reason")?.trim() ?? "";
  if (!reason || reason.length > 2000 || target.length > 128) return errorResponse(400, "bad_request");
  const db = env.ACCOUNTS;
  const now = Date.now();
  if (action === "disable" || action === "restore") {
    if (!TENDRIL_ID_RE.test(target)) return errorResponse(400, "bad_request", "Invalid tendril id");
    const row = await db.prepare("SELECT state, owner_account FROM tendrils WHERE id = ?").bind(target).first<{ state: string; owner_account: string | null }>();
    if (!row) return errorResponse(404, "not_found");
    await db.batch([
      db.prepare("UPDATE tendrils SET state = ? WHERE id = ?").bind(action === "disable" ? "held" : "active", target),
      db.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), actor, action, target, reason, now),
      ...(action === "restore" ? [
        db.prepare("UPDATE reports SET disqualified = 1 WHERE tendril_id = ?").bind(target),
        db.prepare("UPDATE appeals SET resolved_at = ?, resolution = ? WHERE tendril_id = ? AND resolved_at IS NULL").bind(now, reason, target),
      ] : []),
    ]);
    if (action === "restore" && row.owner_account) {
      const suspended = await db.prepare("SELECT suspended_at FROM accounts WHERE id = ?").bind(row.owner_account)
        .first<{ suspended_at: number | null }>();
      if (suspended?.suspended_at) {
        const remaining = await db.prepare("SELECT COUNT(*) AS n FROM tendrils WHERE owner_account = ? AND state = 'held'")
          .bind(row.owner_account).first<{ n: number }>();
        const automatic = await db.prepare(`SELECT 1 FROM audit_log WHERE action = 'suspend' AND actor = 'automatic'
          AND subject = ? AND created_at = ?`).bind(row.owner_account, suspended.suspended_at).first();
        if (automatic && (remaining?.n ?? 0) < 3) {
          await db.batch([
            db.prepare("UPDATE accounts SET suspended_at = NULL WHERE id = ?").bind(row.owner_account),
            db.prepare("DELETE FROM blocks WHERE kind = 'identity' AND reason = 'automatic suspension' AND value IN (SELECT provider || ':' || subject FROM identities WHERE account_id = ?)").bind(row.owner_account),
            db.prepare("UPDATE account_appeals SET resolved_at = ?, resolution = ? WHERE account_id = ? AND resolved_at IS NULL")
              .bind(now, `Page ${target} restored`, row.owner_account),
            db.prepare("INSERT INTO account_notices (id, account_id, kind, reason, created_at) VALUES (?, ?, 'unsuspended', ?, ?)")
              .bind(crypto.randomUUID(), row.owner_account, `Page ${target} restored`, now),
            db.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, 'unsuspend', ?, ?, ?)")
              .bind(crypto.randomUUID(), actor, row.owner_account, `Appeal restored ${target}`, now),
          ]);
        }
      }
    }
    const stillSuspended = row.owner_account ? (await db.prepare("SELECT suspended_at FROM accounts WHERE id = ?")
      .bind(row.owner_account).first<{ suspended_at: number | null }>())?.suspended_at : null;
    await setDisabled(env, target, action === "disable" || !!stillSuspended);
    if (row.owner_account) await ownerNotice(env, row.owner_account, target, action === "disable" ? "held" : "restored", reason);
  } else if (action === "suspend") {
    const account = await db.prepare("SELECT id, suspended_at FROM accounts WHERE id = ?").bind(target).first<{ id: string; suspended_at: number | null }>();
    if (!account) return errorResponse(404, "not_found");
    await db.batch([
      db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(now, target),
      db.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(target),
      db.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, 'suspend', ?, ?, ?)")
        .bind(crypto.randomUUID(), actor, target, reason, now),
    ]);
    const pages = await db.prepare("SELECT id FROM tendrils WHERE owner_account = ?").bind(target).all<{ id: string }>();
    if (!account.suspended_at) await accountSuspendedNotice(env, target, reason);
    for (const item of pages.results) {
      await setDisabled(env, item.id, true);
    }
  } else if (action === "unsuspend") {
    const account = await db.prepare("SELECT suspended_at FROM accounts WHERE id = ?").bind(target).first<{ suspended_at: number | null }>();
    if (!account) return errorResponse(404, "not_found");
    await db.batch([
      db.prepare("UPDATE accounts SET suspended_at = NULL WHERE id = ?").bind(target),
      db.prepare("DELETE FROM blocks WHERE kind = 'identity' AND reason = 'automatic suspension' AND value IN (SELECT provider || ':' || subject FROM identities WHERE account_id = ?)").bind(target),
      db.prepare("UPDATE account_appeals SET resolved_at = ?, resolution = ? WHERE account_id = ? AND resolved_at IS NULL").bind(now, reason, target),
      db.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, 'unsuspend', ?, ?, ?)")
        .bind(crypto.randomUUID(), actor, target, reason, now),
    ]);
    const pages = await db.prepare("SELECT id, state FROM tendrils WHERE owner_account = ?").bind(target).all<{ id: string; state: string }>();
    for (const item of pages.results) await setDisabled(env, item.id, item.state === "held");
    await db.prepare("INSERT INTO account_notices (id, account_id, kind, reason, created_at) VALUES (?, ?, 'unsuspended', ?, ?)")
      .bind(crypto.randomUUID(), target, reason, now).run();
  } else if (action === "reject_account_appeal") {
    const appeal = await db.prepare("SELECT id FROM account_appeals WHERE account_id = ? AND resolved_at IS NULL").bind(target).first();
    if (!appeal) return errorResponse(404, "not_found", "No open account appeal");
    await db.batch([
      db.prepare("UPDATE account_appeals SET resolved_at = ?, resolution = ? WHERE account_id = ? AND resolved_at IS NULL").bind(now, reason, target),
      db.prepare("INSERT INTO account_notices (id, account_id, kind, reason, created_at) VALUES (?, ?, 'appeal_rejected', ?, ?)")
        .bind(crypto.randomUUID(), target, reason, now),
      db.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, 'reject_account_appeal', ?, ?, ?)")
        .bind(crypto.randomUUID(), actor, target, reason, now),
    ]);
  } else if (action === "block_ip") {
    const cidr = target.includes("/");
    if (cidr ? !ipaddr.isValidCIDR(target) : !ipaddr.isValid(target)) return errorResponse(400, "bad_request", "Invalid IP address or CIDR range");
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO blocks (kind, value, reason) VALUES (?, ?, ?)").bind(cidr ? "cidr" : "ip", target, reason),
      db.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, 'block_ip', ?, ?, ?)")
        .bind(crypto.randomUUID(), actor, target, reason, now),
    ]);
  } else return errorResponse(400, "bad_request", "Unknown action");
  return new Response(null, { status: 303, headers: { Location: "/admin", "Cache-Control": "no-store" } });
}
