// Qualify the local runner with complete real release artifacts. Browser pairing
// and signed publication remain covered by the separate exact-kit first-app gate.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { startDevHost } from './dev-host.mjs';

const { values } = parseArgs({ options: { artifacts: { type: 'string' } } });
if (!values.artifacts) throw Error('Usage: node scripts/test-dev-host.mjs --artifacts /absolute/release-assets');
const artifacts = resolve(values.artifacts), execute = promisify(execFile);
const manifest = JSON.parse(await readFile(join(artifacts, 'manifest.json'), 'utf8'));
const state = await mkdtemp(join(tmpdir(), 'tendriller-dev-host-smoke-'));
const lifetime = new AbortController();
let running, stage = 'start verified host', forcedExit;
// Leave five seconds for normal browser/runtime disposal before the hard bound.
const deadline = setTimeout(() => {
  process.exitCode = 1; lifetime.abort(Error('DEV_HOST_SMOKE_TIMEOUT'));
  console.error(`Local release host smoke timed out at ${stage}.`);
  void running?.close().catch(() => {});
  forcedExit = setTimeout(() => process.exit(1), 5000);
}, 55_000);

async function start() {
  running = await startDevHost({ release: manifest.source_commit, artifacts, state, port: 8791,
    openBrowser: true, headless: true, signal: lifetime.signal });
  lifetime.signal.throwIfAborted();
  running.browser.setDefaultTimeout(8000); running.browser.setDefaultNavigationTimeout(8000);
  return running.browser.pages()[0];
}

// The preload stays in the native subprocess: its local-only dispatcher must
// never replace Miniflare's own loopback RPC transport in this controller.
async function sdk(handle) {
  const program = `
let text = ''; for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
const { registerAgent, createAgentClient } = await import(input.sdkUrl);
let handle = input.handle;
if (!handle) {
  const { generateKeyPairSync } = await import('node:crypto');
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const agent = await registerAgent(input.serviceOrigin, { owner: input.owner, handle: 'local-host-smoke', publicKey });
  const created = await createAgentClient({ service: input.serviceOrigin, token: agent.token }).pages.create({ name: 'Local host smoke' });
  handle = { ...created, token: agent.token };
}
const agent = createAgentClient({ service: input.serviceOrigin, token: handle.token });
const [self, info] = await Promise.all([agent.self(), agent.page(handle.id).info()]);
process.stdout.write(JSON.stringify({ handle, self, info }));
`;
  const result = execute(process.execPath, ['--import', running.preload, '--input-type=module', '-e', program], {
    timeout: 10_000, maxBuffer: 1024 * 1024, signal: lifetime.signal,
  });
  result.child.stdin.end(JSON.stringify({ handle, serviceOrigin: running.serviceOrigin, owner: running.owner,
    sdkUrl: pathToFileURL(join(state, 'release/dist/sdk/client.mjs')).href, undiciUrl: import.meta.resolve('undici') }));
  return JSON.parse((await result).stdout);
}

async function service(page) {
  // Fetch inside Chromium so its certificate pin, DNS rules and real cookies
  // apply; Playwright's separate API request client does not use those rules.
  const value = await page.evaluate(async () => {
    const read = async path => {
      const response = await fetch(path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('LOCAL_SERVICE_READ_FAILED');
      return response.json();
    };
    return { me: await read('/auth/me'), readiness: await read('/api/readiness') };
  });
  assert.equal(value.me.email, running.owner);
  assert.equal(value.readiness.serviceOrigin, running.serviceOrigin);
  assert.equal(value.readiness.creation.available, true);
  assert.equal(value.readiness.build.sourceCommit, manifest.source_commit);
  assert.equal(value.readiness.build.compositionId, manifest.composition.id);
  assert.equal(value.readiness.build.runtimeId, manifest.runtime);
  return value.me.accountId;
}

async function claimAndCheck(page, handle, accountId) {
  const response = await page.goto(handle.page_url);
  assert(response?.ok()); assert.equal(page.url(), handle.page_url);
  const { self, info } = await sdk(handle);
  assert.equal(self.account.claimed, true, 'Owner sign-in to a created page claims its agent.');
  assert.equal(info.application.id, handle.application.id);
  assert.equal(info.id, handle.id); assert.equal(info.owner_account_id, accountId);
  await page.goto(running.serviceOrigin + '/dashboard');
  assert.equal(await page.locator(`a[href="${handle.page_url}"]`).count() > 0, true);
}

try {
  let page = await start();
  stage = 'owner login';
  await Promise.all([page.waitForURL(running.serviceOrigin + '/dashboard'),
    page.getByRole('button', { name: 'Open test account', exact: true }).click()]);
  const accountId = await service(page);
  stage = 'packed SDK creation and browser owner claim';
  const { handle } = await sdk();
  await claimAndCheck(page, handle, accountId);
  stage = 'public release documentation and assets';
  const served = await page.evaluate(async runtime => Promise.all([
    '/docs/BUILD_AN_APP.md', `/_tendril/runtime/${runtime}/kernel.mjs`,
  ].map(async path => {
    const response = await fetch(path, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  })), manifest.runtime);
  assert(served.every(value => value.status === 200 && value.bytes > 0));
  stage = 'persistent host restart';
  await running.close(); running = undefined;
  page = await start();
  // Before using the freshly printed login token, prove the original session
  // cookie, account and page survived both browser and host process restarts.
  assert.equal(await service(page), accountId);
  await claimAndCheck(page, handle, accountId);
  console.log('Local release host smoke passed: verified source/composition, synthetic owner login, packed SDK creation, browser claim, public assets, and retained account/page/browser state.');
  console.log('Pairing and signed publication are qualified separately by the exact first-app kit tests.');
} catch (error) {
  // Browser errors and child diagnostics may contain private page or login URLs.
  console.error(`Local release host smoke failed at ${stage} (${error?.name ?? 'Error'}).`);
  process.exitCode = 1;
} finally {
  try { await running?.close(); }
  finally { await rm(state, { recursive: true, force: true }); clearTimeout(deadline); clearTimeout(forcedExit); }
}
