/**
 * Public `/pricing`, `/self-host`, authenticated `/dashboard/billing*`, and `/api/webhooks/polar` routes.
 * Renders cleanly on desktop and 320px phone widths using Tendriller's shared `servicePage` shell.
 */
import type { Env } from "../env";
import { errorResponse, HttpError, json, readBody, toErrorResponse } from "../http";
import { publicBase } from "../urls";
import { serviceSession } from "../accounts/auth";
import { darkCss, icon, renderShell, servicePage } from "../accounts/ui";
import { copyAttrs, renderCopyText, SITE_COPY } from "../site-copy";
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
.compare-table{width:100%;border-collapse:separate;border-spacing:0;min-width:38rem;font-size:.88rem}
.compare-table th,.compare-table td{
  padding:.82rem 1rem;text-align:left;vertical-align:top;
  border-bottom:1px solid var(--line);
}
.compare-table thead th{
  padding:1rem;background:var(--surface-2);border-bottom:1px solid var(--line-strong);
  font-weight:740;color:var(--ink);white-space:nowrap;
}
.compare-table thead th:first-child{width:34%}
.compare-table thead th:not(:first-child){width:22%}
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
  .compare-table{min-width:30rem}
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

function compareRow(label: string, values: readonly [string, string, string], subLabel?: string): string {
  const th = subLabel
    ? `${escape(label)}<span class="cell-sub">${escape(subLabel)}</span>`
    : escape(label);
  return `<tr><th scope="row">${th}</th><td>${values[0]}</td><td class="col-pro">${values[1]}</td><td>${values[2]}</td></tr>`;
}

function cell(main: string, sub?: string): string {
  return `<span class="cell-main">${escape(main)}</span>${sub ? `<span class="cell-sub">${escape(sub)}</span>` : ""}`;
}

