/**
 * Public `/pricing`, `/self-host`, authenticated `/dashboard/billing*`, and `/api/webhooks/polar` routes.
 * Renders cleanly on desktop and 320px phone widths using Tendriller's shared `servicePage` shell.
 */
import type { Env } from "../env";
import { errorResponse, HttpError, json, readBody, toErrorResponse } from "../http";
import { publicBase } from "../urls";
import { serviceSession } from "../accounts/auth";
import { icon, servicePage } from "../accounts/ui";
import { requireWritesOpen } from "../service-state";
import {
  billingConfigured,
  DEFAULT_PAYG_SPEND_CAP_CENTS,
  getAccountEntitlements,
} from "./entitlements";
import {
  createPolarCheckout,
  createPolarCustomerSession,
  processPolarWebhook,
} from "./polar";
import { GB, PLANS, planSpec, type BillingInterval } from "./plans";

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}

function sameOrigin(req: Request, env: Env): void {
  const expected = new URL(publicBase(env)).origin;
  if (req.headers.get("Origin") !== expected) {
    throw new HttpError(403, "bad_origin", "Invalid request origin.");
  }
}

function fmtBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function fmtHours(ms: number): string {
  const hrs = ms / 3_600_000;
  return hrs >= 10 ? `${Math.round(hrs)} h` : `${hrs.toFixed(1)} h`;
}

function fmtDollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function meterRow(label: string, usedLabel: string, capLabel: string, ratio: number | null, hint?: string): string {
  const pct = ratio === null ? 0 : Math.min(100, Math.round(ratio * 100));
  const tone = ratio !== null && ratio >= 1 ? "danger" : ratio !== null && ratio >= 0.8 ? "warn" : "ok";
  const barColor = tone === "danger" ? "var(--danger)" : tone === "warn" ? "#d97706" : "var(--accent)";
  return `<div class="list-item" style="flex-direction:column;align-items:stretch;gap:.45rem">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;flex-wrap:wrap">
      <strong style="font-size:.94rem">${escape(label)}</strong>
      <span style="font-size:.86rem;color:var(--muted)"><strong>${escape(usedLabel)}</strong> / ${escape(capLabel)}${ratio !== null && ratio >= 0.8 ? ` <span class="badge ${tone}">${pct}%</span>` : ""}</span>
    </div>
    ${ratio !== null ? `<div style="height:.45rem;border-radius:999px;background:var(--line);overflow:hidden" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${escape(label)}"><div style="height:100%;width:${pct}%;background:${barColor};border-radius:999px"></div></div>` : ""}
    ${hint ? `<span class="fine">${hint}</span>` : ""}
  </div>`;
}

/** Public `/pricing` page comparing Free, Pro, Team, and Self-Hosted transparently. */
export async function pricingPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "method_not_allowed");
  const session = env.ACCOUNTS ? await serviceSession(req, env).catch(() => null) : null;
  const ent = session ? await getAccountEntitlements(env, session.accountId).catch(() => null) : null;
  const checkoutLive = Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCTS_JSON);

  const planAction = (planId: "pro" | "team", label: string, primary: boolean) => {
    if (ent?.plan === planId) {
      return `<a class="button secondary" href="/dashboard/billing">Current plan · Manage</a>`;
    }
    if (!session) {
      return `<a class="button${primary ? "" : " secondary"}" href="/auth?return_to=${encodeURIComponent("/dashboard/billing")}">${escape(label)}</a>`;
    }
    if (!checkoutLive) {
      return `<a class="button${primary ? "" : " secondary"}" href="/dashboard/billing">${escape(label)}</a>`;
    }
    return `<form method="post" action="/dashboard/billing/checkout" style="display:flex;gap:.5rem;flex-wrap:wrap">
      <input type="hidden" name="plan" value="${planId}">
      <input type="hidden" name="interval" value="month" data-billing-interval>
      <button type="submit" class="${primary ? "" : "secondary"}">${escape(label)}</button>
    </form>`;
  };

  const body = `<section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("sparkles")} Simple, local-first pricing</span><h1>Pay for cloud media &amp; scale, never for your own data.</h1><p class="lead">Direct peer-to-peer sync stays free and unlimited. Upgrade when you want multi-party SFU video, TURN across strict firewalls, heavy hosted MCP, or a larger fleet — or self-host on your own Cloudflare account anytime.</p></div></div>
    <div class="actions" style="margin-top:1rem" role="group" aria-label="Billing interval">
      <button type="button" class="sm" id="interval-month" aria-pressed="true">Monthly</button>
      <button type="button" class="secondary sm" id="interval-year" aria-pressed="false">Annual <span class="badge ok" style="margin-left:.3rem">Save ~30%</span></button>
      <a class="button ghost sm" href="/self-host" style="color:#f5d590">${icon("terminal")} Self-host on Cloudflare</a>
    </div></section>

  <section class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));align-items:stretch" aria-label="Plans">
    <article class="card stack-sm" style="justify-content:space-between">
      <div class="stack-sm">
        <div class="card-head"><div><span class="eyebrow">Hobby</span><h2>Free</h2></div><span class="badge">$0</span></div>
        <p class="muted" style="font-size:.9rem">${escape(PLANS.free.tagline)}</p>
        <ul class="list" style="font-size:.88rem">
          <li class="list-item"><strong>20</strong> active pages · <strong>5</strong> resident pages</li>
          <li class="list-item"><strong>200 MB</strong> asset storage (25 MB/page) · 5 retained versions</li>
          <li class="list-item"><strong>5</strong> workspace agents · <strong>5</strong> guests/page</li>
          <li class="list-item"><strong>Unlimited</strong> direct P2P WebRTC &amp; local <code>tendril agent run</code></li>
          <li class="list-item"><strong>2 GB/mo</strong> TURN NAT trial + 5 hrs/mo light relay fallback</li>
          <li class="list-item">Hosted MCP: <strong>1</strong> page · <strong>250</strong> calls/mo · 20 MB sync store</li>
        </ul>
      </div>
      <div class="actions">${session ? `<a class="button secondary" href="/dashboard">Open dashboard</a>` : `<a class="button secondary" href="/auth">Get started free</a>`}</div>
    </article>

    <article class="card stack-sm" style="justify-content:space-between;border-color:var(--accent)">
      <div class="stack-sm">
        <div class="card-head"><div><span class="eyebrow" style="color:var(--accent-text)">Recommended</span><h2>Pro</h2></div><span class="badge ok" data-price-pro>$12 / mo</span></div>
        <p class="muted" style="font-size:.9rem">${escape(PLANS.pro.tagline)}</p>
        <ul class="list" style="font-size:.88rem">
          <li class="list-item"><strong>100</strong> active pages · <strong>25</strong> resident pages</li>
          <li class="list-item"><strong>2 GB</strong> asset storage (50 MB/page) · 25 retained versions</li>
          <li class="list-item"><strong>15</strong> workspace agents · <strong>25</strong> guests/page</li>
          <li class="list-item"><strong>SFU Video &amp; TURN:</strong> <strong>100 GB/mo</strong> (~15–25 hrs 4-way 720p, up to 12 peers)</li>
          <li class="list-item"><strong>Priority Relay:</strong> 16 concurrent · 50 active hrs/mo · 2 hr sessions</li>
          <li class="list-item"><strong>Hosted MCP:</strong> <strong>25</strong> pages · <strong>15,000</strong> calls/mo · 250 MB/page</li>
          <li class="list-item"><strong>Host-brokered personal OAuth:</strong> wrapped connections that work even when your laptop sleeps</li>
          <li class="list-item"><strong>Opt-in PAYG:</strong> $0.10/GB media · $2/10k MCP calls (with spend cap)</li>
        </ul>
      </div>
      <div class="actions">${planAction("pro", "Upgrade to Pro", true)}</div>
    </article>

    <article class="card stack-sm" style="justify-content:space-between">
      <div class="stack-sm">
        <div class="card-head"><div><span class="eyebrow">Studio &amp; Orgs</span><h2>Team</h2></div><span class="badge" data-price-team>$39 / mo</span></div>
        <p class="muted" style="font-size:.9rem">${escape(PLANS.team.tagline)}</p>
        <ul class="list" style="font-size:.88rem">
          <li class="list-item"><strong>500</strong> active pages · <strong>100</strong> resident pages</li>
          <li class="list-item"><strong>20 GB</strong> asset storage (100 MB/page) · 100 retained versions</li>
          <li class="list-item"><strong>50</strong> workspace agents · <strong>100</strong> guests/page</li>
          <li class="list-item"><strong>Heavy SFU &amp; TURN:</strong> <strong>500 GB/mo</strong>, up to 50 peers, 1080p + screen share</li>
          <li class="list-item"><strong>Heavy Relay:</strong> 64 concurrent · 250 active hrs/mo · 4 hr sessions</li>
          <li class="list-item"><strong>Hosted MCP:</strong> <strong>100</strong> pages · <strong>100,000</strong> calls/mo · 1 GB/page</li>
          <li class="list-item"><strong>Team OAuth tie-ins:</strong> GitHub Org/Team &amp; Google Workspace group admission, automatic offboarding &amp; shared page-custody OAuth connections</li>
          <li class="list-item"><strong>Custom page domain</strong> (<code>*.yourteam.com</code>) · PAYG $0.08/GB, $1.50/10k MCP</li>
        </ul>
      </div>
      <div class="actions">${planAction("team", "Upgrade to Team", false)}</div>
    </article>

    <article class="card stack-sm" style="justify-content:space-between">
      <div class="stack-sm">
        <div class="card-head"><div><span class="eyebrow">Open Source</span><h2>Self-Hosted</h2></div><span class="badge ok">$0 OSS</span></div>
        <p class="muted" style="font-size:.9rem">${escape(PLANS.unlimited.tagline)}</p>
        <ul class="list" style="font-size:.88rem">
          <li class="list-item"><strong>Unlimited</strong> pages, residents, agents, guests &amp; hosted MCP</li>
          <li class="list-item">Runs on your own Cloudflare Workers account ($0–$5/mo Paid)</li>
          <li class="list-item">Plug in your own Cloudflare Realtime SFU &amp; TURN keys (1 TB/mo free from CF)</li>
          <li class="list-item">Zero vendor lock-in: export &amp; move workspaces anytime</li>
        </ul>
      </div>
      <div class="actions"><a class="button secondary" href="/self-host">${icon("terminal")} 5-minute self-host guide</a></div>
    </article>
  </section>

  <section class="card stack-sm">
    <h2>Fairness guarantees</h2>
    <ul class="list">
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">What stays free forever</div><p class="list-item-sub">Local offline reads and writes in Chronolog, direct peer-to-peer WebRTC sync, running <code>tendril agent run</code> on your own machine, and exporting your workspaces never require a paid plan.</p></div></li>
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">Hitting a quota never locks or deletes your data</div><p class="list-item-sub">Your local Chronolog state stays readable and editable offline. If you downgrade from Pro to Free, all existing pages stay accessible — you only pause creating new pages above the Free cap.</p></div></li>
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">No surprise overage bills</div><p class="list-item-sub">Pay-as-you-go is off by default. When you opt in, you choose a monthly spend cap (default $25, editable or removable anytime). Payments and global VAT/tax invoices are handled securely by Polar.sh.</p></div></li>
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">Zero lock-in</div><p class="list-item-sub">Prefer to run Tendriller on your own Cloudflare account? <a href="/self-host">Follow the 5-minute self-hosting guide</a> — it uses the exact same open-source engine. <a href="/pricing.md">Read machine-readable pricing (.md)</a>.</p></div></li>
    </ul>
  </section>`;

  const script = `<script>(()=>{
    const m=document.getElementById('interval-month'), y=document.getElementById('interval-year');
    const pro=document.querySelector('[data-price-pro]'), team=document.querySelector('[data-price-team]');
    const inputs=()=>document.querySelectorAll('[data-billing-interval]');
    function set(interval){
      const annual=interval==='year';
      m.className=annual?'secondary sm':'sm'; m.setAttribute('aria-pressed',String(!annual));
      y.className=annual?'sm':'secondary sm'; y.setAttribute('aria-pressed',String(annual));
      if(pro) pro.textContent=annual?'$100 / yr ($8.33/mo)':'$12 / mo';
      if(team) team.textContent=annual?'$320 / yr ($26.67/mo)':'$39 / mo';
      inputs().forEach(el=>el.value=interval);
    }
    m?.addEventListener('click',()=>set('month'));
    y?.addEventListener('click',()=>set('year'));
  })()</script>`;

  const response = servicePage("Pricing", body, script, 200, {
    wide: true,
    formAction: "'self' https://polar.sh https://*.polar.sh",
  });
  return req.method === "HEAD" ? new Response(null, response) : response;
}

/** Public `/self-host` page giving users a friendly, first-class self-hosting off-ramp. */
export async function selfHostPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "method_not_allowed");
  const origin = publicBase(env);
  const body = `<section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("terminal")} Own your infrastructure</span><h1>Run your own Tendriller on Cloudflare in 5 minutes</h1><p class="lead">Tendriller is open-source and runs on a single Cloudflare Worker + D1 + R2 + Durable Objects. When you self-host, every quota defaults to unlimited and you pay Cloudflare directly.</p></div></div>
    <div class="actions" style="margin-top:1rem"><a class="button" href="/docs/SELF_HOSTING.md">${icon("book")} Full self-hosting doc</a><a class="button secondary" href="/pricing">Compare with hosted Pro</a></div></section>

  <section class="card stack-sm">
    <h2>What it costs on your own Cloudflare account</h2>
    <ul class="list">
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">Cloudflare Workers Paid — $5 / month</div><p class="list-item-sub">Recommended for hosted MCP (QuickJS + DoltLite WASM needs &gt;10 ms CPU) and includes 10M Worker reqs, 1M DO reqs, 400k GB-s DO duration, 25B D1/DO reads, 50M writes, and 10 GB R2 storage with zero egress.</p></div></li>
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">Cloudflare Realtime SFU &amp; TURN — 1,000 GB / month free</div><p class="list-item-sub">Plug in your own <code>CF_REALTIME_APP_ID</code>, <code>CF_REALTIME_API_TOKEN</code>, <code>CF_TURN_KEY_ID</code>, and <code>CF_TURN_API_TOKEN</code> Worker secrets. Cloudflare includes 1 TB/mo free egress, then $0.05/GB.</p></div></li>
    </ul>
  </section>

  <section class="card stack-sm">
    <h2>Quickstart (5 minutes)</h2>
    <ol class="steps">
      <li>Clone Tendriller and install dependencies (Node 22.15+):<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--stage);color:#f6f0df;overflow-x:auto;font-size:.82rem">git clone https://github.com/werg/tendriller.git &amp;&amp; cd tendriller
