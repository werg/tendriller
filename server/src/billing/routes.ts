/**
 * Public `/pricing`, `/self-host`, authenticated `/dashboard/billing*`, and `/api/webhooks/polar` routes.
 * Renders cleanly on desktop and 320px phone widths using Tendriller's shared `servicePage` shell.
 */
import type { Env } from "../env";
import { errorResponse, HttpError, json, readBody, toErrorResponse } from "../http";
import { publicBase } from "../urls";
import { serviceSession } from "../accounts/auth";
import { darkCss, icon, servicePage } from "../accounts/ui";
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

const PRICING_CSS = `
.topbar-inner.wide,main.wide{max-width:84rem}
.pricing-hero{padding:clamp(1.6rem,3.4vw,2.6rem) clamp(1.4rem,3.6vw,2.75rem);margin-bottom:1.5rem}
.pricing-hero-grid{display:grid;grid-template-columns:minmax(0,1.35fr) auto;align-items:end;gap:1.5rem 2.5rem}
.pricing-hero h1{font-size:clamp(1.95rem,3.4vw,2.75rem);margin:.15rem 0 .65rem;max-width:22ch}
.pricing-hero .lead{max-width:40rem;font-size:1.03rem;line-height:1.55}
.pricing-hero-controls{display:flex;flex-direction:column;align-items:flex-end;gap:.75rem}
.billing-toggle{
  display:inline-flex;align-items:center;gap:.25rem;padding:.3rem;
  border-radius:14px;background:rgba(22,92,67,.08);
  border:1px solid rgba(22,92,67,.18);
}
.billing-toggle button{
  min-height:2.25rem;padding:.4rem .95rem;border-radius:10px;
  font-size:.87rem;font-weight:680;border:1px solid transparent;box-shadow:none;
  transition:background .12s ease,color .12s ease,box-shadow .12s ease;
}
.billing-toggle button[aria-pressed="true"],
.billing-toggle button[aria-pressed="true"]:hover{
  background:var(--green);color:#fff;
  box-shadow:0 2px 10px rgba(20,32,25,.14);
}
.billing-toggle button[aria-pressed="false"]{background:transparent;color:var(--muted)}
.billing-toggle button[aria-pressed="false"]:hover{background:rgba(22,92,67,.08);color:var(--ink)}
.billing-save{
  display:inline-flex;align-items:center;padding:.12rem .48rem;border-radius:999px;
  font-size:.72rem;font-weight:760;letter-spacing:.01em;margin-left:.28rem;
  background:rgba(22,92,67,.14);color:var(--green);
}
.billing-toggle button[aria-pressed="true"] .billing-save{background:rgba(255,255,255,.22);color:#fff}
.hero-selfhost-link{
  display:inline-flex;align-items:center;gap:.38rem;font-size:.86rem;font-weight:640;
  color:var(--stage-link);text-decoration:none;
}
.hero-selfhost-link:hover{color:var(--stage-link-hover);text-decoration:underline}

/* 3 hosted tier cards — aligned across rows via subgrid on desktop */
.tier-grid{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
  gap:1.15rem;align-items:stretch;margin:0 0 1.25rem;
}
.tier-card{
  position:relative;display:flex;flex-direction:column;
  background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.6rem 1.55rem 1.55rem;box-shadow:var(--shadow);min-width:0;
}
.tier-card.featured{
  border-color:color-mix(in srgb,var(--green) 65%,var(--line));
  box-shadow:0 0 0 1px color-mix(in srgb,var(--green) 24%,transparent),var(--shadow-lg);
  background:linear-gradient(180deg,color-mix(in srgb,var(--green-soft) 32%,var(--surface)) 0%,var(--surface) 38%);
}
.tier-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.65rem;margin-bottom:.85rem}
.tier-head .eyebrow{margin-bottom:.2rem}
.tier-card.featured .tier-head .eyebrow{color:var(--green)}
.tier-head h2{font-size:1.38rem;line-height:1.15;letter-spacing:-.025em;margin:0}
.tier-popular{
  flex:none;padding:.22rem .62rem;border-radius:999px;font-size:.73rem;font-weight:740;
  background:var(--green-soft);color:var(--green);letter-spacing:.01em;
}
.tier-price-wrap{margin-bottom:.75rem}
.tier-price{display:flex;align-items:baseline;gap:.28rem;line-height:1}
.tier-amount{font-size:2.45rem;font-weight:820;letter-spacing:-.045em;font-variant-numeric:tabular-nums;color:var(--ink)}
.tier-unit{font-size:.94rem;font-weight:620;color:var(--muted)}
.tier-cadence{margin:.35rem 0 0;font-size:.82rem;color:var(--faint);min-height:1.25em;max-width:none}
.tier-desc{font-size:.93rem;line-height:1.48;color:var(--muted);margin:0 0 1.25rem;max-width:none}
.tier-cta{margin-bottom:1.25rem}
.tier-cta form{display:block;width:100%}
.tier-cta .button,.tier-cta button{width:100%;min-height:2.7rem}
.tier-features{
  list-style:none;margin:0;padding:1.15rem 0 0;border-top:1px solid var(--line);
  display:flex;flex-direction:column;gap:.7rem;font-size:.89rem;line-height:1.45;color:var(--muted);
}
.tier-features li{display:flex;align-items:flex-start;gap:.6rem}
.tier-features .icon{color:var(--green);margin-top:.18rem;width:1rem;height:1rem;flex:none}
.tier-features strong{color:var(--ink);font-weight:680}
.tier-features code{font-size:.82em}

@media(min-width:960px){
  .tier-grid{grid-template-rows:auto auto auto auto 1fr}
  .tier-card{display:grid;grid-template-rows:subgrid;grid-row:span 5;row-gap:0}
}

/* Dedicated full-width Self-Hosted off-ramp band */
.self-host-band{
  display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.5fr) auto;
  align-items:center;gap:1.25rem 2rem;
  padding:1.45rem 1.7rem;border-radius:var(--radius);margin:0 0 2.75rem;
  background:linear-gradient(125deg,color-mix(in srgb,var(--surface) 90%,var(--amber) 10%) 0%,var(--surface) 56%);
  border:1px solid color-mix(in srgb,var(--amber) 45%,var(--line));
  box-shadow:var(--shadow);
}
.self-host-intro .eyebrow{color:var(--warn);margin-bottom:.25rem}
.self-host-title-row{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;margin-bottom:.35rem}
.self-host-title-row h2{font-size:1.3rem;margin:0}
.self-host-intro p{font-size:.91rem;line-height:1.5;color:var(--muted);margin:0;max-width:none}
.self-host-points{
  list-style:none;margin:0;padding:0;
  display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem 1.25rem;
  font-size:.87rem;line-height:1.4;color:var(--muted);
}
.self-host-points li{display:flex;align-items:flex-start;gap:.5rem}
.self-host-points .icon{color:var(--green);margin-top:.14rem;width:.98rem;height:.98rem;flex:none}
.self-host-points strong{color:var(--ink);font-weight:660}
.self-host-action{display:flex;flex-direction:column;align-items:flex-end;gap:.45rem}
.self-host-note{font-size:.78rem;color:var(--faint);text-align:right;white-space:nowrap}

/* Section headers */
.pricing-section{margin:0 0 2.75rem}
.pricing-section-head{
  display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;
  margin-bottom:1.1rem;
}
.pricing-section-head h2{font-size:clamp(1.35rem,2.3vw,1.7rem);letter-spacing:-.028em;margin:0}
.pricing-section-note{font-size:.86rem;color:var(--muted);margin:0}
.pricing-section-note a{font-weight:640;text-decoration:none}
.pricing-section-note a:hover{text-decoration:underline}

/* Side-by-side comparison matrix */
.compare-wrap{
  overflow-x:auto;-webkit-overflow-scrolling:touch;
  border:1px solid var(--line);border-radius:var(--radius);
  background:var(--surface);box-shadow:var(--shadow);
}
.compare-table{width:100%;border-collapse:separate;border-spacing:0;min-width:46rem;font-size:.88rem}
.compare-table th,.compare-table td{
  padding:.82rem 1rem;text-align:left;vertical-align:top;
  border-bottom:1px solid var(--line);
}
.compare-table thead th{
  padding:1rem;background:var(--surface-2);border-bottom:1px solid var(--line-strong);
  font-weight:740;color:var(--ink);white-space:nowrap;
}
.compare-table thead th:first-child{width:32%}
.compare-table thead th:not(:first-child){width:17%}
.compare-col-price{display:block;margin-top:.16rem;font-size:.79rem;font-weight:620;color:var(--muted);font-variant-numeric:tabular-nums}
.compare-table th.col-pro{background:color-mix(in srgb,var(--green-soft) 60%,var(--surface-2))}
.compare-table th.col-pro .compare-col-name{color:var(--green)}
.compare-table td.col-pro{background:color-mix(in srgb,var(--green-soft) 24%,transparent)}
.compare-table tbody tr.cat-row th{
  padding:.62rem 1rem;background:var(--paper-2);
  font-size:.72rem;font-weight:780;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);
}
.compare-table tbody tr:not(.cat-row):hover td,
.compare-table tbody tr:not(.cat-row):hover th{
  background:color-mix(in srgb,var(--surface-2) 55%,transparent);
}
.compare-table tbody tr:not(.cat-row):hover td.col-pro{
  background:color-mix(in srgb,var(--green-soft) 40%,transparent);
}
.compare-table tbody tr:last-child th,.compare-table tbody tr:last-child td{border-bottom:0}
.compare-table tbody th[scope="row"]{font-weight:640;color:var(--ink)}
.cell-main{display:block;font-weight:640;color:var(--ink);font-variant-numeric:tabular-nums}
.cell-sub{display:block;margin-top:.14rem;font-size:.78rem;line-height:1.38;color:var(--muted)}
.cell-check{display:inline-flex;align-items:center;gap:.35rem;font-weight:650;color:var(--green)}
.cell-check .icon{width:1rem;height:1rem}
.cell-dash{color:var(--faint);font-weight:500}

/* Fairness guarantees 4-card grid */
.guarantees-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}
.guarantee-card{
  display:flex;flex-direction:column;gap:.55rem;
  padding:1.35rem 1.3rem;border-radius:var(--radius);
  background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-sm);
}
.g-ico{
  display:grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:11px;
  background:var(--green-soft);color:var(--green);margin-bottom:.25rem;
}
.g-ico.warm{background:var(--orange-soft);color:var(--orange)}
.g-ico.amber{background:var(--warn-soft);color:var(--warn)}
.guarantee-card h3{font-size:1rem;line-height:1.25;margin:0}
.guarantee-card p{font-size:.87rem;line-height:1.52;color:var(--muted);margin:0;max-width:none}
.guarantee-card a{font-weight:620}

@media(max-width:1100px){
  .pricing-hero-grid{grid-template-columns:1fr;align-items:start}
  .pricing-hero-controls{align-items:flex-start}
  .self-host-band{grid-template-columns:1fr;gap:1.15rem}
  .self-host-action{align-items:flex-start}
  .self-host-note{text-align:left}
  .guarantees-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
.compare-scroll-hint{display:none;font-size:.78rem;color:var(--faint);margin:-.45rem 0 .65rem}
@media(max-width:959px){
  .tier-grid{grid-template-columns:1fr;max-width:34rem}
  .compare-scroll-hint{display:block}
  .compare-table{min-width:36rem}
  .compare-table thead th:first-child{width:auto;min-width:9.5rem;max-width:10.5rem}
  .compare-table thead th:not(:first-child){width:auto;min-width:6.8rem}
  .compare-table thead th:first-child,.compare-table tbody th[scope="row"]{
    position:sticky;left:0;z-index:2;
    background:var(--surface);box-shadow:1px 0 0 var(--line);
  }
  .compare-table thead th:first-child{background:var(--surface-2)}
}
@media(max-width:600px){
  .self-host-points,.guarantees-grid{grid-template-columns:1fr}
  .self-host-band{padding:1.25rem 1.15rem}
  .tier-card{padding:1.35rem 1.2rem}
  .billing-toggle{width:100%;justify-content:stretch}
  .billing-toggle button{flex:1 1 0;padding:.4rem .6rem;font-size:.82rem}
}
${darkCss(`
  .billing-toggle{background:rgba(8,16,13,.46);border-color:rgba(255,244,218,.16)}
  .billing-toggle button[aria-pressed="true"],.billing-toggle button[aria-pressed="true"]:hover{background:#6ed39f;color:#081b12;box-shadow:0 2px 10px rgba(0,0,0,.22)}
  .billing-toggle button[aria-pressed="false"]{background:transparent;color:#dde8e1}
  .billing-toggle button[aria-pressed="false"]:hover{background:rgba(255,248,232,.11);color:#fff9ec}
  .billing-save{background:rgba(110,211,159,.18);color:#9be6be}
  .billing-toggle button[aria-pressed="true"] .billing-save{background:rgba(8,27,18,.15);color:#081b12}
  .self-host-band{background:linear-gradient(125deg,rgba(243,181,68,.09) 0%,var(--surface) 58%);border-color:rgba(243,181,68,.28)}
`)}
`;

function compareRow(label: string, values: readonly [string, string, string, string], subLabel?: string): string {
  const th = subLabel
    ? `${escape(label)}<span class="cell-sub">${escape(subLabel)}</span>`
    : escape(label);
  return `<tr><th scope="row">${th}</th><td>${values[0]}</td><td class="col-pro">${values[1]}</td><td>${values[2]}</td><td>${values[3]}</td></tr>`;
}

function cell(main: string, sub?: string): string {
  return `<span class="cell-main">${escape(main)}</span>${sub ? `<span class="cell-sub">${escape(sub)}</span>` : ""}`;
}

/** Public `/pricing` page comparing Free, Pro, Team, and Self-Hosted transparently. */
export async function pricingPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "method_not_allowed");
  const session = env.ACCOUNTS ? await serviceSession(req, env).catch(() => null) : null;
  const ent = session ? await getAccountEntitlements(env, session.accountId).catch(() => null) : null;
  const checkoutLive = Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCTS_JSON);

  const planAction = (planId: "pro" | "team", label: string, primary: boolean) => {
    if (ent?.plan === planId) {
      return `<a class="button secondary block" href="/dashboard/billing">Current plan · Manage</a>`;
    }
    if (!session) {
      return `<a class="button${primary ? "" : " secondary"} block" href="/auth?return_to=${encodeURIComponent("/dashboard/billing")}">${escape(label)}</a>`;
    }
    if (!checkoutLive) {
      return `<a class="button${primary ? "" : " secondary"} block" href="/dashboard/billing">${escape(label)}</a>`;
    }
    return `<form method="post" action="/dashboard/billing/checkout">
      <input type="hidden" name="plan" value="${planId}">
      <input type="hidden" name="interval" value="month" data-billing-interval>
      <button type="submit" class="${primary ? "" : "secondary "}block">${escape(label)}</button>
    </form>`;
  };

  const yes = `<span class="cell-check">${icon("check")} Included</span>`;
  const no = `<span class="cell-dash" aria-label="Not included">—</span>`;

  const body = `<section class="hero dark pricing-hero">
    <div class="pricing-hero-grid">
      <div>
        <span class="eyebrow">${icon("sparkles")} Get more out of Tendriller</span>
        <h1>Grow with your agent</h1>
        <p class="lead">Everything you need to get started is free. Super AI-pilled? You can go wild with bigger plans!</p>
      </div>
      <div class="pricing-hero-controls">
        <div class="billing-toggle" role="group" aria-label="Billing interval">
          <button type="button" id="interval-month" aria-pressed="true">Monthly</button>
          <button type="button" id="interval-year" aria-pressed="false">Annual <span class="billing-save">Save ~30%</span></button>
        </div>
        <a class="hero-selfhost-link" href="#self-host">${icon("terminal")} Prefer your own cloud? Self-host free</a>
      </div>
    </div>
  </section>

  <section class="tier-grid" aria-label="Hosted plans">
    <article class="tier-card">
      <div class="tier-head">
        <div><span class="eyebrow">Hobby</span><h2>Free</h2></div>
      </div>
      <div class="tier-price-wrap">
        <div class="tier-price"><span class="tier-amount">$0</span><span class="tier-unit">/ mo</span></div>
        <p class="tier-cadence">Free forever · no card required</p>
      </div>
      <p class="tier-desc">${escape(PLANS.free.tagline)}</p>
      <div class="tier-cta">${session ? `<a class="button secondary block" href="/dashboard">Open dashboard</a>` : `<a class="button secondary block" href="/auth">Get started free</a>`}</div>
      <ul class="tier-features">
        <li>${icon("check")}<span><strong>20</strong> pages &amp; <strong>1 GB</strong> file storage</span></li>
        <li>${icon("check")}<span><strong>5</strong> agents &amp; up to <strong>10</strong> guests per page</span></li>
        <li>${icon("check")}<span><strong>Unlimited</strong> direct peer-to-peer sync &amp; <strong>2 GB/mo</strong> call relay trial</span></li>
        <li>${icon("check")}<span>Hosted MCP on <strong>1</strong> page (<strong>250</strong> calls/mo)</span></li>
        <li>${icon("check")}<span>Full offline mode &amp; zero vendor lock-in</span></li>
      </ul>
    </article>

    <article class="tier-card featured">
      <div class="tier-head">
        <div><span class="eyebrow">Recommended</span><h2>Pro</h2></div>
        <span class="tier-popular">Most popular</span>
      </div>
      <div class="tier-price-wrap">
        <div class="tier-price"><span class="tier-amount" data-price-pro>$12</span><span class="tier-unit">/ mo</span></div>
        <p class="tier-cadence" data-cadence-pro>Billed monthly · or $100/yr (~30% off)</p>
      </div>
      <p class="tier-desc">${escape(PLANS.pro.tagline)}</p>
      <div class="tier-cta">${planAction("pro", "Upgrade to Pro", true)}</div>
      <ul class="tier-features">
        <li>${icon("check")}<span><strong>100</strong> pages &amp; <strong>20 GB</strong> file storage</span></li>
        <li>${icon("check")}<span><strong>25</strong> agents &amp; up to <strong>50</strong> guests per page</span></li>
        <li>${icon("check")}<span><strong>100 GB/mo</strong> group video calls (up to 12 people, 720p) &amp; priority relay</span></li>
        <li>${icon("check")}<span>Hosted MCP on <strong>25</strong> pages (<strong>15,000</strong> calls/mo)</span></li>
        <li>${icon("check")}<span><strong>Cloud-connected personal accounts</strong> &amp; optional pay-as-you-go</span></li>
      </ul>
    </article>

    <article class="tier-card">
      <div class="tier-head">
        <div><span class="eyebrow">Studio &amp; Orgs</span><h2>Team</h2></div>
      </div>
      <div class="tier-price-wrap">
        <div class="tier-price"><span class="tier-amount" data-price-team>$39</span><span class="tier-unit">/ mo</span></div>
        <p class="tier-cadence" data-cadence-team>Billed monthly · or $320/yr (~32% off)</p>
      </div>
      <p class="tier-desc">${escape(PLANS.team.tagline)}</p>
      <div class="tier-cta">${planAction("team", "Upgrade to Team", false)}</div>
      <ul class="tier-features">
        <li>${icon("check")}<span><strong>1,000</strong> pages &amp; <strong>100 GB</strong> file storage</span></li>
        <li>${icon("check")}<span><strong>100</strong> agents &amp; up to <strong>250</strong> guests per page</span></li>
        <li>${icon("check")}<span><strong>500 GB/mo</strong> group video calls (up to 50 people, 1080p + screen share)</span></li>
        <li>${icon("check")}<span>Hosted MCP on <strong>100</strong> pages (<strong>100,000</strong> calls/mo)</span></li>
        <li>${icon("check")}<span><strong>Team sign-in</strong> (GitHub Org &amp; Google Workspace) &amp; custom page domains</span></li>
      </ul>
    </article>
  </section>

  <section id="self-host" class="self-host-band" aria-labelledby="self-host-title">
    <div class="self-host-intro">
      <span class="eyebrow">Open source · Zero lock-in</span>
      <div class="self-host-title-row">
        <h2 id="self-host-title">Self-Hosted</h2>
        <span class="badge ok">$0 OSS</span>
      </div>
      <p>Run the exact same Tendriller engine on your own Cloudflare account with no platform limits.</p>
    </div>
    <ul class="self-host-points">
      <li>${icon("check")}<span><strong>Unlimited</strong> pages, agents &amp; guests</span></li>
      <li>${icon("check")}<span><strong>All Pro &amp; Team</strong> features unlocked</span></li>
      <li>${icon("check")}<span><strong>1 TB/mo</strong> free video via Cloudflare</span></li>
      <li>${icon("check")}<span><strong>Clean migration</strong> out anytime</span></li>
    </ul>
    <div class="self-host-action">
      <a class="button secondary" href="/self-host">${icon("terminal")} 5-minute self-host guide</a>
      <span class="self-host-note">Typical Cloudflare cost: $0–$5/mo</span>
    </div>
  </section>

  <section id="compare" class="pricing-section" aria-labelledby="compare-title">
    <div class="pricing-section-head">
      <div>
        <span class="eyebrow">Side-by-side</span>
        <h2 id="compare-title">Compare all plans</h2>
      </div>
      <p class="pricing-section-note">Every plan includes offline editing, direct peer-to-peer sync, and full data export.</p>
    </div>
    <p class="compare-scroll-hint">Swipe horizontally to compare all four plans →</p>
    <div class="compare-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col"><span class="compare-col-name">Free</span><span class="compare-col-price">$0 / mo</span></th>
            <th scope="col" class="col-pro"><span class="compare-col-name">Pro</span><span class="compare-col-price" data-table-price-pro>$12 / mo</span></th>
            <th scope="col"><span class="compare-col-name">Team</span><span class="compare-col-price" data-table-price-team>$39 / mo</span></th>
            <th scope="col"><span class="compare-col-name">Self-Hosted</span><span class="compare-col-price">$0 OSS</span></th>
          </tr>
        </thead>
        <tbody>
          <tr class="cat-row"><th colspan="5">Workspace &amp; storage</th></tr>
          ${compareRow("Pages", [cell("20"), cell("100"), cell("1,000"), cell("Unlimited")])}
          ${compareRow("App & file storage", [cell("1 GB", "100 MB / page"), cell("20 GB", "250 MB / page"), cell("100 GB", "500 MB / page"), cell("Unlimited", "Your Cloudflare account")])}
          ${compareRow("Agents", [cell("5"), cell("25"), cell("100"), cell("Unlimited")])}
          ${compareRow("Guests per page", [cell("10"), cell("50"), cell("250"), cell("Unlimited")])}

          <tr class="cat-row"><th colspan="5">Sync, video calls &amp; relay</th></tr>
          ${compareRow("Direct peer-to-peer sync", [cell("Unlimited"), cell("Unlimited"), cell("Unlimited"), cell("Unlimited")])}
          ${compareRow("Group video calls & firewall relay", [cell("2 GB / mo", "Trial for 1:1 & audio"), cell("100 GB / mo", "Up to 12 people · 720p"), cell("500 GB / mo", "Up to 50 people · 1080p + screen"), cell("Unlimited", "Your Cloudflare keys · 1 TB/mo free")])}
          ${compareRow("Cloud relay fallback", [cell("5 hrs / mo", "2 concurrent · 1h sessions"), cell("50 hrs / mo", "16 concurrent · 2h sessions"), cell("250 hrs / mo", "64 concurrent · 4h sessions"), cell("Unlimited")])}

          <tr class="cat-row"><th colspan="5">Hosted MCP</th></tr>
          ${compareRow("Enabled pages", [cell("1 page"), cell("25 pages"), cell("100 pages"), cell("Unlimited")])}
          ${compareRow("Monthly calls", [cell("250 / mo"), cell("15,000 / mo"), cell("100,000 / mo"), cell("Unlimited")])}
          ${compareRow("Synced state per page", [cell("50 MB"), cell("500 MB"), cell("2 GB"), cell("Unlimited")])}

          <tr class="cat-row"><th colspan="5">Identity, teams &amp; domains</th></tr>
          ${compareRow("Cloud-connected personal accounts", [no, yes, yes, yes], "Works even when your laptop is asleep")}
          ${compareRow("Team OAuth tie-ins", [no, no, yes, yes], "GitHub Org & Google Workspace admission + auto-offboarding")}
          ${compareRow("Custom page domains", [no, no, cell("Included", "e.g. app.yourteam.com"), cell("Included")])}

          <tr class="cat-row"><th colspan="5">Overages &amp; billing</th></tr>
          ${compareRow("Optional pay-as-you-go", [cell("Off", "Falls back to free P2P"), cell("$0.10 / GB video", "$2 / 10k MCP calls · spend cap"), cell("$0.08 / GB video", "$1.50 / 10k MCP calls · spend cap"), cell("Direct to Cloudflare")], "Off by default; editable monthly spend cap")}
        </tbody>
      </table>
    </div>
  </section>

  <section class="pricing-section" aria-labelledby="guarantees-title">
    <div class="pricing-section-head">
      <div>
        <span class="eyebrow">Our promise</span>
        <h2 id="guarantees-title">Fairness guarantees</h2>
      </div>
      <p class="pricing-section-note">${session ? `<a href="/dashboard/billing">Manage billing &amp; usage</a> · ` : ""}<a href="/pricing.md">Machine-readable pricing (.md) →</a></p>
    </div>
    <div class="guarantees-grid">
      <article class="guarantee-card">
        <span class="g-ico">${icon("database")}</span>
        <h3>Free forever for local work</h3>
        <p>Offline reads and writes, direct peer-to-peer sync, running <code>tendril agent run</code> locally, and exporting your workspaces never require a paid plan.</p>
      </article>
      <article class="guarantee-card">
        <span class="g-ico">${icon("shield")}</span>
        <h3>Limits never lock or delete data</h3>
        <p>Hit a limit or downgrade from Pro to Free — your existing pages stay accessible and editable offline. You only pause creating new pages above the cap.</p>
      </article>
      <article class="guarantee-card">
        <span class="g-ico warm">${icon("sliders")}</span>
        <h3>Zero surprise overage bills</h3>
        <p>Pay-as-you-go is off by default. When enabled, a monthly safety spend cap (default $25, editable or removable anytime) keeps you in control. Billing and global tax are handled by Polar.sh.</p>
      </article>
      <article class="guarantee-card">
        <span class="g-ico amber">${icon("terminal")}</span>
        <h3>Leave anytime, cleanly</h3>
        <p>Tendriller is open source. Export your workspace or <a href="/self-host">self-host on your own Cloudflare account</a> in five minutes using the exact same engine.</p>
      </article>
    </div>
  </section>`;

  const script = `<script>(()=>{
    const m=document.getElementById('interval-month'), y=document.getElementById('interval-year');
    const pro=document.querySelector('[data-price-pro]'), team=document.querySelector('[data-price-team]');
    const cadPro=document.querySelector('[data-cadence-pro]'), cadTeam=document.querySelector('[data-cadence-team]');
    const tblPro=document.querySelector('[data-table-price-pro]'), tblTeam=document.querySelector('[data-table-price-team]');
    const inputs=()=>document.querySelectorAll('[data-billing-interval]');
    function set(interval){
      const annual=interval==='year';
      m.setAttribute('aria-pressed',String(!annual));
      y.setAttribute('aria-pressed',String(annual));
      if(pro) pro.textContent=annual?'$8.33':'$12';
      if(team) team.textContent=annual?'$26.67':'$39';
      if(cadPro) cadPro.textContent=annual?'Billed $100 / yr · save $44':'Billed monthly · or $100/yr (~30% off)';
      if(cadTeam) cadTeam.textContent=annual?'Billed $320 / yr · save $148':'Billed monthly · or $320/yr (~32% off)';
      if(tblPro) tblPro.textContent=annual?'$100 / yr ($8.33/mo)':'$12 / mo';
      if(tblTeam) tblTeam.textContent=annual?'$320 / yr ($26.67/mo)':'$39 / mo';
      inputs().forEach(el=>el.value=interval);
    }
    m?.addEventListener('click',()=>set('month'));
    y?.addEventListener('click',()=>set('year'));
  })()</script>`;

  const response = servicePage("Pricing", body, script, 200, {
    wide: true,
    extraCss: PRICING_CSS,
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
      <li><div style="min-width:0;flex:1">Clone Tendriller and install dependencies (Node 22.15+):<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);overflow-x:auto;font-size:.82rem">git clone https://github.com/werg/tendriller.git &amp;&amp; cd tendriller
npm ci &amp;&amp; npm run build</pre></div></li>
      <li><div style="min-width:0;flex:1">Provision fresh Worker, D1, R2, and domains with the built-in script:<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);overflow-x:auto;font-size:.82rem">PRODUCTION_PUBLIC_BASE=https://app.yourdomain.com \\
PRODUCTION_PAGE_BASE_DOMAIN=pages.yourdomain.com \\
node scripts/provision.mjs production --name my-tendriller --fresh</pre></div></li>
      <li><div style="min-width:0;flex:1">Apply D1 migrations and set unlimited caps (<code>NULL</code>):<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);overflow-x:auto;font-size:.82rem">npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc
npx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc \\
  --command "UPDATE service_state SET mode='open', account_page_cap=NULL, account_resident_cap=NULL, account_storage_cap=NULL WHERE id=1"</pre></div></li>
      <li><div style="min-width:0;flex:1">Add your secrets (<code>HOST_ATTESTATION_KEY</code>, GitHub/Google OAuth or <code>LOCAL_PASSWORD_HASH</code>, and optional <code>CF_REALTIME_*</code> / <code>CF_TURN_*</code>) and deploy:<pre style="margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);overflow-x:auto;font-size:.82rem">npx wrangler deploy --config server/wrangler.my-tendriller.jsonc</pre></div></li>
      <li><div style="min-width:0;flex:1">Move an existing workspace: export your account data from <a href="/dashboard/export">/dashboard/export</a>, point <code>tendriller.json</code> to your new service origin, and run <code>npm run deploy</code>.</div></li>
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
    meterRow("Pages", String(pagesUsed), ent.quotas.pages === null ? "Unlimited" : String(ent.quotas.pages), ratio(pagesUsed, ent.quotas.pages)),
    meterRow("App & file storage", fmtBytes(storageUsed), ent.quotas.storageBytes === null ? "Unlimited" : fmtBytes(ent.quotas.storageBytes), ratio(storageUsed, ent.quotas.storageBytes)),
    meterRow("Agents", String(agentsUsed), ent.quotas.agents === null ? "Unlimited" : String(ent.quotas.agents), ratio(agentsUsed, ent.quotas.agents)),
    meterRow("Hosted MCP opted-in pages", String(mcpPagesUsed), ent.quotas.mcpPages === null ? "Unlimited" : String(ent.quotas.mcpPages), ratio(mcpPagesUsed, ent.quotas.mcpPages)),
    meterRow("Hosted MCP calls (this month)", ent.usage.mcpCalls.toLocaleString("en-US"), ent.quotas.mcpCallsPerMonth === null ? "Unlimited" : ent.quotas.mcpCallsPerMonth.toLocaleString("en-US"), ratio(ent.usage.mcpCalls, ent.quotas.mcpCallsPerMonth), `Resets ${resetDate} UTC · local <code>tendril agent run</code> is always unlimited.`),
    meterRow("Host relay active time (this month)", fmtHours(ent.usage.relayMs), ent.quotas.relayMsPerMonth === null ? "Unlimited" : fmtHours(ent.quotas.relayMsPerMonth), ratio(ent.usage.relayMs, ent.quotas.relayMsPerMonth), `Resets ${resetDate} UTC · direct peer-to-peer sync uses 0 host relay time.`),
    meterRow("Group video & call relay (this month)", fmtBytes(ent.usage.mediaBytes), ent.quotas.mediaBytesPerMonth === null ? "Unlimited" : fmtBytes(ent.quotas.mediaBytesPerMonth), ratio(ent.usage.mediaBytes, ent.quotas.mediaBytesPerMonth), `Resets ${resetDate} UTC · ${ent.quotas.sfuEnabled ? `Group video up to ${ent.quotas.sfuMaxPeers} peers (${ent.quotas.sfuMaxHeight}p)` : "TURN trial only; upgrade for multi-party video"}.`),
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
      <div class="card stack-sm"><h3>Pro — $12/mo or $100/yr</h3><p class="muted" style="font-size:.86rem">100 pages · 20 GB storage · 100 GB group video · 15k hosted MCP calls/mo · cloud-connected personal OAuth.</p>
        <div class="actions tight">
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="pro"><input type="hidden" name="interval" value="month"><button type="submit" class="sm"${isProMonth ? " disabled" : ""}>${isProMonth ? "Current (Pro Monthly)" : "Pro Monthly"}</button></form>
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="pro"><input type="hidden" name="interval" value="year"><button type="submit" class="secondary sm"${isProYear ? " disabled" : ""}>${isProYear ? "Current (Pro Annual)" : "Pro Annual ($100)"}</button></form>
        </div>
      </div>
      <div class="card stack-sm"><h3>Team — $39/mo or $320/yr</h3><p class="muted" style="font-size:.86rem">1,000 pages · 100 GB storage · 500 GB group video · 100k hosted MCP calls/mo · Team OAuth tie-ins · custom domains.</p>
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
    `<a class="badge ${ent.quotas.customDomain ? "ok" : ""}" href="/dashboard/domains" style="text-decoration:none">${ent.quotas.customDomain ? "Custom page domains · Manage" : "Custom domains (Team)"}</a>`,
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
