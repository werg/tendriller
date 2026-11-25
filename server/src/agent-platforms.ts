import { icon, renderShell } from "./accounts/ui";
import { PLATFORM_ICONS } from "./platform-icons";
import { copyAttrs, escapeCopyHtml as escapeHtml, renderCopyPlain, renderCopyText, SITE_COPY } from "./site-copy";

export function platformLogoSvg(slug: string, className = "brand-mark"): string {
  const mark = PLATFORM_ICONS[slug];
  if (!mark) return "";
  return `<svg class="${className}" viewBox="${mark.viewBox}" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false">${mark.body}</svg>`;
}

export function hostFromBase(publicBase: string): string {
  try {
    return new URL(publicBase).host;
  } catch {
    return publicBase.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "tendriller.dev";
  }
}

export interface AgentPlatform {
  slug: keyof typeof SITE_COPY.platforms.items;
  name: string;
  kind: string;
  summary: string;
  connectionMode: "cli-and-mcp" | "agent-url";
  promptTemplate: string;
  stepTemplates: readonly string[];
  prompt: (base: string) => string;
  steps: (host: string, base: string) => string[];
  aiNotes: (base: string) => string[];
}

function makePlatform(
  slug: keyof typeof SITE_COPY.platforms.items,
  name: string,
  connectionMode: "cli-and-mcp" | "agent-url",
  aiNotes: (base: string) => string[],
): AgentPlatform {
  const copy = SITE_COPY.platforms.items[slug];
  return {
    slug,
    name,
    kind: copy.kind,
    summary: copy.summary,
    connectionMode,
    promptTemplate: copy.prompt,
    stepTemplates: copy.steps,
    prompt: (base) => renderCopyPlain(copy.prompt, { base, host: hostFromBase(base) }),
    steps: (host, base) => copy.steps.map((s) => renderCopyPlain(s, { host, base })),
    aiNotes,
  };
}

export const AGENT_PLATFORMS: readonly AgentPlatform[] = [
  makePlatform("claude-code", "Claude Code", "cli-and-mcp", (base) => [
    `You have direct shell access: verify ${base}/api/readiness, ${base}/api/service, and ${base}/.well-known/tendriller.json before downloading the immutable first-app release archive.`,
    `Use Node 24 for the workspace CLI (\`tendril workspace init\`, \`npm run page:new\`, \`npm run init\`, \`npm run deploy\`).`,
    `Prepare and publish the signed UI before asking the owner to sign in. Optionally start \`npm run agent\` if live agent reactions or native inference are needed.`,
  ]),
  makePlatform("codex", "Codex", "cli-and-mcp", (base) => [
    `If connected via Tendriller MCP (${base}/mcp), call \`tendril_guide\` (\`topic: "build"\`) and \`register_agent\` after generating the local key with \`tendril workspace key\`.`,
    `Otherwise start from ${base}/api/readiness, ${base}/api/service, and ${base}/.well-known/tendriller.json, and follow ${base}/docs/BUILD_AN_APP.md end-to-end.`,
    `Deliver the live published URL without waiting for claim first, and verify local durability plus offline reload.`,
  ]),
  makePlatform("meta-muse", "Meta Muse", "agent-url", (base) => [
    `Fetch ${base}/agent.md and ${base}/docs/BUILD_AN_APP.md, then check ${base}/api/readiness before installing packages.`,
    `If your runtime has shell + Node 24, complete the workspace setup and publish the signed UI directly. If sandboxed without persistent shell execution, report the missing capability and hand off the exact commands and ${base} origin.`,
  ]),
  makePlatform("instinct", "Instinct", "agent-url", (base) => [
    `Start at ${base}/api/readiness, ${base}/api/service, and ${base}/.well-known/tendriller.json.`,
    `Follow ${base}/docs/BUILD_AN_APP.md for browser-first publication and ${base}/docs/CAPABILITIES.md for reusable sensor, voice, and reactive view modules.`,
  ]),
  makePlatform("openai-dots", "OpenAI Dots", "cli-and-mcp", (base) => [
    `Account-linked MCP is available at ${base}/mcp (guide: ${base}/docs/MCP_AGENT_GUIDE.md). Domain-first setup starts at ${base}/docs/BUILD_AN_APP.md.`,
    `Always verify ${base}/api/readiness and publish the signed UI before giving the owner the ready page URL.`,
  ]),
  makePlatform("claude-duet", "Claude Duet", "cli-and-mcp", (base) => [
    `Start with ${base}/docs/BUILD_AN_APP.md and ${base}/docs/CAPABILITIES.md (or ${base}/mcp via \`tendril_guide\` if MCP is enabled).`,
    `Use Chronolog reactive views (\`createLiveView\`) so incoming collaborator edits and live agent updates stay coherent without wiping local drafts.`,
  ]),
  makePlatform("grokbot", "GrokBot", "agent-url", (base) => [
    `Read ${base}/api/readiness, ${base}/api/service, ${base}/.well-known/tendriller.json, and ${base}/docs/BUILD_AN_APP.md.`,
    `See ${base}/docs/SENSORS.md and ${base}/docs/AI_INPUT.md for explicit camera, sensor, and reviewed media handling.`,
  ]),
  makePlatform("openclaw", "OpenClaw", "cli-and-mcp", (base) => [
    `One Tendriller agent credential + signing key serves many pages from one workspace; see ${base}/docs/MULTI_PAGE_AGENTS.md.`,
    `Run \`tendril workspace init --owner EMAIL --handle HANDLE\`, publish the signed UI first, and optionally run \`tendril agent run\` as a persistent local companion.`,
  ]),
  makePlatform("hermes", "Hermes", "cli-and-mcp", (base) => [
    `Begin with ${base}/api/readiness, ${base}/api/service, ${base}/.well-known/tendriller.json, and ${base}/docs/BUILD_AN_APP.md.`,
    `Choose \`sql\` or \`events\` profile before installing the immutable release kit, and deliver the verified live page URL.`,
  ]),
];