export function renderPricingPage(options: {
  signedIn?: boolean;
  currentPlan?: string | null;
  checkoutLive?: boolean;
  editable?: boolean;
} = {}): { body: string; script: string; extraCss: string } {
  const editable = Boolean(options.editable);
  const signedIn = Boolean(options.signedIn);
  const checkoutLive = Boolean(options.checkoutLive);
  const p = SITE_COPY.pricing;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const txt = (t: string) => renderCopyText(t);

  const planAction = (planId: "pro" | "team", label: string, copyKey: string, primary: boolean) => {
    if (options.currentPlan === planId) {
      return `<a class="button secondary block" href="/dashboard/billing">Current plan · Manage</a>`;
    }
    if (!signedIn) {
      return `<a class="button${primary ? "" : " secondary"} block" href="/auth?return_to=${encodeURIComponent("/dashboard/billing")}"><span${c(copyKey, label)}>${txt(label)}</span></a>`;
    }
    if (!checkoutLive) {
      return `<a class="button${primary ? "" : " secondary"} block" href="/dashboard/billing"><span${c(copyKey, label)}>${txt(label)}</span></a>`;
    }
    return `<form method="post" action="/dashboard/billing/checkout">
      <input type="hidden" name="plan" value="${planId}">
      <input type="hidden" name="interval" value="month" data-billing-interval>
      <button type="submit" class="${primary ? "" : "secondary "}block"><span${c(copyKey, label)}>${txt(label)}</span></button>
    </form>`;
  };

  const yes = `<span class="cell-check">${icon("check")} Included</span>`;
  const no = `<span class="cell-dash" aria-label="Not included">—</span>`;

  const body = `<section class="hero dark pricing-hero">
    <div class="pricing-hero-grid">
      <div>
        <span class="eyebrow">${icon("sparkles")} <span${c("pricing.hero.eyebrow", p.hero.eyebrow)}>${txt(p.hero.eyebrow)}</span></span>
        <h1${c("pricing.hero.title", p.hero.title)}>${txt(p.hero.title)}</h1>
        ${(editable || p.hero.lead.trim()) ? `<p class="lead"${c("pricing.hero.lead", p.hero.lead)}>${txt(p.hero.lead)}</p>` : ""}
      </div>
      <div class="pricing-hero-controls">
        <div class="billing-toggle" role="group" aria-label="Billing interval">
          <button type="button" id="interval-month" aria-pressed="true"><span${c("pricing.hero.monthlyLabel", p.hero.monthlyLabel)}>${txt(p.hero.monthlyLabel)}</span></button>
          <button type="button" id="interval-year" aria-pressed="false"><span${c("pricing.hero.annualLabel", p.hero.annualLabel)}>${txt(p.hero.annualLabel)}</span> <span class="billing-save"${c("pricing.hero.annualSave", p.hero.annualSave)}>${txt(p.hero.annualSave)}</span></button>
        </div>
        <a class="hero-selfhost-link" href="#self-host">${icon("terminal")} <span${c("pricing.hero.selfHostLink", p.hero.selfHostLink)}>${txt(p.hero.selfHostLink)}</span></a>
      </div>
    </div>
  </section>

  <section class="tier-grid" aria-label="Hosted plans">
    <article class="tier-card">
      <div class="tier-head">
        <div><span class="eyebrow"${c("pricing.tiers.free.eyebrow", p.tiers.free.eyebrow)}>${txt(p.tiers.free.eyebrow)}</span><h2${c("pricing.tiers.free.name", p.tiers.free.name)}>${txt(p.tiers.free.name)}</h2></div>
      </div>
      <div class="tier-price-wrap">
        <div class="tier-price"><span class="tier-amount"${c("pricing.tiers.free.price", p.tiers.free.price)}>${txt(p.tiers.free.price)}</span><span class="tier-unit"${c("pricing.tiers.free.unit", p.tiers.free.unit)}>${txt(p.tiers.free.unit)}</span></div>
        <p class="tier-cadence"${c("pricing.tiers.free.cadence", p.tiers.free.cadence)}>${txt(p.tiers.free.cadence)}</p>
      </div>
      <p class="tier-desc"${c("pricing.tiers.free.tagline", p.tiers.free.tagline)}>${txt(p.tiers.free.tagline)}</p>
      <div class="tier-cta">${signedIn ? `<a class="button secondary block" href="/dashboard"><span${c("pricing.tiers.free.ctaSignedIn", p.tiers.free.ctaSignedIn)}>${txt(p.tiers.free.ctaSignedIn)}</span></a>` : `<a class="button secondary block" href="/auth"><span${c("pricing.tiers.free.cta", p.tiers.free.cta)}>${txt(p.tiers.free.cta)}</span></a>`}</div>
      <ul class="tier-features">
        ${p.tiers.free.features.map((feat, i) => `<li>${icon("check")}<span${c(`pricing.tiers.free.features.${i}`, feat)}>${txt(feat)}</span></li>`).join("\n        ")}
      </ul>
    </article>

    <article class="tier-card featured">
      <div class="tier-head">
        <div><span class="eyebrow"${c("pricing.tiers.pro.eyebrow", p.tiers.pro.eyebrow)}>${txt(p.tiers.pro.eyebrow)}</span><h2${c("pricing.tiers.pro.name", p.tiers.pro.name)}>${txt(p.tiers.pro.name)}</h2></div>
        <span class="tier-popular"${c("pricing.tiers.pro.badge", p.tiers.pro.badge)}>${txt(p.tiers.pro.badge)}</span>
      </div>
      <div class="tier-price-wrap">
        <div class="tier-price"><span class="tier-amount" data-price-pro${c("pricing.tiers.pro.price", p.tiers.pro.price)}>${txt(p.tiers.pro.price)}</span><span class="tier-unit"${c("pricing.tiers.pro.unit", p.tiers.pro.unit)}>${txt(p.tiers.pro.unit)}</span></div>
        <p class="tier-cadence" data-cadence-pro${c("pricing.tiers.pro.cadence", p.tiers.pro.cadence)}>${txt(p.tiers.pro.cadence)}</p>
      </div>
      <p class="tier-desc"${c("pricing.tiers.pro.tagline", p.tiers.pro.tagline)}>${txt(p.tiers.pro.tagline)}</p>
      <div class="tier-cta">${planAction("pro", p.tiers.pro.cta, "pricing.tiers.pro.cta", true)}</div>
      <ul class="tier-features">
        ${p.tiers.pro.features.map((feat, i) => `<li>${icon("check")}<span${c(`pricing.tiers.pro.features.${i}`, feat)}>${txt(feat)}</span></li>`).join("\n        ")}
      </ul>
    </article>

    <article class="tier-card">
      <div class="tier-head">
        <div><span class="eyebrow"${c("pricing.tiers.team.eyebrow", p.tiers.team.eyebrow)}>${txt(p.tiers.team.eyebrow)}</span><h2${c("pricing.tiers.team.name", p.tiers.team.name)}>${txt(p.tiers.team.name)}</h2></div>
      </div>
      <div class="tier-price-wrap">
        <div class="tier-price"><span class="tier-amount" data-price-team${c("pricing.tiers.team.price", p.tiers.team.price)}>${txt(p.tiers.team.price)}</span><span class="tier-unit"${c("pricing.tiers.team.unit", p.tiers.team.unit)}>${txt(p.tiers.team.unit)}</span></div>
        <p class="tier-cadence" data-cadence-team${c("pricing.tiers.team.cadence", p.tiers.team.cadence)}>${txt(p.tiers.team.cadence)}</p>
      </div>
      <p class="tier-desc"${c("pricing.tiers.team.tagline", p.tiers.team.tagline)}>${txt(p.tiers.team.tagline)}</p>
      <div class="tier-cta">${planAction("team", p.tiers.team.cta, "pricing.tiers.team.cta", false)}</div>
      <ul class="tier-features">
        ${p.tiers.team.features.map((feat, i) => `<li>${icon("check")}<span${c(`pricing.tiers.team.features.${i}`, feat)}>${txt(feat)}</span></li>`).join("\n        ")}
      </ul>
    </article>
  </section>

  <section id="self-host" class="self-host-band" aria-labelledby="self-host-title">
    <div class="self-host-intro">
      <span class="eyebrow"${c("pricing.selfHost.eyebrow", p.selfHost.eyebrow)}>${txt(p.selfHost.eyebrow)}</span>
      <div class="self-host-title-row">
        <h2 id="self-host-title"${c("pricing.selfHost.title", p.selfHost.title)}>${txt(p.selfHost.title)}</h2>
        <span class="badge ok"${c("pricing.selfHost.badge", p.selfHost.badge)}>${txt(p.selfHost.badge)}</span>
      </div>
      <p${c("pricing.selfHost.lead", p.selfHost.lead)}>${txt(p.selfHost.lead)}</p>
    </div>
    <ul class="self-host-points">
      ${p.selfHost.points.map((pt, i) => `<li>${icon("check")}<span${c(`pricing.selfHost.points.${i}`, pt)}>${txt(pt)}</span></li>`).join("\n      ")}
    </ul>
    <div class="self-host-action">
      <a class="button secondary" href="/self-host">${icon("terminal")} <span${c("pricing.selfHost.cta", p.selfHost.cta)}>${txt(p.selfHost.cta)}</span></a>
      <span class="self-host-note"${c("pricing.selfHost.note", p.selfHost.note)}>${txt(p.selfHost.note)}</span>
    </div>
  </section>

  <section id="compare" class="pricing-section" aria-labelledby="compare-title">
    <div class="pricing-section-head">
      <div>
        <span class="eyebrow"${c("pricing.compare.eyebrow", p.compare.eyebrow)}>${txt(p.compare.eyebrow)}</span>
        <h2 id="compare-title"${c("pricing.compare.title", p.compare.title)}>${txt(p.compare.title)}</h2>
      </div>
      <p class="pricing-section-note"${c("pricing.compare.note", p.compare.note)}>${txt(p.compare.note)}</p>
    </div>
    <p class="compare-scroll-hint"${c("pricing.compare.scrollHint", p.compare.scrollHint)}>${txt(p.compare.scrollHint)}</p>
    <div class="compare-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col"><span class="compare-col-name">Free</span><span class="compare-col-price">$0 / mo</span></th>
            <th scope="col" class="col-pro"><span class="compare-col-name">Pro</span><span class="compare-col-price" data-table-price-pro>$12 / mo</span></th>
            <th scope="col"><span class="compare-col-name">Team</span><span class="compare-col-price" data-table-price-team>$39 / mo</span></th>
          </tr>
        </thead>
        <tbody>
          <tr class="cat-row"><th colspan="4">Workspace &amp; storage</th></tr>
          ${compareRow("Pages", [cell("20"), cell("100"), cell("1,000")])}
          ${compareRow("App & file storage", [cell("1 GB", "100 MB / page"), cell("20 GB", "250 MB / page"), cell("100 GB", "500 MB / page")])}
          ${compareRow("Agents", [cell("5"), cell("25"), cell("100")])}
          ${compareRow("Guests per page", [cell("10"), cell("50"), cell("250")])}

          <tr class="cat-row"><th colspan="4">Sync, video calls &amp; relay</th></tr>
          ${compareRow("Direct peer-to-peer sync", [cell("Unlimited"), cell("Unlimited"), cell("Unlimited")])}
          ${compareRow("Group video calls & firewall relay", [cell("2 GB / mo", "Trial for 1:1 & audio"), cell("100 GB / mo", "Up to 12 people · 720p"), cell("500 GB / mo", "Up to 50 people · 1080p + screen")])}
          ${compareRow("Cloud relay fallback", [cell("5 hrs / mo", "2 concurrent · 1h sessions"), cell("50 hrs / mo", "16 concurrent · 2h sessions"), cell("250 hrs / mo", "64 concurrent · 4h sessions")])}

          <tr class="cat-row"><th colspan="4">Hosted MCP</th></tr>
          ${compareRow("Enabled pages", [cell("1 page"), cell("25 pages"), cell("100 pages")])}
          ${compareRow("Monthly calls", [cell("250 / mo"), cell("15,000 / mo"), cell("100,000 / mo")])}
          ${compareRow("Synced state per page", [cell("50 MB"), cell("500 MB"), cell("2 GB")])}

          <tr class="cat-row"><th colspan="4">Identity, teams &amp; domains</th></tr>
          ${compareRow("Named page subdomains", [no, cell("25 pages", "e.g. my-app.tendriller.dev"), cell("100 pages", "e.g. my-app.tendriller.dev")], "Replace generated subdomains with unique names")}
          ${compareRow("Cloud-connected personal accounts", [no, yes, yes], "Works even when your laptop is asleep")}
          ${compareRow("Team OAuth tie-ins", [no, no, yes], "GitHub Org & Google Workspace admission + auto-offboarding")}
          ${compareRow("Custom page domains", [no, no, cell("Included", "e.g. app.yourteam.com")])}

          <tr class="cat-row"><th colspan="4">Overages &amp; billing</th></tr>
          ${compareRow("Optional pay-as-you-go", [cell("Off", "Falls back to free P2P"), cell("$0.10 / GB video", "$2 / 10k MCP calls · spend cap"), cell("$0.08 / GB video", "$1.50 / 10k MCP calls · spend cap")], "Off by default; editable monthly spend cap")}
        </tbody>
      </table>
    </div>
  </section>

  <section class="pricing-section" aria-labelledby="guarantees-title">
    <div class="pricing-section-head">
      <div>
        <span class="eyebrow"${c("pricing.guarantees.eyebrow", p.guarantees.eyebrow)}>${txt(p.guarantees.eyebrow)}</span>
        <h2 id="guarantees-title"${c("pricing.guarantees.title", p.guarantees.title)}>${txt(p.guarantees.title)}</h2>
      </div>
      <p class="pricing-section-note">${signedIn ? `<a href="/dashboard/billing">Manage billing &amp; usage</a> · ` : ""}<a href="/pricing.md">Machine-readable pricing (.md) →</a></p>
    </div>
    <div class="guarantees-grid">
      ${p.guarantees.items.map((item, i) => `<article class="guarantee-card">
        <span class="g-ico${item.tone ? ` ${item.tone}` : ""}">${icon(item.icon)}</span>
        <h3${c(`pricing.guarantees.items.${i}.title`, item.title)}>${txt(item.title)}</h3>
        <p${c(`pricing.guarantees.items.${i}.body`, item.body)}>${txt(item.body)}</p>
      </article>`).join("\n      ")}
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

  return { body, script, extraCss: PRICING_CSS };
}

export function renderPricingPageHtml(options: {
  signedIn?: boolean;
  currentPlan?: string | null;
  checkoutLive?: boolean;
  editable?: boolean;
} = {}): string {
  const { body, script, extraCss } = renderPricingPage(options);
  return renderShell({ title: "Pricing", body, script, extraCss, width: "wide" });
}

/** Public `/pricing` page comparing Free, Pro, Team, and Self-Hosted transparently. */
export async function pricingPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "method_not_allowed");
  const session = env.ACCOUNTS ? await serviceSession(req, env).catch(() => null) : null;
  const ent = session ? await getAccountEntitlements(env, session.accountId).catch(() => null) : null;
  const checkoutLive = Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCTS_JSON);
  const { body, script, extraCss } = renderPricingPage({
    signedIn: Boolean(session),
    currentPlan: ent?.plan ?? null,
    checkoutLive,
  });
  const response = servicePage("Pricing", body, script, 200, {
    wide: true,
    extraCss,
    formAction: "'self' https://polar.sh https://*.polar.sh",
  });
  return req.method === "HEAD" ? new Response(null, response) : response;
}

export function renderSelfHostBody(origin: string, editable = false): string {
  const host = new URL(origin).hostname;
  const vars = { host, base: origin };
  const s = SITE_COPY.selfHost;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const txt = (t: string) => renderCopyText(t, vars);
  const preStyle = `margin:.4rem 0;padding:.75rem;border-radius:10px;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);overflow-x:auto;font-size:.82rem`;
  const stepSnippets = [
    `git clone https://github.com/werg/tendriller.git &amp;&amp; cd tendriller\nnpm ci &amp;&amp; npm run build`,
    `PRODUCTION_PUBLIC_BASE=https://app.yourdomain.com \\\nPRODUCTION_PAGE_BASE_DOMAIN=pages.yourdomain.com \\\nnode scripts/provision.mjs production --name my-tendriller --fresh`,
    `npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc\nnpx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc \\\n  --command "UPDATE service_state SET mode='open', account_page_cap=NULL, account_resident_cap=NULL, account_storage_cap=NULL WHERE id=1"`,
    `npx wrangler deploy --config server/wrangler.my-tendriller.jsonc`,
    "",
  ];
  return `<section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("terminal")} <span${c("selfHost.hero.eyebrow", s.hero.eyebrow)}>${txt(s.hero.eyebrow)}</span></span><h1${c("selfHost.hero.title", s.hero.title)}>${txt(s.hero.title)}</h1>${(editable || s.hero.lead.trim()) ? `<p class="lead"${c("selfHost.hero.lead", s.hero.lead)}>${txt(s.hero.lead)}</p>` : ""}</div></div>
    <div class="actions" style="margin-top:1rem"><a class="button" href="/docs/SELF_HOSTING.md">${icon("book")} <span${c("selfHost.hero.ctaDoc", s.hero.ctaDoc)}>${txt(s.hero.ctaDoc)}</span></a><a class="button secondary" href="/pricing"><span${c("selfHost.hero.ctaCompare", s.hero.ctaCompare)}>${txt(s.hero.ctaCompare)}</span></a></div></section>

  <section class="card stack-sm">
    <h2${c("selfHost.costs.title", s.costs.title)}>${txt(s.costs.title)}</h2>
    <ul class="list">
      ${s.costs.items.map((item, i) => `<li class="list-item"><div class="list-item-main"><div class="list-item-title"${c(`selfHost.costs.items.${i}.title`, item.title)}>${txt(item.title)}</div><p class="list-item-sub"${c(`selfHost.costs.items.${i}.body`, item.body)}>${txt(item.body)}</p></div></li>`).join("\n      ")}
    </ul>
  </section>

  <section class="card stack-sm">
    <h2${c("selfHost.quickstart.title", s.quickstart.title)}>${txt(s.quickstart.title)}</h2>
    <ol class="steps">
      ${s.quickstart.steps.map((step, i) => `<li><div style="min-width:0;flex:1"><span${c(`selfHost.quickstart.steps.${i}`, step)}>${txt(step)}</span>${stepSnippets[i] ? `<pre style="${preStyle}">${stepSnippets[i]}</pre>` : ""}</div></li>`).join("\n      ")}
    </ol>
  </section>

  <section class="card stack-sm">
    <h2${c("selfHost.comparison.title", s.comparison.title)}>${txt(s.comparison.title)}</h2>
    <ul class="list">
      ${s.comparison.items.map((item, i) => `<li class="list-item"><div class="list-item-main"><div class="list-item-title"${c(`selfHost.comparison.items.${i}.title`, item.title)}>${txt(item.title)}</div><p class="list-item-sub"${c(`selfHost.comparison.items.${i}.body`, item.body)}>${txt(item.body)}</p></div></li>`).join("\n      ")}
    </ul>
    <div class="actions"><a class="button" href="/dashboard/billing"><span${c("selfHost.comparison.ctaBilling", s.comparison.ctaBilling)}>${txt(s.comparison.ctaBilling)}</span></a><a class="button secondary" href="/dashboard"><span${c("selfHost.comparison.ctaDashboard", s.comparison.ctaDashboard)}>${txt(s.comparison.ctaDashboard)}</span></a></div>
  </section>`;
}

