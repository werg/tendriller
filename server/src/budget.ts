import type { Env } from "./env";
import { errorResponse, json, readJson } from "./http";
import { safeEqual, sha256Hex } from "./ids";

/** Cloudflare generic notification destination. Policy IDs map to hard stop stages. */
export async function budgetWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed");
  const supplied = req.headers.get("cf-webhook-auth") ?? "";
  if (!env.BUDGET_WEBHOOK_SECRET || !supplied ||
    !safeEqual(await sha256Hex(supplied), await sha256Hex(env.BUDGET_WEBHOOK_SECRET))) return errorResponse(403, "forbidden");
  const body = await readJson(req, 8192) as { account_id?: unknown; policy_id?: unknown; alert_correlation_id?: unknown };
  if (body.account_id !== env.CLOUDFLARE_ACCOUNT_ID || typeof body.policy_id !== "string") return errorResponse(400, "bad_request");
  const desired = body.policy_id === env.BUDGET_READ_ONLY_POLICY_ID ? "read_only" :
    body.policy_id === env.BUDGET_PAUSE_POLICY_ID ? "creation_paused" : null;
  if (!desired) return errorResponse(403, "unknown_policy");
  const rank = desired === "read_only" ? 2 : 1;
  await env.ACCOUNTS.prepare(`UPDATE service_state SET mode = CASE
    WHEN mode = 'read_only' OR ? = 2 THEN 'read_only'
    WHEN mode = 'creation_paused' OR ? = 1 THEN 'creation_paused'
    ELSE mode END WHERE id = 1`).bind(rank, rank).run();
  await env.ACCOUNTS.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, 'cloudflare', ?, 'service', ?, ?)")
    .bind(crypto.randomUUID(), desired, String(body.alert_correlation_id ?? body.policy_id).slice(0, 200), Date.now()).run();
  return json({ ok: true, mode: desired });
}