const BY_SLUG = new Map<string, AgentPlatform>(AGENT_PLATFORMS.map((p) => [p.slug, p]));

export function findAgentPlatform(slug: string): AgentPlatform | null {
  return BY_SLUG.get(slug) ?? null;
}

const PLATFORM_EXTRA_CSS = `
.head-card{display:flex;align-items:flex-start;justify-content:space-between;gap:1.5rem;flex-wrap:wrap;margin-bottom:1.5rem}
.head-title{display:flex;align-items:center;gap:.9rem;margin-bottom:.7rem}
.plat-badge{display:grid;place-items:center;width:3.2rem;height:3.2rem;border-radius:14px;flex:none;background:var(--surface-2);border:1px solid var(--line-strong);color:var(--ink)}
.plat-badge .brand-mark{width:1.55rem;height:1.55rem;display:block;flex:none}
.ai-switch{display:inline-flex;align-items:center;gap:.45rem;padding:.52rem .92rem;border-radius:10px;background:var(--paper-2);border:1px solid var(--line-strong);color:var(--ink);font:650 .85rem/1 var(--mono);text-decoration:none;white-space:nowrap}
.ai-switch:hover{border-color:var(--green);background:var(--green-soft);color:var(--green)}
.grid-2{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:1.25rem;align-items:start}
.prompt-quote{margin:.2rem 0 1rem;padding:1rem 1.1rem;border-radius:11px;background:var(--paper);border:1px solid var(--line);font:500 .9rem/1.6 var(--mono);color:var(--ink);overflow-wrap:anywhere}
.ai-box{margin-top:1.4rem;padding:1.4rem 1.5rem;border-radius:var(--radius);background:linear-gradient(135deg,#142b22 0%,#1c362a 100%);color:var(--stage-ink);border:1px solid rgba(255,244,218,.14);box-shadow:var(--shadow)}
.ai-box h2{color:#fff9ec;margin-bottom:.4rem}
.ai-box p{color:var(--stage-muted);font-size:.94rem;margin:0 0 1rem}
.ai-box code{background:rgba(255,249,236,.1);border-color:rgba(255,249,236,.18);color:#9be6be}
.ai-links{display:flex;flex-wrap:wrap;gap:.55rem}
.ai-links a{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem .8rem;border-radius:9px;background:rgba(255,249,236,.09);border:1px solid rgba(255,249,236,.18);color:#fff9ec;font-size:.86rem;font-weight:640;text-decoration:none}
.ai-links a:hover{background:rgba(255,249,236,.16);border-color:rgba(243,181,68,.6)}
.plat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.9rem;list-style:none;margin:0;padding:0}
.plat-item{display:flex;flex-direction:column;gap:.75rem;padding:1.2rem;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-sm)}
.plat-item-top{display:flex;align-items:center;gap:.7rem}
.plat-item-ico{display:grid;place-items:center;width:2.25rem;height:2.25rem;border-radius:9px;background:var(--surface-2);border:1px solid var(--line);color:var(--muted);flex:none}
.plat-item-ico .brand-mark{width:1.15rem;height:1.15rem;display:block;flex:none}
.plat-item h3{margin:0;font-size:1rem}
.plat-item .kind{font-size:.76rem;color:var(--faint);display:block}
.plat-item p{margin:0;font-size:.88rem;color:var(--muted);line-height:1.45}
.plat-item-links{display:flex;align-items:center;gap:.5rem;margin-top:auto;padding-top:.2rem}
.plat-item-links a{font-size:.83rem;font-weight:660;text-decoration:none;padding:.34rem .68rem;border-radius:8px;border:1px solid var(--line-strong);color:var(--ink);background:var(--surface-2)}
.plat-item-links a:hover{border-color:var(--green);color:var(--green)}
.plat-item-links a.md{font-family:var(--mono);font-size:.78rem;color:var(--muted);background:transparent}
@media(max-width:780px){.grid-2,.plat-grid{grid-template-columns:1fr}}
`;

