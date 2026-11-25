import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

const voiceAdapter = `
export function createVoice(runtime, handlers) {
  let listening = false, speaking = false, muted = true;
  return {
    get listening() { return listening; }, get speaking() { return speaking; },
    get muted() { return muted; }, language() {},
    async startCapture() { listening = true; handlers.status({kind:'capture',state:'recording'}); return true; },
    finishCapture() { listening = false; handlers.status({kind:'capture',state:'idle'}); },
    cancelCapture() { listening = false; handlers.status({kind:'capture',state:'idle'}); },
    stop() { listening = false; speaking = false; }, mute() { muted = true; },
    async enableOutput() { muted = false; return true; }, speak() {},
    dispose() { listening = false; },
  };
}`;

let origin: string, server: Server;

test.beforeAll(async () => {
  const [chat, utility, agents] = await Promise.all([
    build({
      entryPoints: [new URL('../src/voice/chat.ts', import.meta.url).pathname],
      bundle: true, format: 'esm', platform: 'browser', write: false,
      plugins: [{ name: 'voice-fixture', setup(builder) {
        builder.onResolve({ filter: /^\.\/index$/ }, args => args.importer.endsWith('/voice/chat.ts') ? { path: 'voice-fixture', namespace: 'voice-fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'voice-fixture' }, () => ({ contents: voiceAdapter, loader: 'js' }));
      } }],
    }),
    build({
      entryPoints: [new URL('../src/utility.ts', import.meta.url).pathname],
      bundle: true, format: 'esm', platform: 'browser', write: false,
    }),
    build({
      entryPoints: [new URL('../src/agents.ts', import.meta.url).pathname],
      bundle: true, format: 'esm', platform: 'browser', write: false,
    }),
  ]);

  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/chat.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(chat.outputFiles[0].text); return; }
    if (url === '/utility.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(utility.outputFiles[0].text); return; }
    if (url === '/agents.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(agents.outputFiles[0].text); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Multi-agent UX qualification</title>
      <style>body{margin:0;padding:1rem;font-family:system-ui}</style>
      <main id="app"><h1>Multi-agent fixture</h1></main>
      <script type="module">
        import { mountAgentChat } from '/chat.js';
        import { mountUtility } from '/utility.js';
        import { createAgentsStore } from '/agents.js';

        window.sent = [];
        window.primaryChanges = [];
        window.bannerActions = [];
        window.bannerDismissed = 0;
        window.mcpConnectCalls = [];
        window.mcpDisconnected = [];
        let primaryId = 'ag_atlas';
        let mcpConnected = false;

        const baseAgents = () => [
          { id: 'ag_atlas', handle: 'atlas', bio: 'Primary workspace planner', public_key: 'a'.repeat(64), kind: 'workspace', is_primary: primaryId === 'ag_atlas', granted_at: 1 },
          { id: 'ag_reviewer', handle: 'reviewer', bio: 'Code & data auditor', public_key: 'b'.repeat(64), kind: 'workspace', is_primary: primaryId === 'ag_reviewer', granted_at: 2 },
          ...(mcpConnected ? [{ id: 'mcp:og_1', handle: 'chatgpt', bio: 'Hosted MCP (ChatGPT)', public_key: 'c'.repeat(64), kind: 'hosted-mcp', is_primary: primaryId === 'mcp:og_1', granted_at: 3 }] : []),
        ];

        const origFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const href = String(input);
          if (href.endsWith('_tendril/links')) {
            return Response.json({ name: 'Notes', links: [] });
          }
          if (href.endsWith('_tendril/agents') && (!init.method || init.method === 'GET')) {
            return Response.json({
              primary_agent_id: primaryId,
              agents: baseAgents(),
              can_manage: true,
              dashboard: '/dashboard#agents',
              connections: '/connections',
              account_agents: [
                { id: 'ag_atlas', handle: 'atlas', bio: 'Primary workspace planner', public_key: 'a'.repeat(64), granted: true },
                { id: 'ag_reviewer', handle: 'reviewer', bio: 'Code & data auditor', public_key: 'b'.repeat(64), granted: true },
              ],
            });
          }
          if (href.endsWith('_tendril/agents/primary') && init.method === 'PUT') {
            const body = JSON.parse(init.body);
            primaryId = body.agent_id;
            window.primaryChanges.push(primaryId);
            return Response.json({ primary_agent_id: primaryId, agents: baseAgents() });
          }
          if (href.endsWith('_tendril/mcp/grants')) {
            return Response.json({
              configured: true,
              grants: [{ id: 'og_1', client_id: 'chatgpt', client_name: 'ChatGPT', wrap_public_key: 'd'.repeat(64) }],
              connections: mcpConnected ? [{ grant_id: 'og_1', handle: 'chatgpt', label: 'Notes' }] : [],
            });
          }
          if (href.includes('_tendril/mcp/og_1') && init.method === 'DELETE') {
            mcpConnected = false;
            window.mcpDisconnected.push('og_1');
            return Response.json({ disconnected: true, grant_id: 'og_1' });
          }
          return origFetch(input, init);
        };

        const store = createAgentsStore({
          id: 'pg_multi_test',
          base: '/',
          version: 1,
          documentPath: null,
          application: { id: 'e'.repeat(64) },
          features: { speech: null, shared_by: 'Owner' },
        });
        store.api.registerMcpConnector(async input => {
          window.mcpConnectCalls.push(input);
          mcpConnected = true;
          await store.api.refresh();
          return { connected: true };
        });

        const listeners = new Map();
        const runtime = window.runtime = {
          identity: { page: 'pg_multi_test', base: location.origin + '/', version: 1, publication: null, documentPath: null, managementUrl: location.origin + '/_tendril/manage' },
          agents: store.api,
          installation: { status: () => ({ state: 'unavailable', platform: 'desktop' }), on: () => () => {}, prompt: async () => 'unavailable' },
          publication: { pinned: false, policy: 'live', updateAvailable: false, onUpdate: () => () => {}, hold: () => () => {}, update() {}, saveOffline: async () => {} },
          sensors: { status: () => ({ active: [], pending: [] }), on: () => () => {}, stopAll: () => 0, wakeLock: async () => { throw Error('unavailable'); } },
          capabilities: () => ({}),
          errors: { list: () => [], clear() {} },
          transport: { installed: false, on: () => () => {}, onChange: () => () => {}, report: () => null, refresh: async () => null },
          on(type, fn) { let s = listeners.get(type); if (!s) listeners.set(type, s = new Set()); s.add(fn); return () => s.delete(fn); },
        };

        mountUtility(runtime);
        await store.api.refresh();

        window.chat = mountAgentChat(runtime, {
          title: 'Team chat',
          voiceOutput: false,
          onSend: async input => { window.sent.push(input); },
          onSetPrimary: async id => { await store.api.setPrimary(id); },
        });
        const syncChatRoster = () => {
          const snap = store.api.snapshot();
          window.chat.setRoster({
            primaryId: snap.primary_agent_id,
            canSetPrimary: true,
            agents: snap.agents.map(a => ({
              id: a.id,
              handle: a.handle,
              bio: a.bio,
              publicKey: a.public_key,
              kind: a.kind,
              isPrimary: a.id === snap.primary_agent_id,
              state: a.id === 'ag_atlas' ? 'offline' : 'online',
              enrolled: true,
            })),
          });
        };
        store.api.onChange(syncChatRoster);
        syncChatRoster();
        window.ready = true;
      </script></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('No fixture server address');
  origin = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  if (!server) return;
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
});

test('multi-agent chat supports @handle autocomplete, target chip, concurrent streams, activity drawer and failover banner', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', err => pageErrors.push(String(err)));
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).ready || false, null, { timeout: 5000 }).catch(e => { throw Error(`Boot failed: ${pageErrors.join('; ') || e.message}`); });

  await page.getByRole('button', { name: 'Team chat', exact: true }).click();
  const input = page.getByLabel('Message');
  await expect(input).toBeVisible();

  // Keyboard @handle autocomplete selects @reviewer
  await input.fill('@rev');
  const listbox = page.getByRole('listbox', { name: 'Mention an agent' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toContainText('@reviewer');
  await input.press('Enter');
  await expect(listbox).toBeHidden();
  await expect(input).toHaveValue('@reviewer ');
  await input.fill('@reviewer audit the totals');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).sent)).toEqual([
    { text: '@reviewer audit the totals', via: 'text' },
  ]);

  // Header roster popover picks a direct To: target chip and switches primary
  await page.locator('.target-chip').click();
  const popover = page.locator('.roster-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('@atlas');
  await expect(popover).toContainText('@reviewer');
  await popover.getByRole('button', { name: 'Make primary' }).click();
  expect(await page.evaluate(() => (window as any).primaryChanges)).toEqual(['ag_reviewer']);

  // Select @atlas from roster popover -> shows To: @atlas chip -> send includes target -> switch to @all
  await popover.getByRole('button', { name: 'Message', exact: true }).first().click();
  await expect(page.locator('.target-chip')).toContainText('To: @atlas');
  await input.fill('Ping when back online');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).sent[1])).toEqual({
    text: 'Ping when back online', via: 'text', target: 'ag_atlas',
  });
  await page.locator('.target-chip').click();
  await popover.getByRole('button', { name: 'Message @all' }).click();
  await expect(page.locator('.target-chip')).toContainText('To: @all');

  // Concurrent multi-agent streaming previews render simultaneously
  await page.evaluate(() => {
    (window as any).chat.setStreamingReplies([
      { id: 's1', senderHandle: 'atlas', text: 'Checking budget...' },
      { id: 's2', senderHandle: 'reviewer', text: 'Verifying row totals...' },
    ]);
  });
  await expect(page.locator('.feed')).toContainText('@atlas');
  await expect(page.locator('.feed')).toContainText('Checking budget...');
  await expect(page.locator('.feed')).toContainText('@reviewer');
  await expect(page.locator('.feed')).toContainText('Verifying row totals...');

  // Collapsible Agent activity backchannel drawer
  await page.evaluate(() => {
    (window as any).chat.setActivity([
      { id: 'act1', senderHandle: 'atlas', toHandles: ['reviewer'], text: 'Please audit section 2', at: Date.now() },
    ]);
  });
  const activityDrawer = page.locator('.activity-drawer');
  await expect(activityDrawer).toBeVisible();
  await expect(activityDrawer.locator('summary')).toContainText('Agent activity (1)');
  await expect(page.locator('.activity-list')).toBeHidden();
  await activityDrawer.locator('summary').click();
  await expect(page.locator('.activity-list')).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('@atlas → @reviewer');
  await expect(page.locator('.activity-list')).toContainText('Please audit section 2');

  // Non-blocking failover banner invokes action and supports dismiss
  await page.evaluate(() => {
    (window as any).chat.setBanner({
      kind: 'warning',
      message: '@atlas appears offline. @reviewer is online.',
      actions: [{ id: 'switch', label: 'Switch primary to @reviewer', primary: true }],
      onAction(id: string) { (window as any).bannerActions.push(id); },
      onDismiss() { (window as any).bannerDismissed++; (window as any).chat.setBanner(null); },
    });
  });
  const banner = page.locator('.banner');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Switch primary to @reviewer' }).click();
  expect(await page.evaluate(() => (window as any).bannerActions)).toEqual(['switch']);
  await banner.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(banner).toBeHidden();
  expect(await page.evaluate(() => (window as any).bannerDismissed)).toBe(1);
});

