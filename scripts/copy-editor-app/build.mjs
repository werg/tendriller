import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_PREVIEW_PLUGINS = [
  {
    name: 'stub-worker-and-wasm',
    setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'tce-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'tce-stub' }, () => ({
        contents: 'export class DurableObject { constructor() {} }',
        loader: 'js',
      }));
      build.onLoad({ filter: /\.wasm$/ }, () => ({
        contents: 'export default null;',
        loader: 'js',
      }));
    },
  },
];

/**
 * Compiles Tendriller's actual live server renderers from `server/src/*.ts` + `server/src/site-copy.json`
 * and returns the full editable catalog of site pages (public, platform guides, dashboard/account,
 * and page/system flows) so the user can click around and edit copy across the entire project.
 */
export async function renderEditableSitePages({ repoRoot, displayOrigin, bundle }) {
  const cleanOrigin = displayOrigin.replace(/\/+$/, '');
  const displayHost = new URL(cleanOrigin).host;

  const siteBundle = await bundle({
    stdin: {
      contents: `
        export { landingPage } from "./server/src/landing.ts";
        export { AGENT_PLATFORMS, agentPlatformHtml, agentPlatformIndexHtml } from "./server/src/agent-platforms.ts";
        export { signInBody } from "./server/src/accounts/auth.ts";
        export { renderShell } from "./server/src/accounts/ui.ts";
        export { renderPageAuthPromptHtml, renderMissingPageHtml, renderQuotaLimitHtml } from "./server/src/accounts/page.ts";
        export { renderDashboardHtml, renderPageActivityHtml } from "./server/src/accounts/keys.ts";
        export { renderOAuthConnectionsHtml } from "./server/src/accounts/oauth-connections.ts";
        export { renderPricingPageHtml, renderSelfHostPageHtml, renderBillingDashboardHtml } from "./server/src/billing/routes.ts";
        export { PLANS, currentUsagePeriod } from "./server/src/billing/plans.ts";
        export { renderCustomDomainsHtml } from "./server/src/custom-domains.ts";
        export { renderConnectionsPageHtml } from "./server/src/mcp-gateway.ts";
        export { renderPageManagementHtml, renderPageDeletedHtml } from "./server/src/management.ts";
        export { renderReportPageHtml } from "./server/src/abuse/report.ts";
        export { renderStatusPageHtml } from "./server/src/router.ts";
      `,
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: NODE_PREVIEW_PLUGINS,
  });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(siteBundle.outputFiles[0].text).toString('base64'));
  const rewriteBrand = (html) =>
    html
      .replaceAll('/sample-page/_tendril/brand/', './brand/')
      .replaceAll('/_tendril/brand/', './brand/');

  const sampleEmail = 'alex@example.com';
  const sampleFirstName = 'Alex';
  const samplePageId = 'kitchen2026a';
  const samplePage2Id = 'tracker2026b';
  const samplePageUrl = `${cleanOrigin}/sample-page/`;
  const sampleNow = Date.now();
  const samplePeriod = mod.currentUsagePeriod(sampleNow);

  const sampleDashboard = {
    origin: cleanOrigin,
    who: sampleEmail,
    email: sampleEmail,
    planName: 'Free',
    planId: 'free',
    unlimitedHost: false,
    inGracePeriod: false,
    limits: { pages: 20, residents: 20, agents: 5 },
    mcpUsage: { calls: 42, cap: 250 },
    tendrils: [
      { id: samplePageId, lifetime: 'resident', state: 'active', created_at: sampleNow - 86_400_000 * 5 },
      { id: samplePage2Id, lifetime: 'ad_hoc', state: 'active', created_at: sampleNow - 86_400_000 * 2 },
    ],
    summaries: [
      {
        name: 'Kitchen Companion',
        page_url: samplePageUrl,
        icon: '🍳',
        theme_color: '#165c43',
        version: 4,
        held: false,
        bytes: 1_840_000,
        agents: 1,
        guests_waiting: 0,
        last_activity: { ts: sampleNow - 18 * 60_000, summary: 'Published v4' },
      },
      {
        name: 'Team Sprint Tracker',
        page_url: samplePageUrl,
        icon: '📋',
        theme_color: '#df5f32',
        version: 2,
        held: false,
        bytes: 940_000,
        agents: 1,
        guests_waiting: 1,
        last_activity: { ts: sampleNow - 120 * 60_000, summary: 'Guest link created' },
      },
    ],
    agents: [
      {
        id: 'ag_sampleagent0000000000000001',
        handle: 'atlas',
        bio: 'Personal workspace builder',
        grants: 2,
        created_at: sampleNow - 86_400_000 * 14,
      },
    ],
    grants: new Map([
      [samplePageId, new Set(['ag_sampleagent0000000000000001'])],
      [samplePage2Id, new Set(['ag_sampleagent0000000000000001'])],
    ]),
    editable: true,
  };

  const sampleEntitlements = {
    plan: 'free',
    unlimitedHost: false,
    quotas: mod.PLANS.free.quotas,
    subscription: null,
    inGracePeriod: false,
    paygEnabled: false,
    paygSpendCapCents: 2500,
    usage: {
      period: samplePeriod.period,
      resetsAt: samplePeriod.resetsAt,
      mcpCalls: 42,
      mediaBytes: 120 * 1024 * 1024,
      relayMs: 1_800_000,
    },
    overage: { mediaCents: 0, mcpCents: 0, totalCents: 0, mediaOverageBytes: 0, mcpOverageCalls: 0 },
  };

  const baseVars = { host: displayHost, base: cleanOrigin };

  const pages = [
    // Public pages
    {
      group: 'Public',
      path: '/',
      label: 'Home',
      vars: baseVars,
      html: rewriteBrand(mod.landingPage(cleanOrigin, { editable: true })),
    },
    {
      group: 'Public',
      path: '/pricing',
      label: 'Pricing',
      vars: baseVars,
      html: rewriteBrand(mod.renderPricingPageHtml({ signedIn: false, checkoutLive: true, editable: true })),
    },
    {
      group: 'Public',
      path: '/self-host',
      label: 'Self-host',
      vars: baseVars,
      html: rewriteBrand(mod.renderSelfHostPageHtml(cleanOrigin, { editable: true })),
    },
    {
      group: 'Public',
      path: '/status',
      label: 'Service status',
      vars: baseVars,
      html: rewriteBrand(mod.renderStatusPageHtml({
        mode: 'open',
        broadcasts: [
          {
            kind: 'announcement',
            severity: 'info',
            title: 'Chronolog v2 live across all pages',
            summary: 'Zero-build SQLite-CAS reducers and peer blob recovery are enabled.',
            docs_url: `${cleanOrigin}/changelog.md`,
          },
        ],
        editable: true,
      })),
    },
    {
      group: 'Public',
      path: '/auth',
      label: 'Sign in',
      vars: baseVars,
      html: rewriteBrand(mod.renderShell({ title: 'Sign in', body: mod.signInBody('/dashboard', true) })),
    },

    // Platform guides
    {
      group: 'Platform guides',
      path: '/agents',
      label: 'Platforms index',
      vars: baseVars,
      html: rewriteBrand(mod.agentPlatformIndexHtml(cleanOrigin, { editable: true })),
    },
    ...mod.AGENT_PLATFORMS.map((p) => ({
      group: 'Platform guides',
      path: `/agents/${p.slug}`,
      label: p.name,
      vars: { ...baseVars, name: p.name },
      html: rewriteBrand(mod.agentPlatformHtml(p.slug, cleanOrigin, { editable: true })),
    })),

    // Account & Dashboard
    {
      group: 'Account & Dashboard',
      path: '/dashboard',
      label: 'Dashboard',
      vars: { ...baseVars, plan: 'Free', name: sampleFirstName, who: sampleEmail },
      html: rewriteBrand(mod.renderDashboardHtml(sampleDashboard)),
    },
    {
      group: 'Account & Dashboard',
      path: '/dashboard/empty',
      label: 'Dashboard (empty state)',
      vars: { ...baseVars, plan: 'Free', name: sampleFirstName, who: sampleEmail },
      html: rewriteBrand(mod.renderDashboardHtml({
        ...sampleDashboard,
        tendrils: [],
        summaries: [],
        agents: [],
        grants: new Map(),
      })),
    },
    {
      group: 'Account & Dashboard',
      path: '/dashboard/billing',
      label: 'Billing & quotas',
      vars: baseVars,
      html: rewriteBrand(mod.renderBillingDashboardHtml({
        accountId: 'acc_sample',
        email: sampleEmail,
        ent: sampleEntitlements,
        pagesUsed: 2,
        residentsUsed: 1,
        agentsUsed: 1,
        mcpPagesUsed: 1,
        storageUsed: 2_780_000,
        checkoutLive: true,
        portalLive: false,
        editable: true,
      })),
    },
    {
      group: 'Account & Dashboard',
      path: '/dashboard/domains',
      label: 'Custom domains (Team)',
      vars: { ...baseVars, pageDomain: displayHost, fallbackTarget: displayHost },
      html: rewriteBrand(mod.renderCustomDomainsHtml({
        allowed: true,
        fallbackTarget: displayHost,
        pageBaseDomain: displayHost,
        domains: [
          {
            hostname: 'tracker.yourteam.com',
            account_id: 'acc_sample',
            tendril_id: samplePage2Id,
            status: 'active',
            cf_hostname_id: null,
            verification_txt_name: null,
            verification_txt_value: null,
            ssl_status: 'active',
            last_error: null,
            created_at: sampleNow - 86_400_000 * 3,
            verified_at: sampleNow - 86_400_000 * 3,
            updated_at: sampleNow - 86_400_000 * 3,
          },
        ],
        availablePages: [{ id: samplePageId }],
        editable: true,
      })),
    },
    {
      group: 'Account & Dashboard',
      path: '/dashboard/domains/upsell',
      label: 'Custom domains (Free upsell)',
      vars: { ...baseVars, pageDomain: displayHost, fallbackTarget: displayHost },
      html: rewriteBrand(mod.renderCustomDomainsHtml({
        allowed: false,
        fallbackTarget: displayHost,
        pageBaseDomain: displayHost,
        domains: [],
        availablePages: [],
        editable: true,
      })),
    },
    {
      group: 'Account & Dashboard',
      path: '/connections',
      label: 'Connections & Assistants',
      vars: baseVars,
      html: rewriteBrand(mod.renderConnectionsPageHtml({
        showMcpSection: true,
        mcpPages: [],
        external: {
          baseOrigin: cleanOrigin,
          connections: [],
          groups: [],
          customProviders: [],
          builtinProviders: [
            { id: 'github', name: 'GitHub', configured: true },
            { id: 'google', name: 'Google', configured: true },
            { id: 'linear', name: 'Linear', configured: false },
            { id: 'notion', name: 'Notion', configured: false },
            { id: 'slack', name: 'Slack', configured: false },
          ],
          editable: true,
        },
        editable: true,
      })),
    },
    {
      group: 'Account & Dashboard',
      path: '/oauth/connections',
      label: 'OAuth clients',
      vars: baseVars,
      html: rewriteBrand(mod.renderOAuthConnectionsHtml({
        grants: [],
        editable: true,
      })),
    },
    {
      group: 'Account & Dashboard',
      path: '/dashboard/activity',
      label: 'Page activity',
      vars: baseVars,
      html: rewriteBrand(mod.renderPageActivityHtml({
        id: samplePageId,
        events: [
          { ts: sampleNow - 18 * 60_000, kind: 'publication', summary: 'Published signed version 4' },
          { ts: sampleNow - 3600_000 * 4, kind: 'admission', summary: 'Admitted browser device' },
        ],
        editable: true,
      })),
    },

    // Page & System flows
    {
      group: 'Page & System flows',
      path: '/_tendril/manage',
      label: 'Page settings (_tendril/manage)',
      vars: baseVars,
      html: rewriteBrand(mod.renderPageManagementHtml({
        tid: samplePageId,
        rawName: 'Kitchen Companion',
        base: '/sample-page/',
        publicBase: cleanOrigin,
        owner: true,
        role: 'owner',
        ownerUrl: samplePageUrl,
        currentVersion: 4,
        lifetime: 'resident',
        tab: 'device',
        pendingGuests: 0,
        primaryAgentId: 'ag_sampleagent0000000000000001',
        rosterAgents: [
          {
            id: 'ag_sampleagent0000000000000001',
            handle: 'atlas',
            bio: 'Personal workspace builder',
            kind: 'workspace',
            is_primary: true,
            origin: 'Created this page',
          },
        ],
        accountAgents: [
          {
            id: 'ag_sampleagent0000000000000001',
            handle: 'atlas',
            bio: 'Personal workspace builder',
            grants: 2,
            checked: true,
          },
        ],
        shareLinks: [],
        versions: [
          { version: 4, message: 'Add hands-free recipe timer' },
          { version: 3, message: 'Initial SQL shopping list' },
        ],
        now: sampleNow,
        editable: true,
      })),
    },
    {
      group: 'Page & System flows',
      path: '/auth/page',
      label: 'Page claim (owner sign-in)',
      vars: baseVars,
      html: rewriteBrand(mod.renderPageAuthPromptHtml({
        role: 'owner',
        expected: sampleEmail,
        editable: true,
      })),
    },
    {
      group: 'Page & System flows',
      path: '/auth/page/guest',
      label: 'Guest invitation sign-in',
      vars: baseVars,
      html: rewriteBrand(mod.renderPageAuthPromptHtml({
        role: 'guest',
        expected: null,
        editable: true,
      })),
    },
    {
      group: 'Page & System flows',
      path: '/auth/page/quota',
      label: 'Page quota limit',
      vars: baseVars,
      html: rewriteBrand(mod.renderQuotaLimitHtml('Your account can keep up to 20 active pages on its current plan.', true)),
    },
    {
      group: 'Page & System flows',
      path: '/auth/page/missing',
      label: 'Missing / retired page',
      vars: { ...baseVars, id: samplePageId },
      html: rewriteBrand(mod.renderMissingPageHtml(samplePageId, true)),
    },
    {
      group: 'Page & System flows',
      path: '/report',
      label: 'Report a page',
      vars: baseVars,
      html: rewriteBrand(mod.renderReportPageHtml({ editable: true })),
    },
  ];

  return { displayOrigin: cleanOrigin, displayHost, pages };
}