export function agentPlatformHtml(slug: string, publicBase: string, options?: { editable?: boolean }): string | null {
  const p = findAgentPlatform(slug);
  if (!p) return null;
  const editable = Boolean(options?.editable);
  const base = escapeHtml(publicBase);
  const rawHost = hostFromBase(publicBase);
  const host = escapeHtml(rawHost);
  const vars = { host: rawHost, base: publicBase };
  const c = (key: string, template: string) => copyAttrs(key, template, editable);
  const prompt = p.prompt(publicBase);
  const others = AGENT_PLATFORMS.filter((item) => item.slug !== p.slug);

  const head = `<meta name="description" content="Connect ${escapeHtml(p.name)} to Tendriller — give it a live browser dashboard with sensors, shared database state, and guest invites.">` +
    `<link rel="alternate" type="text/markdown" href="${base}/agents/${p.slug}.md" title="${escapeHtml(p.name)} AI instructions">` +
    `<link rel="service-desc" type="application/json" href="${base}/.well-known/tendriller.json">`;

  const nav = `<nav aria-label="Main navigation">` +
    `<a href="${base}/agents">All platforms</a>` +
    `<a class="hide-xs" href="${base}/docs/BUILD_AN_APP.md">Agent instructions</a>` +
    `<a class="nav-pill" href="/dashboard">Dashboard</a>` +
    `</nav>`;

  const body = `<a class="back-link" href="${base}/">&larr; Back to Tendriller</a>
  <section class="card head-card">
    <div>
      <div class="head-title">
        <span class="plat-badge" aria-hidden="true">${platformLogoSvg(p.slug)}</span>
        <div>
          <span class="eyebrow"${c(`platforms.items.${p.slug}.kind`, p.kind)}>${escapeHtml(p.kind)}</span>
          <h1 style="margin:0">${escapeHtml(p.name)} + Tendriller</h1>
        </div>
      </div>
      <p class="lead"${c(`platforms.items.${p.slug}.summary`, p.summary)}>${renderCopyText(p.summary, vars)}</p>
    </div>
    <a class="ai-switch" href="${base}/agents/${p.slug}.md">AI-friendly Markdown (.md)</a>
  </section>

  <div class="grid-2">
    <section class="card" aria-labelledby="prompt-h">
      <h2 id="prompt-h">1. Copy this prompt into ${escapeHtml(p.name)}</h2>
      <p class="fine" style="margin-bottom:.75rem">Swap in your own email address and describe whatever dashboard, sensors, or shared database you want.</p>
      <p id="prompt-text" class="prompt-quote"${c(`platforms.items.${p.slug}.prompt`, p.promptTemplate)}>${escapeHtml(prompt)}</p>
      <div class="actions tight">
        <button type="button" id="copy-prompt" class="sm">${icon("copy")}<span>Copy prompt</span></button>
        <a class="button secondary sm" href="${base}/agents/${p.slug}.md">Open .md for your agent</a>
        <span class="fine" id="copy-status" role="status" aria-live="polite"></span>
      </div>
    </section>

    <section class="card" aria-labelledby="steps-h">
      <h2 id="steps-h">2. What happens next</h2>
      <ol class="steps">
        ${p.stepTemplates.map((step, i) => `<li><span${c(`platforms.items.${p.slug}.steps.${i}`, step)}>${renderCopyText(step, vars)}</span></li>`).join("")}
      </ol>
    </section>
  </div>

  <section class="ai-box" aria-labelledby="ai-h">
    <h2 id="ai-h">Sending ${escapeHtml(p.name)} directly to a URL?</h2>
    <p>Point ${escapeHtml(p.name)} at the Markdown version of this page or straight to the full agent specification — both are plain text with exact endpoints for <code>${host}</code>.</p>
    <div class="ai-links">
      <a href="${base}/agents/${p.slug}.md">${escapeHtml(p.name)} guide (.md)</a>
      <a href="${base}/docs/BUILD_AN_APP.md">Agent instructions (BUILD_AN_APP.md)</a>
      <a href="${base}/agent.md">Quick reference (/agent.md)</a>
      ${p.connectionMode === "cli-and-mcp" ? `<a href="${base}/docs/MCP_AGENT_GUIDE.md">MCP guide</a>` : ""}
      <a href="${base}/docs/CAPABILITIES.md">Capabilities</a>
    </div>
  </section>

  <section style="margin-top:2rem" aria-labelledby="other-h">
    <h2 id="other-h" style="margin-bottom:.85rem">Other agent platforms</h2>
    <div class="cluster">
      ${others.map((o) => `<a class="button secondary sm" href="${base}/agents/${o.slug}">${escapeHtml(o.name)}</a>`).join("")}
    </div>
  </section>`;

  const footer = `<span>Tendriller</span><span class="foot-links"><a href="${base}/">Home</a><a href="${base}/agents">Platforms</a><a href="/dashboard">Dashboard</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></span>`;

  const script = `<script>
(()=>{
  const text=document.getElementById('prompt-text');
  const btn=document.getElementById('copy-prompt');
  const status=document.getElementById('copy-status');
  if(!text||!btn)return;
  let t;
  btn.addEventListener('click',async()=>{
    try{
      await navigator.clipboard.writeText(text.textContent||'');
      const label=btn.querySelector('span');
      if(label)label.textContent='Copied!';
      if(status)status.textContent='Paste into ${escapeHtml(p.name)} and replace the email.';
      clearTimeout(t);t=setTimeout(()=>{if(label)label.textContent='Copy prompt';},2200);
    }catch{
      const r=document.createRange();r.selectNodeContents(text);
      const s=window.getSelection();s?.removeAllRanges();s?.addRange(r);
      if(status)status.textContent='Selected — press Ctrl/Cmd+C to copy.';
    }
  });
})();
</script>`;

  return renderShell({
    title: `Use ${escapeHtml(p.name)} with Tendriller`,
    rawTitle: true,
    referrer: "",
    width: "medium",
    head,
    extraCss: PLATFORM_EXTRA_CSS,
    nav,
    body,
    footer,
    script,
  });
}