npm ci &amp;&amp; npm run build</pre></li>
      <li>Provision fresh Worker, D1, R2, and domains with the built-in script:<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--stage);color:#f6f0df;overflow-x:auto;font-size:.82rem">PRODUCTION_PUBLIC_BASE=https://app.yourdomain.com \\
PRODUCTION_PAGE_BASE_DOMAIN=pages.yourdomain.com \\
node scripts/provision.mjs production --name my-tendriller --fresh</pre></li>
      <li>Apply D1 migrations and set unlimited caps (<code>NULL</code>):<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--stage);color:#f6f0df;overflow-x:auto;font-size:.82rem">npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc
npx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc \\
  --command "UPDATE service_state SET mode='open', account_page_cap=NULL, account_resident_cap=NULL, account_storage_cap=NULL WHERE id=1"</pre></li>
      <li>Add your secrets (<code>HOST_ATTESTATION_KEY</code>, GitHub/Google OAuth or <code>LOCAL_PASSWORD_HASH</code>, and optional <code>CF_REALTIME_*</code> / <code>CF_TURN_*</code>) and deploy:<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--stage);color:#f6f0df;overflow-x:auto;font-size:.82rem">npx wrangler deploy --config server/wrangler.my-tendriller.jsonc</pre></li>
      <li>Move an existing workspace: export your account data from <a href="/dashboard/export">/dashboard/export</a>, point <code>tendriller.json</code> to your new service origin, and run <code>npm run deploy</code>.</li>
    </ol>
  </section>

  <section class="card stack-sm">
    <h2>Self-host vs. Hosted ${escape(new URL(origin).hostname)} — honest comparison</h2>
    <ul class="list">
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">Choose Self-Hosted when…</div><p class="list-item-sub">You want unlimited quotas on your own Cloudflare account, custom retention policies, private infrastructure compliance, or you already manage Cloudflare zones and OAuth apps.</p></div></li>
      <li class="list-item"><div class="list-item-main"><div class="list-item-title">Choose Hosted Pro ($12/mo) when…</div><p class="list-item-sub">You want instant zero-ops sign-in (GitHub, Google, ChatGPT/Claude MCP OAuth), managed wildcard TLS, automatic signed runtime updates, and instant TURN + SFU video without wiring up Cloudflare billing.</p></div></li>
    </ul>
    <div class="actions"><a class="button" href="/dashboard/billing">Open billing &amp; usage</a><a class="button secondary" href="/dashboard">Back to dashboard</a></div>
  </section>`;

  const response = servicePage("Self-host Tendriller", body, "", 200, { medium: true });
  return req.method === "HEAD" ? new Response(null, response) : response;
}

async function renderBillingDashboard(req: Request, env: Env, url: URL, accountId: string, email: string | null): Promise<Response> {
  const db = env.ACCOUNTS;
  const [ent, pageStats, agentStats, mcpPageStats, storageStats] = await Promise.all([
    getAccountEntitlements(env, accountId),
    db.prepare(`SELECT
      COUNT(*) AS pages,
      SUM(CASE WHEN lifetime = 'resident' THEN 1 ELSE 0 END) AS residents
      FROM tendrils WHERE owner_account = ? AND state = 'active'`).bind(accountId)
      .first<{ pages: number; residents: number | null }>(),
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE account_id = ? AND revoked_at IS NULL")
      .bind(accountId).first<{ n: number }>(),
    db.prepare("SELECT COUNT(DISTINCT page_id) AS n FROM mcp_connections WHERE account_id = ?")
      .bind(accountId).first<{ n: number }>(),
    db.prepare("SELECT reserved FROM accounts WHERE id = ?")
      .bind(accountId).first<{ reserved: number }>(),
  ]);

  const pagesUsed = pageStats?.pages ?? 0;
  const residentsUsed = pageStats?.residents ?? 0;
  const agentsUsed = agentStats?.n ?? 0;
  const mcpPagesUsed = mcpPageStats?.n ?? 0;
  const storageUsed = storageStats?.reserved ?? 0;

  const spec = planSpec(ent.plan);
  const sub = ent.subscription;
  const checkoutLive = Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCTS_JSON);
  const portalLive = Boolean(env.POLAR_ACCESS_TOKEN && (sub?.customerId || sub?.subscriptionId));

  const statusBadge = ent.unlimitedHost
    ? `<span class="badge ok">Self-Hosted · Unlimited</span>`
    : ent.inGracePeriod
      ? `<span class="badge warn">Past due · Grace period until ${escape(new Date(sub!.graceUntil!).toISOString().slice(0, 10))}</span>`
      : sub?.cancelAtPeriodEnd && sub.periodEnd
        ? `<span class="badge warn">Cancels ${escape(new Date(sub.periodEnd).toISOString().slice(0, 10))}</span>`
        : `<span class="badge ok">${escape(spec.name)} plan</span>`;

  const alerts: string[] = [];
  if (url.searchParams.get("checkout") === "success") {
    alerts.push(`<p class="notice" role="status">${icon("check")}<span>Checkout completed! Your updated plan entitlements apply automatically as soon as Polar confirms your subscription.</span></p>`);
  }
  if (url.searchParams.get("saved") === "1") {
    alerts.push(`<p class="notice" role="status">${icon("check")}<span>Pay-as-you-go preferences saved.</span></p>`);
  }
  if (ent.inGracePeriod && sub?.graceUntil) {
    alerts.push(`<p class="notice warn">${icon("shield")}<span>Your last renewal payment failed. Your ${escape(spec.name)} features stay active through <strong>${escape(new Date(sub.graceUntil).toISOString().slice(0, 10))}</strong> so nothing interrupts your work. Update your payment method in the billing portal.</span></p>`);
  }
  if (!ent.unlimitedHost && ((ent.quotas.pages !== null && pagesUsed > ent.quotas.pages) || (ent.quotas.residents !== null && residentsUsed > ent.quotas.residents))) {
    alerts.push(`<p class="notice warn">${icon("layers")}<span>You currently have more existing pages than the ${escape(spec.name)} allowance. <strong>None of your pages or data have been deleted</strong> — existing pages keep working, and you can delete unused pages or resubscribe before creating new ones.</span></p>`);
  }

  const resetDate = ent.usage.resetsAt.slice(0, 10);
  const ratio = (used: number, cap: number | null) => (cap === null || cap === 0 ? null : used / cap);
  const metersHtml = [
    meterRow("Active pages", String(pagesUsed), ent.quotas.pages === null ? "Unlimited" : String(ent.quotas.pages), ratio(pagesUsed, ent.quotas.pages)),
    meterRow("Resident pages", String(residentsUsed), ent.quotas.residents === null ? "Unlimited" : String(ent.quotas.residents), ratio(residentsUsed, ent.quotas.residents)),
    meterRow("Published asset storage (R2)", fmtBytes(storageUsed), ent.quotas.storageBytes === null ? "Unlimited" : fmtBytes(ent.quotas.storageBytes), ratio(storageUsed, ent.quotas.storageBytes)),
    meterRow("Workspace agents", String(agentsUsed), ent.quotas.agents === null ? "Unlimited" : String(ent.quotas.agents), ratio(agentsUsed, ent.quotas.agents)),
    meterRow("Hosted MCP opted-in pages", String(mcpPagesUsed), ent.quotas.mcpPages === null ? "Unlimited" : String(ent.quotas.mcpPages), ratio(mcpPagesUsed, ent.quotas.mcpPages)),
    meterRow("Hosted MCP calls (this month)", ent.usage.mcpCalls.toLocaleString("en-US"), ent.quotas.mcpCallsPerMonth === null ? "Unlimited" : ent.quotas.mcpCallsPerMonth.toLocaleString("en-US"), ratio(ent.usage.mcpCalls, ent.quotas.mcpCallsPerMonth), `Resets ${resetDate} UTC · local <code>tendril agent run</code> is always unlimited.`),
    meterRow("Host relay active time (this month)", fmtHours(ent.usage.relayMs), ent.quotas.relayMsPerMonth === null ? "Unlimited" : fmtHours(ent.quotas.relayMsPerMonth), ratio(ent.usage.relayMs, ent.quotas.relayMsPerMonth), `Resets ${resetDate} UTC · direct P2P WebRTC uses 0 host relay time.`),
    meterRow("SFU & TURN media egress (this month)", fmtBytes(ent.usage.mediaBytes), ent.quotas.mediaBytesPerMonth === null ? "Unlimited" : fmtBytes(ent.quotas.mediaBytesPerMonth), ratio(ent.usage.mediaBytes, ent.quotas.mediaBytesPerMonth), `Resets ${resetDate} UTC · ${ent.quotas.sfuEnabled ? `SFU up to ${ent.quotas.sfuMaxPeers} peers (${ent.quotas.sfuMaxHeight}p)` : "TURN trial only; upgrade for multi-party SFU"}.`),
  ].join("");

  const spendCapDollars = ent.paygSpendCapCents === null ? "" : String(Math.round(ent.paygSpendCapCents / 100));
  const paygCard = ent.unlimitedHost
    ? ""
    : ent.quotas.paygAllowed
      ? `<section class="card stack-sm" id="payg">
          <div class="card-head"><div><span class="eyebrow">Metered overage</span><h2>Pay-as-you-go toggle</h2><p>Stay connected smoothly if you exceed your included ${fmtBytes(ent.quotas.mediaBytesPerMonth ?? 0)} media or ${(ent.quotas.mcpCallsPerMonth ?? 0).toLocaleString("en-US")} hosted MCP calls (${fmtDollars(ent.quotas.paygMediaCentsPerGb)}/GB media · ${fmtDollars(ent.quotas.paygMcpCentsPer10k)}/10k MCP calls).</p></div><span class="badge ${ent.paygEnabled ? "ok" : ""}">${ent.paygEnabled ? "Enabled" : "Off"}</span></div>
          <form method="post" action="/dashboard/billing/payg" class="stack-sm">
            <label class="check-item"><input type="checkbox" name="payg_enabled" value="1"${ent.paygEnabled ? " checked" : ""}><span class="check-copy"><span class="check-title">Enable pay-as-you-go overage</span><span class="check-desc">When off, usage stops cleanly at your included allowance (falling back to P2P/local sync) with zero extra charges.</span></span></label>
            <div class="field-row">
              <div class="field"><label class="field-label" for="spend-cap-usd">Monthly safety spend cap (USD)</label><input id="spend-cap-usd" name="spend_cap_usd" type="number" min="1" max="10000" step="1" value="${escape(spendCapDollars || String(DEFAULT_PAYG_SPEND_CAP_CENTS / 100))}" placeholder="25"${ent.paygSpendCapCents === null ? " disabled" : ""}></div>
              <div class="field" style="justify-content:flex-end"><label class="check-item" style="margin-top:1.35rem"><input type="checkbox" id="uncapped-payg" name="uncapped" value="1"${ent.paygSpendCapCents === null ? " checked" : ""}><span class="check-copy"><span class="check-title">No spend cap (uncapped)</span><span class="check-desc">Disable the monthly spend cap completely.</span></span></label></div>
            </div>
            <p class="fine">Estimated accrued overage this month: <strong>${fmtDollars(ent.overage.totalCents)}</strong>${ent.paygSpendCapCents !== null ? ` · current cap ${fmtDollars(ent.paygSpendCapCents)}/mo` : " · uncapped"}.</p>
            <div class="actions"><button type="submit" class="sm">Save overage settings</button></div>
          </form>
        </section>`
      : `<section class="card stack-sm" id="payg">
          <div class="card-head"><div><span class="eyebrow">Metered overage</span><h2>Pay-as-you-go overage</h2><p>Available on Pro ($0.10/GB media · $2/10k MCP calls) and Team ($0.08/GB · $1.50/10k) with an optional monthly spend cap.</p></div><span class="badge">Pro &amp; Team</span></div>
        </section>`;

  const curInterval = sub?.billingInterval ?? "month";
  const isProMonth = ent.plan === "pro" && curInterval === "month";
  const isProYear = ent.plan === "pro" && curInterval === "year";
  const isTeamMonth = ent.plan === "team" && curInterval === "month";
  const isTeamYear = ent.plan === "team" && curInterval === "year";
  const upgradeSection = ent.unlimitedHost ? "" : `<section class="card stack-sm">
    <div class="card-head"><div><span class="eyebrow">Plans</span><h2>Upgrade or switch plan</h2><p>Checkout, invoices, and global tax handling are powered by Polar.sh (Merchant of Record).</p></div><a class="button ghost sm" href="/pricing">Compare all plans</a></div>
    ${checkoutLive ? `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div class="card stack-sm"><h3>Pro — $12/mo or $100/yr</h3><p class="muted" style="font-size:.86rem">100 pages · 25 residents · 100 GB SFU/TURN · 15k MCP calls/mo · host-brokered personal OAuth.</p>
        <div class="actions tight">
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="pro"><input type="hidden" name="interval" value="month"><button type="submit" class="sm"${isProMonth ? " disabled" : ""}>${isProMonth ? "Current (Pro Monthly)" : "Pro Monthly"}</button></form>
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="pro"><input type="hidden" name="interval" value="year"><button type="submit" class="secondary sm"${isProYear ? " disabled" : ""}>${isProYear ? "Current (Pro Annual)" : "Pro Annual ($100)"}</button></form>
        </div>
      </div>
      <div class="card stack-sm"><h3>Team — $39/mo or $320/yr</h3><p class="muted" style="font-size:.86rem">500 pages · 100 residents · 500 GB SFU/TURN · 100k MCP calls/mo · Team OAuth tie-ins · custom domain.</p>
        <div class="actions tight">
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="team"><input type="hidden" name="interval" value="month"><button type="submit" class="sm"${isTeamMonth ? " disabled" : ""}>${isTeamMonth ? "Current (Team Monthly)" : "Team Monthly"}</button></form>
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="team"><input type="hidden" name="interval" value="year"><button type="submit" class="secondary sm"${isTeamYear ? " disabled" : ""}>${isTeamYear ? "Current (Team Annual)" : "Team Annual ($320)"}</button></form>
        </div>
      </div>
    </div>` : `<p class="notice">${icon("sparkles")}<span>Hosted checkout is not yet enabled on this deployment. You can review <a href="/pricing">planned tiers</a> or <a href="/self-host">self-host on your own Cloudflare account</a> with unlimited quotas.</span></p>`}
    <div class="actions">
      ${portalLive ? `<form method="post" action="/dashboard/billing/portal"><button type="submit" class="secondary sm">${icon("external")} Manage subscription &amp; invoices (Polar Portal)</button></form>` : ""}
      <a class="button ghost sm" href="/self-host">${icon("terminal")} Prefer unlimited? Self-host on Cloudflare</a>
    </div>
  </section>`;

  const capabilityBadges = [
    `<span class="badge ${ent.quotas.sfuEnabled ? "ok" : ""}">${ent.quotas.sfuEnabled ? `SFU up to ${ent.quotas.sfuMaxPeers} peers (${ent.quotas.sfuMaxHeight}p)` : "TURN trial (no SFU)"}</span>`,
    `<span class="badge ${ent.quotas.hostBrokeredOAuth ? "ok" : ""}">${ent.quotas.hostBrokeredOAuth ? "Host-brokered personal OAuth" : "Personal OAuth (Pro+)"}</span>`,
    `<span class="badge ${ent.quotas.teamOrgOAuth ? "ok" : ""}">${ent.quotas.teamOrgOAuth ? "Team OAuth tie-ins" : "Team OAuth tie-ins (Team)"}</span>`,
    `<span class="badge ${ent.quotas.customDomain ? "ok" : ""}">${ent.quotas.customDomain ? "Custom page domain" : "Custom domain (Team)"}</span>`,
  ].join("");

  const body = `<a class="back-link" href="/dashboard">← Back to dashboard</a>
    <section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("sparkles")} Plan &amp; usage</span><h1>Billing &amp; quotas</h1><p class="lead">${escape(email ?? accountId)} · ${escape(spec.tagline)}</p></div><div class="actions tight">${statusBadge}</div></div>
      <div class="actions tight" style="margin-top:.85rem;flex-wrap:wrap">${capabilityBadges}</div>
    </section>
    ${alerts.join("")}
    <section class="card stack-sm"><div class="card-head"><div><span class="eyebrow">Current usage</span><h2>Account &amp; monthly allowances</h2></div><span class="badge">Period ${escape(ent.usage.period)}</span></div><div class="list">${metersHtml}</div></section>
    ${paygCard}
    ${upgradeSection}`;

  const script = `<script>(()=>{
    const uncapped=document.getElementById('uncapped-payg'), cap=document.getElementById('spend-cap-usd');
    if(uncapped && cap){ uncapped.addEventListener('change',()=>{ cap.disabled=uncapped.checked; }); }
  })()</script>`;

  return servicePage("Billing & quotas", body, script, 200, {
    wide: true,
    formAction: "'self' https://polar.sh https://*.polar.sh",
  });
}

function parseFormOrJson(req: Request, raw: string): { isJson: boolean; params: Record<string, unknown> } {
  const isJson = (req.headers.get("Content-Type") ?? "").includes("application/json");
  if (!isJson) return { isJson: false, params: Object.fromEntries(new URLSearchParams(raw)) };
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "bad_json", "Expected a JSON object.");
    }
    return { isJson: true, params: parsed as Record<string, unknown> };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "bad_json", "Request body is not valid JSON.");
  }
}

/** Route `/dashboard/billing*` for signed-in accounts. */
export async function routeBillingDashboard(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await serviceSession(req, env, true);
  if (!session || !env.ACCOUNTS) {
    return redirect(`/auth?return_to=${encodeURIComponent(url.pathname)}`, 302);
  }
  if (session.suspendedAt) {
    return errorResponse(403, "suspended", "Account billing is unavailable while the account is suspended.");
  }

  try {
    if (url.pathname === "/dashboard/billing" && req.method === "GET") {
      return await renderBillingDashboard(req, env, url, session.accountId, session.email);
    }
    if (url.pathname === "/dashboard/billing/checkout" && req.method === "POST") {
      sameOrigin(req, env);
      await requireWritesOpen(env);
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { params } = parseFormOrJson(req, raw);
      const plan = params.plan === "team" ? "team" : params.plan === "pro" ? "pro" : null;
      const interval: BillingInterval = params.interval === "year" ? "year" : "month";
      if (!plan) throw new HttpError(400, "bad_request", "Select pro or team plan.");
      const origin = publicBase(env);
      const checkout = await createPolarCheckout(env, {
        accountId: session.accountId,
        email: session.email,
        plan,
        interval,
        customerIp: req.headers.get("CF-Connecting-IP"),
        successUrl: `${origin}/dashboard/billing?checkout=success`,
        returnUrl: `${origin}/dashboard/billing`,
      });
      if ((req.headers.get("Accept") ?? "").includes("application/json")) {
        return json({ id: checkout.id, url: checkout.url });
      }
      return redirect(checkout.url, 303);
    }
    if (url.pathname === "/dashboard/billing/portal" && req.method === "POST") {
      sameOrigin(req, env);
      const sub = await env.ACCOUNTS.prepare("SELECT customer_id FROM subscriptions WHERE account_id = ?")
        .bind(session.accountId).first<{ customer_id: string | null }>();
      const origin = publicBase(env);
      const portal = await createPolarCustomerSession(env, {
        accountId: session.accountId,
        customerId: sub?.customer_id,
        returnUrl: `${origin}/dashboard/billing`,
      });
      if ((req.headers.get("Accept") ?? "").includes("application/json")) {
        return json({ url: portal.customer_portal_url });
      }
      return redirect(portal.customer_portal_url, 303);
    }
    if (url.pathname === "/dashboard/billing/payg" && req.method === "POST") {
      sameOrigin(req, env);
      await requireWritesOpen(env);
      const ent = await getAccountEntitlements(env, session.accountId);
      if (!ent.quotas.paygAllowed) {
        throw new HttpError(402, "plan_required", "Pay-as-you-go overage requires Pro or Team.");
      }
      const raw = new TextDecoder().decode(await readBody(req, 4096));
      const { isJson, params } = parseFormOrJson(req, raw);
      const enabled = params.payg_enabled === true || params.payg_enabled === "1" || params.payg_enabled === "true" || params.payg_enabled === "on";
      const uncapped = params.uncapped === true || params.uncapped === "1" || params.uncapped === "true" || params.uncapped === "on" || params.spend_cap_cents === null;
      let capCents: number | null = DEFAULT_PAYG_SPEND_CAP_CENTS;
      if (uncapped) {
        capCents = null;
      } else if (params.spend_cap_cents !== undefined && params.spend_cap_cents !== "") {
        const parsed = Number(params.spend_cap_cents);
        if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 1_000_000) {
          throw new HttpError(400, "invalid_spend_cap", "Spend cap must be between $1 and $10,000 (or disabled).");
        }
        capCents = parsed;
      } else if (params.spend_cap_usd !== undefined && params.spend_cap_usd !== "") {
        const usd = Number(params.spend_cap_usd);
        if (!Number.isFinite(usd) || usd < 1 || usd > 10_000) {
          throw new HttpError(400, "invalid_spend_cap", "Spend cap must be between $1 and $10,000 (or disabled).");
        }
        capCents = Math.round(usd * 100);
      } else {
        capCents = ent.paygSpendCapCents ?? DEFAULT_PAYG_SPEND_CAP_CENTS;
      }
      await env.ACCOUNTS.prepare("UPDATE accounts SET payg_enabled = ?, payg_spend_cap_cents = ? WHERE id = ?")
        .bind(enabled ? 1 : 0, capCents, session.accountId).run();
      if (isJson || (req.headers.get("Accept") ?? "").includes("application/json")) {
        return json({ ok: true, payg_enabled: enabled, payg_spend_cap_cents: capCents });
      }
      return redirect("/dashboard/billing?saved=1", 303);
    }
    return errorResponse(404, "not_found");
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Public `/api/webhooks/polar` endpoint (Polar Standard Webhooks). */
export async function polarWebhookRoute(req: Request, env: Env): Promise<Response> {
  try {
    const result = await processPolarWebhook(env, req);
    return json(result, 200);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export { billingConfigured };
