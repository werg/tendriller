import type { Env } from "../env";
import { errorResponse, HttpError, readBody } from "../http";
import { parsePageRoute, publicBase } from "../urls";
import { serviceSession } from "../accounts/auth";
import { renderShell } from "../accounts/ui";

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function reportPage(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "GET") {
    if (!env.TURNSTILE_SITE_KEY) return errorResponse(503, "unavailable", "Reporting is not configured");
    const prefill = url.searchParams.get("url") ?? "";
    const html = renderShell({
      title: "Report a page",
      referrer: "no-referrer",
      themeToggle: false,
      head: `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`,
      body: `<section class="card"><span class="eyebrow">Safety</span><h1>Report a Tendriller page</h1>
      <form method="post"><div class="field"><label class="field-label" for="report-url">Page URL</label><input id="report-url" name="url" type="url" required value="${escape(prefill.slice(0, 2048))}"></div>
      <div class="field"><label class="field-label" for="report-reason">Reason</label><textarea id="report-reason" name="reason" required maxlength="2000"></textarea></div>
      <div class="cf-turnstile" data-sitekey="${escape(env.TURNSTILE_SITE_KEY)}" data-action="report"></div>
      <div class="actions"><button>Send report</button></div></form></section>`,
    });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
  }
  if (req.method !== "POST") return errorResponse(405, "method_not_allowed");
  if (req.headers.get("Origin") !== new URL(publicBase(env)).origin) return errorResponse(403, "bad_origin");
  if (!env.TURNSTILE_SECRET_KEY) return errorResponse(503, "unavailable", "Reporting is not configured");
  if (env.REPORT_RATE && !(await env.REPORT_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
    throw new HttpError(429, "rate_limited", "Too many reports");
  }
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 8192)));
  const reason = form.get("reason")?.trim() ?? "";
  const token = form.get("cf-turnstile-response") ?? "";
  if (!reason || reason.length > 2000 || !token || token.length > 2048) return errorResponse(400, "bad_request", "A reason and verification are required");
  let reported: URL;
  try { reported = new URL(form.get("url") ?? ""); }
  catch { return errorResponse(400, "bad_request", "Invalid page URL"); }
  const page = parsePageRoute(reported, env);
  if (reported.protocol !== "https:" || !page) {
    return errorResponse(400, "bad_request", "Use a Tendriller page URL");
  }
  const verified = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token,
      remoteip: req.headers.get("CF-Connecting-IP") ?? "", idempotency_key: crypto.randomUUID() }) });
  if (!verified.ok) throw new HttpError(502, "verification_failed", "Verification service unavailable");
  const verdict = await verified.json() as { success?: boolean; hostname?: string; action?: string };
  if (!verdict.success || verdict.hostname !== new URL(publicBase(env)).hostname || verdict.action !== "report") {
    return errorResponse(403, "verification_failed", "Verification failed");
  }
  const session = await serviceSession(req, env);
  const stub = env.TENDRIL.get(env.TENDRIL.idFromName(page.id));
  const record = await stub.fetch(new Request("https://tendril.internal/abuse/report", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "external", account_id: session?.accountId ?? null, reason }) }));
  if (!record.ok) return record;
  return new Response("Report received. Thank you.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