export function agentPlatformMd(slug: string, publicBase: string): string | null {
  const p = findAgentPlatform(slug);
  if (!p) return null;
  const host = hostFromBase(publicBase);
  const lines = [
    `# Getting started with Tendriller from ${p.name}`,
    ``,
    `Tendriller gives ${p.name} a live private web page it can launch and modify on demand — a dashboard the user can talk to, backed by shared local-first database state (Chronolog), optional device sensors (camera, microphone, location, motion, screen, hardware), and private guest invitations.`,
    ``,
    `- Service origin: ${publicBase}`,
    `- Human-friendly guide: ${publicBase}/agents/${p.slug}`,
    `- Full build instructions: ${publicBase}/docs/BUILD_AN_APP.md`,
    `- Agent quick reference: ${publicBase}/agent.md`,
    `- Capability map (UI views, SQL, sensors, voice): ${publicBase}/docs/CAPABILITIES.md`,
    `- Machine discovery JSON: ${publicBase}/.well-known/tendriller.json`,
    `- Live readiness preflight: ${publicBase}/api/readiness`,
    ...(p.connectionMode === "cli-and-mcp" ? [`- Account-linked MCP guide: ${publicBase}/docs/MCP_AGENT_GUIDE.md (${publicBase}/mcp)`] : []),
    ``,
    `## Platform notes for ${p.name}`,
    ``,
    ...p.aiNotes(publicBase).map((note) => `- ${note}`),
    ``,
    `## Standard route`,
    ``,
    `1. Read \`${publicBase}/api/readiness\`, \`${publicBase}/api/service\`, and \`${publicBase}/.well-known/tendriller.json\`. Require \`mode: "open"\` and \`creation.available: true\`.`,
    `2. Follow \`${publicBase}/docs/BUILD_AN_APP.md\` to download the exact immutable starter kit (\`events\` or \`sql\` profile), register the agent once for the owner email, create the page, and publish the signed browser interface before asking the owner to sign in.`,
    `3. Give the user the ready page URL. They sign in via GitHub or Google on their phone, laptop, or tablet; their browser initializes local keys and opens the page immediately.`,
    `4. To invite others, the owner can generate a guest invite link (optionally locked to an email) or a display-only link from the dashboard or page settings.`,
    ``,
    `## Example user prompt`,
    ``,
    `> ${p.prompt(publicBase)}`,
    ``,
    `All platforms: ${publicBase}/agents.md (human index: ${publicBase}/agents on ${host}).`,
    ``,
  ];
  return lines.join("\n");
}