export function renderSelfHostPageHtml(origin: string, options?: { editable?: boolean }): string {
  return renderShell({
    title: "Self-host Tendriller",
    body: renderSelfHostBody(origin, Boolean(options?.editable)),
    width: "medium",
  });
}

/** Public `/self-host` page giving users a friendly, first-class self-hosting off-ramp. */
export async function selfHostPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse(405, "method_not_allowed");
  const origin = publicBase(env);
  const response = servicePage("Self-host Tendriller", renderSelfHostBody(origin), "", 200, { medium: true });
  return req.method === "HEAD" ? new Response(null, response) : response;
}

export interface BillingDashboardView {
  accountId: string;
  email: string | null;
  ent: Awaited<ReturnType<typeof getAccountEntitlements>>;
  pagesUsed: number;
  residentsUsed: number;
  agentsUsed: number;
  mcpPagesUsed: number;
  subdomainsUsed?: number;
  storageUsed: number;
  checkoutLive: boolean;
  portalLive: boolean;
  checkoutSuccess?: boolean;
  saved?: boolean;
  editable?: boolean;
}

export function renderBillingDashboardContent(view: BillingDashboardView): { body: string; script: string } {
  const { ent, pagesUsed, residentsUsed, agentsUsed, mcpPagesUsed, subdomainsUsed = 0, storageUsed, checkoutLive, portalLive, accountId, email } = view;
  const editable = Boolean(view.editable);
  const b = SITE_COPY.billing;
  const c = (k: string, t: string) => copyAttrs(k, t, editable);
  const txt = (t: string) => renderCopyText(t);

  const spec = planSpec(ent.plan);
  const sub = ent.subscription;

  const statusBadge = ent.unlimitedHost
    ? `<span class="badge ok">Self-Hosted · Unlimited</span>`
    : ent.inGracePeriod
      ? `<span class="badge warn">Past due · Grace period until ${escape(new Date(sub!.graceUntil!).toISOString().slice(0, 10))}</span>`
      : sub?.cancelAtPeriodEnd && sub.periodEnd
        ? `<span class="badge warn">Cancels ${escape(new Date(sub.periodEnd).toISOString().slice(0, 10))}</span>`
        : `<span class="badge ok">${escape(spec.name)} plan</span>`;

  const alerts: string[] = [];
  if (view.checkoutSuccess) {
    alerts.push(`<p class="notice" role="status">${icon("check")}<span>Checkout completed! Your updated plan entitlements apply automatically as soon as Polar confirms your subscription.</span></p>`);
  }
  if (view.saved) {
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
    meterRow("Named page subdomains", String(subdomainsUsed), ent.quotas.customSubdomains === null ? "Unlimited" : ent.quotas.customSubdomains === 0 ? "Pro & Team" : String(ent.quotas.customSubdomains), ent.quotas.customSubdomains === 0 ? null : ratio(subdomainsUsed, ent.quotas.customSubdomains), `Replace generated page subdomains with memorable names in <a href="/dashboard/domains#subdomains">Domains</a>.`),
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
          <div class="card-head"><div><span class="eyebrow"${c("billing.payg.eyebrow", b.payg.eyebrow)}>${txt(b.payg.eyebrow)}</span><h2${c("billing.payg.title", b.payg.title)}>${txt(b.payg.title)}</h2><p>Stay connected smoothly if you exceed your included ${fmtBytes(ent.quotas.mediaBytesPerMonth ?? 0)} media or ${(ent.quotas.mcpCallsPerMonth ?? 0).toLocaleString("en-US")} hosted MCP calls (${fmtDollars(ent.quotas.paygMediaCentsPerGb)}/GB media · ${fmtDollars(ent.quotas.paygMcpCentsPer10k)}/10k MCP calls).</p></div><span class="badge ${ent.paygEnabled ? "ok" : ""}">${ent.paygEnabled ? "Enabled" : "Off"}</span></div>
          <form method="post" action="/dashboard/billing/payg" class="stack-sm">
            <label class="check-item"><input type="checkbox" name="payg_enabled" value="1"${ent.paygEnabled ? " checked" : ""}><span class="check-copy"><span class="check-title"${c("billing.payg.checkboxTitle", b.payg.checkboxTitle)}>${txt(b.payg.checkboxTitle)}</span><span class="check-desc"${c("billing.payg.checkboxDesc", b.payg.checkboxDesc)}>${txt(b.payg.checkboxDesc)}</span></span></label>
            <div class="field-row">
              <div class="field"><label class="field-label" for="spend-cap-usd">Monthly safety spend cap (USD)</label><input id="spend-cap-usd" name="spend_cap_usd" type="number" min="1" max="10000" step="1" value="${escape(spendCapDollars || String(DEFAULT_PAYG_SPEND_CAP_CENTS / 100))}" placeholder="25"${ent.paygSpendCapCents === null ? " disabled" : ""}></div>
              <div class="field" style="justify-content:flex-end"><label class="check-item" style="margin-top:1.35rem"><input type="checkbox" id="uncapped-payg" name="uncapped" value="1"${ent.paygSpendCapCents === null ? " checked" : ""}><span class="check-copy"><span class="check-title"${c("billing.payg.uncappedTitle", b.payg.uncappedTitle)}>${txt(b.payg.uncappedTitle)}</span><span class="check-desc"${c("billing.payg.uncappedDesc", b.payg.uncappedDesc)}>${txt(b.payg.uncappedDesc)}</span></span></label></div>
            </div>
            <p class="fine">Estimated accrued overage this month: <strong>${fmtDollars(ent.overage.totalCents)}</strong>${ent.paygSpendCapCents !== null ? ` · current cap ${fmtDollars(ent.paygSpendCapCents)}/mo` : " · uncapped"}.</p>
            <div class="actions"><button type="submit" class="sm">Save overage settings</button></div>
          </form>
        </section>`
      : `<section class="card stack-sm" id="payg">
          <div class="card-head"><div><span class="eyebrow"${c("billing.payg.eyebrow", b.payg.eyebrow)}>${txt(b.payg.eyebrow)}</span><h2${c("billing.payg.titleFree", b.payg.titleFree)}>${txt(b.payg.titleFree)}</h2><p${c("billing.payg.leadFree", b.payg.leadFree)}>${txt(b.payg.leadFree)}</p></div><span class="badge">Pro &amp; Team</span></div>
        </section>`;

  const curInterval = sub?.billingInterval ?? "month";
  const isProMonth = ent.plan === "pro" && curInterval === "month";
  const isProYear = ent.plan === "pro" && curInterval === "year";
  const isTeamMonth = ent.plan === "team" && curInterval === "month";
  const isTeamYear = ent.plan === "team" && curInterval === "year";
  const upgradeSection = ent.unlimitedHost ? "" : `<section class="card stack-sm">
    <div class="card-head"><div><span class="eyebrow"${c("billing.plans.eyebrow", b.plans.eyebrow)}>${txt(b.plans.eyebrow)}</span><h2${c("billing.plans.title", b.plans.title)}>${txt(b.plans.title)}</h2><p${c("billing.plans.lead", b.plans.lead)}>${txt(b.plans.lead)}</p></div><a class="button ghost sm" href="/pricing">Compare all plans</a></div>
    ${checkoutLive ? `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div class="card stack-sm"><h3${c("billing.plans.proTitle", b.plans.proTitle)}>${txt(b.plans.proTitle)}</h3><p class="muted" style="font-size:.86rem"${c("billing.plans.proSummary", b.plans.proSummary)}>${txt(b.plans.proSummary)}</p>
        <div class="actions tight">
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="pro"><input type="hidden" name="interval" value="month"><button type="submit" class="sm"${isProMonth ? " disabled" : ""}>${isProMonth ? "Current (Pro Monthly)" : "Pro Monthly"}</button></form>
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="pro"><input type="hidden" name="interval" value="year"><button type="submit" class="secondary sm"${isProYear ? " disabled" : ""}>${isProYear ? "Current (Pro Annual)" : "Pro Annual ($100)"}</button></form>
        </div>
      </div>
      <div class="card stack-sm"><h3${c("billing.plans.teamTitle", b.plans.teamTitle)}>${txt(b.plans.teamTitle)}</h3><p class="muted" style="font-size:.86rem"${c("billing.plans.teamSummary", b.plans.teamSummary)}>${txt(b.plans.teamSummary)}</p>
        <div class="actions tight">
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="team"><input type="hidden" name="interval" value="month"><button type="submit" class="sm"${isTeamMonth ? " disabled" : ""}>${isTeamMonth ? "Current (Team Monthly)" : "Team Monthly"}</button></form>
          <form method="post" action="/dashboard/billing/checkout"><input type="hidden" name="plan" value="team"><input type="hidden" name="interval" value="year"><button type="submit" class="secondary sm"${isTeamYear ? " disabled" : ""}>${isTeamYear ? "Current (Team Annual)" : "Team Annual ($320)"}</button></form>
        </div>
      </div>
    </div>` : `<p class="notice">${icon("sparkles")}<span${c("billing.plans.checkoutDisabled", b.plans.checkoutDisabled)}>${txt(b.plans.checkoutDisabled)}</span></p>`}
    <div class="actions">
      ${portalLive ? `<form method="post" action="/dashboard/billing/portal"><button type="submit" class="secondary sm">${icon("external")} Manage subscription &amp; invoices (Polar Portal)</button></form>` : ""}
      <a class="button ghost sm" href="/self-host">${icon("terminal")} Prefer unlimited? Self-host on Cloudflare</a>
    </div>
  </section>`;

  const subAllowed = ent.unlimitedHost || ent.quotas.customSubdomains === null || ent.quotas.customSubdomains > 0;
  const capabilityBadges = [
    `<span class="badge ${ent.quotas.sfuEnabled ? "ok" : ""}">${ent.quotas.sfuEnabled ? `SFU up to ${ent.quotas.sfuMaxPeers} peers (${ent.quotas.sfuMaxHeight}p)` : "TURN trial (no SFU)"}</span>`,
    `<span class="badge ${ent.quotas.hostBrokeredOAuth ? "ok" : ""}">${ent.quotas.hostBrokeredOAuth ? "Host-brokered personal OAuth" : "Personal OAuth (Pro+)"}</span>`,
    `<span class="badge ${ent.quotas.teamOrgOAuth ? "ok" : ""}">${ent.quotas.teamOrgOAuth ? "Team OAuth tie-ins" : "Team OAuth tie-ins (Team)"}</span>`,
    `<a class="badge ${subAllowed ? "ok" : ""}" href="/dashboard/domains#subdomains" style="text-decoration:none">${subAllowed ? "Named subdomains · Manage" : "Named subdomains (Pro+)"}</a>`,
    `<a class="badge ${ent.quotas.customDomain ? "ok" : ""}" href="/dashboard/domains" style="text-decoration:none">${ent.quotas.customDomain ? "Custom page domains · Manage" : "Custom domains (Team)"}</a>`,
  ].join("");

  const body = `<a class="back-link" href="/dashboard">← Back to dashboard</a>
    <section class="hero dark"><div class="page-head-row"><div><span class="eyebrow">${icon("sparkles")} <span${c("billing.hero.eyebrow", b.hero.eyebrow)}>${txt(b.hero.eyebrow)}</span></span><h1${c("billing.hero.title", b.hero.title)}>${txt(b.hero.title)}</h1><p class="lead">${escape(email ?? accountId)} · ${escape(spec.tagline)}</p></div><div class="actions tight">${statusBadge}</div></div>
      <div class="actions tight" style="margin-top:.85rem;flex-wrap:wrap">${capabilityBadges}</div>
    </section>
    ${alerts.join("")}
    <section class="card stack-sm"><div class="card-head"><div><span class="eyebrow"${c("billing.usage.eyebrow", b.usage.eyebrow)}>${txt(b.usage.eyebrow)}</span><h2${c("billing.usage.title", b.usage.title)}>${txt(b.usage.title)}</h2></div><span class="badge">Period ${escape(ent.usage.period)}</span></div><div class="list">${metersHtml}</div></section>
    ${paygCard}
    ${upgradeSection}`;

  const script = `<script>(()=>{
    const uncapped=document.getElementById('uncapped-payg'), cap=document.getElementById('spend-cap-usd');
    if(uncapped && cap){ uncapped.addEventListener('change',()=>{ cap.disabled=uncapped.checked; }); }
  })()</script>`;

  return { body, script };
}

export function renderBillingDashboardHtml(view: BillingDashboardView): string {
  const { body, script } = renderBillingDashboardContent(view);
  return renderShell({ title: "Billing & quotas", body, script, width: "wide" });
}

async function renderBillingDashboard(req: Request, env: Env, url: URL, accountId: string, email: string | null): Promise<Response> {
  const db = env.ACCOUNTS;
  const [ent, pageStats, agentStats, mcpPageStats, subdomainStats, storageStats] = await Promise.all([
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
    db.prepare("SELECT COUNT(*) AS n FROM page_subdomains WHERE account_id = ?")
      .bind(accountId).first<{ n: number }>().catch(() => null),
    db.prepare("SELECT reserved FROM accounts WHERE id = ?")
      .bind(accountId).first<{ reserved: number }>(),
  ]);

  const { body, script } = renderBillingDashboardContent({
    accountId,
    email,
    ent,
    pagesUsed: pageStats?.pages ?? 0,
    residentsUsed: pageStats?.residents ?? 0,
    agentsUsed: agentStats?.n ?? 0,
    mcpPagesUsed: mcpPageStats?.n ?? 0,
    subdomainsUsed: subdomainStats?.n ?? 0,
    storageUsed: storageStats?.reserved ?? 0,
    checkoutLive: Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCTS_JSON),
    portalLive: Boolean(env.POLAR_ACCESS_TOKEN && (ent.subscription?.customerId || ent.subscription?.subscriptionId)),
    checkoutSuccess: url.searchParams.get("checkout") === "success",
    saved: url.searchParams.get("saved") === "1",
  });

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