test('Page options -> An agent supports primary selection and one-click Hosted MCP connect/disconnect', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', err => pageErrors.push(String(err)));
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).ready || false, null, { timeout: 5000 }).catch(e => { throw Error(`Boot failed: ${pageErrors.join('; ') || e.message}`); });

  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('tab', { name: 'An agent' }).click();

  // Roster and Hosted MCP grant appear
  await expect(page.locator('.agent-roster').first()).toContainText('@atlas');
  await expect(page.locator('.agent-roster').first()).toContainText('@reviewer');
  const mcpBox = page.locator('.agent-mcp-box');
  await expect(mcpBox).toBeVisible();
  await expect(mcpBox).toContainText('ChatGPT');

  // One-click connect seals keys via registered connector and adds @chatgpt to roster
  await mcpBox.getByRole('button', { name: 'Connect to this page' }).click();
  await expect(mcpBox).toContainText('Connected as @chatgpt');
  expect(await page.evaluate(() => (window as any).mcpConnectCalls)).toEqual([
    expect.objectContaining({ grantId: 'og_1', handle: 'chatgpt' }),
  ]);
  await expect(page.locator('.agent-roster').first()).toContainText('@chatgpt');
  await expect(page.locator('.agent-roster').first()).toContainText('Hosted MCP');

  // Owner can promote @chatgpt to primary from Page options
  const primarySelect = page.getByLabel('Primary agent');
  await primarySelect.selectOption('mcp:og_1');
  expect(await page.evaluate(() => (window as any).primaryChanges.at(-1))).toBe('mcp:og_1');

  // Owner can disconnect immediately
  await mcpBox.getByRole('button', { name: 'Disconnect' }).click();
  await expect(mcpBox).toContainText('Not connected');
  expect(await page.evaluate(() => (window as any).mcpDisconnected)).toEqual(['og_1']);
});