export function agentPlatformIndexHtml(publicBase: string, options?: { editable?: boolean }): string {
  const editable = Boolean(options?.editable);
  const base = escapeHtml(publicBase);
  const rawHost = hostFromBase(publicBase);
  const vars = { host: rawHost, base: publicBase };
  const pl = SITE_COPY.platforms;
  const c = (key: string, template: string) => copyAttrs(key, template, editable);
  const head = `<meta name="description" content="Human and AI-friendly getting-started guides for connecting Claude Code, Codex, Meta Muse, Instinct, OpenAI Dots, Claude Duet, GrokBot, OpenClaw, and Hermes to Tendriller.">` +
    `<link rel="alternate" type="text/markdown" href="${base}/agents.md" title="Agent platforms (Markdown)">` +
    `<link rel="service-desc" type="application/json" href="${base}/.well-known/tendriller.json">`;
  const nav = `<nav aria-label="Main navigation">` +
    `<a href="${base}/">Home</a>` +
    `<a class="hide-xs" href="${base}/docs/BUILD_AN_APP.md">Agent instructions</a>` +
    `<a class="nav-pill" href="/dashboard">Dashboard</a>` +
    `</nav>`;
  const body = `<section class="card head-card">
    <div>
      <span class="eyebrow"${c("platforms.indexEyebrow", pl.indexEyebrow)}>${renderCopyText(pl.indexEyebrow, vars)}</span>
      <h1 style="margin:0"${c("platforms.indexTitle", pl.indexTitle)}>${renderCopyText(pl.indexTitle, vars)}</h1>
      <p class="lead" style="margin-top:.55rem"${c("platforms.indexLead", pl.indexLead)}>${renderCopyText(pl.indexLead, vars)}</p>
    </div>
    <a class="ai-switch" href="${base}/agents.md">All platforms (.md)</a>
  </section>
  <ul class="plat-grid">
    ${AGENT_PLATFORMS.map((p) => `<li class="plat-item">
      <div class="plat-item-top">
        <span class="plat-item-ico" aria-hidden="true">${platformLogoSvg(p.slug)}</span>
        <div><h3>${escapeHtml(p.name)}</h3><span class="kind"${c(`platforms.items.${p.slug}.kind`, p.kind)}>${escapeHtml(p.kind)}</span></div>
      </div>
      <p${c(`platforms.items.${p.slug}.summary`, p.summary)}>${renderCopyText(p.summary, vars)}</p>
      <div class="plat-item-links">
        <a href="${base}/agents/${p.slug}">Human guide</a>
        <a class="md" href="${base}/agents/${p.slug}.md">AI (.md)</a>
      </div>
    </li>`).join("")}
  </ul>`;
  const footer = `<span>Tendriller</span><span class="foot-links"><a href="${base}/">Home</a><a href="${base}/docs/BUILD_AN_APP.md">Agent instructions</a><a href="/dashboard">Dashboard</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></span>`;
  return renderShell({
    title: "Agent platforms",
    referrer: "",
    width: "medium",
    head,
    extraCss: PLATFORM_EXTRA_CSS,
    nav,
    body,
    footer,
  });
}

export function agentPlatformIndexMd(publicBase: string): string {
  return [
    `# Tendriller agent platform guides`,
    ``,
    `Point any agent at ${publicBase} — start with ${publicBase}/docs/BUILD_AN_APP.md (full build instructions) or pick a platform-specific guide below:`,
    ``,
    ...AGENT_PLATFORMS.map((p) => `- **${p.name}** (${p.kind}): [AI guide](${publicBase}/agents/${p.slug}.md) · [Human guide](${publicBase}/agents/${p.slug})`),
    ``,
    `Core discovery:`,
    `- Agent instructions: ${publicBase}/docs/BUILD_AN_APP.md`,
    `- Quick reference: ${publicBase}/agent.md`,
    `- Capability map: ${publicBase}/docs/CAPABILITIES.md`,
    `- Service discovery JSON: ${publicBase}/.well-known/tendriller.json`,
    ``,
  ].join("\n");
}