/**
 * Builds the genuine Tendriller copy-editor page into `dist/`.
 * Reducers live in `$reducers` CAS (zero separate `domain.js`).
 */
export async function buildPage(context, { root = new URL('./', import.meta.url), bundle } = {}) {
  const output = new URL('./dist/', root);
  await rm(output, { recursive: true, force: true });
  try {
    const prepared = await context.readPrivate('prepared.json');
    if (
      prepared.applicationId !== context.page.applicationId ||
      prepared.publisherKey !== context.signer.publicKey
    ) {
      throw Error('Resume preparation for this exact workspace page; no native initialization is required');
    }
    const pageUrl = new URL(context.page.pageUrl);
    if (!['https:', 'http:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password || pageUrl.search || pageUrl.hash) {
      throw Error('Invalid public page URL');
    }

    const repoRoot = process.env.TENDRILLER_REPO_ROOT
      ? resolve(process.env.TENDRILLER_REPO_ROOT)
      : resolve(fileURLToPath(root), '../../../..');
    const displayOrigin = (process.env.TENDRILLER_COPY_DISPLAY_ORIGIN || 'https://tendriller.dev').replace(/\/+$/, '');

    const siteBundleData = await renderEditableSitePages({ repoRoot, displayOrigin, bundle });

    await mkdir(output, { recursive: true });
    await mkdir(new URL('./brand/', output), { recursive: true });
    const brandSrc = join(repoRoot, 'server/public/_tendril/brand');
    for (const asset of ['logo.webp', 'logo.png', 'icon-64.png', 'icon-180.png']) {
      const from = join(brandSrc, asset);
      if (existsSync(from)) await copyFile(from, new URL(`./brand/${asset}`, output));
    }

    await writeFile(new URL('site-pages.json', output), JSON.stringify(siteBundleData));

    await writeFile(
      new URL('configuration.json', output),
      JSON.stringify({
        applicationId: context.page.applicationId,
        page_url: context.page.pageUrl,
        serviceOrigin: context.service,
        pageId: context.page.id,
        agentPublicKey: context.signer.publicKey,
      }, null, 2) + '\n',
    );

    await copyFile(new URL('index.html', root), new URL('index.html', output));
    await bundle({
      absWorkingDir: fileURLToPath(root),
      entryPoints: { page: 'page.mjs', worker: 'worker.mjs' },
      outdir: fileURLToPath(output),
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outExtension: { '.js': '.mjs' },
      chunkNames: 'chunks/[name]-[hash]',
      assetNames: 'assets/[name]-[hash]',
      loader: { '.wasm': 'file' },
    });
    return fileURLToPath(output);
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw new Error(`Page build failed; no publishable dist/ remains. ${cause.message}`, { cause });
  }
}
