// Direct service acceptance; native-client qualification and recording live in scripts/review/.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readReviewAccess } from './review/access.mjs';
import { chromium } from '@playwright/test';
import { createAgentClient } from '../dist/sdk/client.mjs';
import { authorityRecordBytes } from '../contract/authority.mjs';
import { readFixtureHandle } from './review/fixture.mjs';
import { decodeLogGenesis, decodeSignedOperation, verifySignedOperation } from '@chronolog/peer-session';

const project = resolve(process.argv[2]), access = readReviewAccess(process.argv[3]);
// The project is the review fixture's agent workspace: one account credential, one shared signer, one granted page.
const handle = readFixtureHandle(project);
assert.ok(handle.id && handle.page_url && handle.application?.id, 'Run review-app setup first; the workspace has no registered page');
assert.equal(handle.service, access.origin, 'The workspace belongs to another service origin');
const origin = access.origin, resource = `${origin}/mcp`, clientId = 'https://chatgpt.com/oauth/client.json';
const callbackUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const report = { passed: false, chatgptConversationVerified: false, origin, applicationId: handle.application.id, checks: [] };
const browser = await chromium.launch();
const output = resolve(project, 'acceptance');
mkdirSync(output, { recursive: true, mode: 0o700 });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(access.loginUrl); await page.locator('input[name=token]').fill(access.code); await page.getByRole('button', { name: 'Open test account' }).click();
  await page.waitForURL(origin + '/dashboard');
  const discovery = await context.request.get(origin + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(discovery.status(), 200);
  const metadata = await discovery.json();
  assert.equal(metadata.resource, resource);
  assert.ok(Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.length);
  const verifier = randomBytes(32).toString('base64url'), state = randomUUID();
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUri, resource, state,
    response_type: 'code', scope: metadata.scopes_supported.join(' '),
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  let redirect;
  await page.route(url => url.origin === origin && url.pathname === '/oauth/authorize', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch({ maxRedirects: 0 });
    redirect = response.headers().location;
    await route.fulfill({ response, headers: { ...response.headers(), location: callbackUri } });
  });
  await page.route(url => url.origin + url.pathname === callbackUri,
    route => route.fulfill({ contentType: 'text/plain', body: 'Review OAuth callback captured' }));
  await page.goto(origin + '/oauth/authorize?' + params);
  await page.getByRole('button', { name: 'Allow access' }).click();
  await page.waitForURL(callbackUri);
  const callback = new URL(redirect);
  assert.equal(callback.searchParams.get('state'), state); assert.equal(callback.searchParams.get('iss'), origin);
  const response = await context.request.post(origin + '/oauth/token', { form: { grant_type: 'authorization_code',
    client_id: clientId, resource, redirect_uri: callbackUri, code: callback.searchParams.get('code'), code_verifier: verifier } });
  assert.equal(response.status(), 200);
  const { access_token: token } = await response.json();
  report.checks.push('Live magic link, owner consent and PKCE token exchange');
  const call = async (name, args = {}) => {
    const response = await context.request.post(resource, { headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(response.status(), 200);
    return (await response.json()).result;
  };
  const app = { applicationId: handle.application.id };
  const catalog = await call('list_tendrils');
  assert.ok(JSON.stringify(catalog.structuredContent).includes(app.applicationId));
  report.checks.push('List the connected review app');
  const described = await call('describe_application', app);
  assert.ok(JSON.stringify(described.structuredContent).includes('completeItem'));
  report.checks.push('Describe the approved query, command and event');
  const read = async () => (await call('query_application', { ...app, query: 'checklist', input: null })).structuredContent.value;
  const initial = await read();
  assert.equal(initial.find(item => item.id === 'check-labels').complete, false);
  report.checks.push('Read the initial incomplete Check labels item');
  const display = await context.newPage(); await display.goto(handle.page_url);
  await display.getByRole('heading', { name: 'Review checklist' }).waitFor();
  const host = createAgentClient({ service: handle.service, token: handle.token }).page(handle.id, { applicationId: app.applicationId });
  const beforePublication = (await host.peers.publication()).opId;
  const operationRecord = resolve(project, '.tendriller/pages', handle.id, 'acceptance-operation.json');
  let operationId;
  try {
    const saved = JSON.parse(readFileSync(operationRecord, 'utf8'));
    assert.equal(saved.applicationId, app.applicationId);
    operationId = saved.operationId;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    operationId = randomUUID();
    writeFileSync(operationRecord, JSON.stringify({ applicationId: app.applicationId, operationId }), { flag: 'wx', mode: 0o600, flush: true });
  }
  const change = await call('call_application_command', { ...app, command: 'completeItem', input: { id: 'check-labels' }, operationId });
  assert.ok(!change.isError, JSON.stringify(change.structuredContent));
  const deadline = Date.now() + 20000;
  while (!(await read()).find(item => item.id === 'check-labels').complete) {
    assert.ok(Date.now() < deadline, 'Applied change deadline exceeded');
    await new Promise(done => setTimeout(done, 200));
  }
  const exactRetry = await call('call_application_command', { ...app, command: 'completeItem', input: { id: 'check-labels' }, operationId });
  assert.ok(!exactRetry.isError);
  // The signed page is code and independent of data: it stays the original publication while the browser-owned replica converges.
  assert.equal((await host.peers.publication()).opId, beforePublication, 'Data commands must not change the signed publication');
  await display.goto(handle.page_url);
  await display.getByText('✓ Complete · Check labels', { exact: true }).waitFor({ timeout: 60000 });
  report.checks.push('Apply the command, retry its exact ID and see it converge into the browser-owned replica of the unchanged signed page');
  let inbox;
  do {
    inbox = await call('read_application_events', app);
    if (inbox.structuredContent.events.length) break;
    assert.ok(Date.now() < deadline, 'Retained event deadline exceeded');
    await new Promise(done => setTimeout(done, 200));
  } while (true);
  assert.equal(inbox.structuredContent.events.filter(event => event.data.payload.id === 'check-labels').length, 1);
  report.checks.push('Read exactly one retained completion event');
  const beforeDenied = await read();
  assert.ok((await call('call_application_command', { ...app, command: 'deleteAll', input: null, operationId: randomUUID() })).isError);
  assert.ok((await call('describe_application', { applicationId: 'f'.repeat(64) })).isError);
  const ambiguousId = randomUUID();
  const ambiguous = await call('call_application_command', { ...app, command: 'completeItem', input: {}, operationId: ambiguousId });
  const rejected = ambiguous.isError ? ambiguous : await call('wait_application_operation', { ...app, operationId: ambiguousId });
  assert.ok(rejected.isError || rejected.structuredContent.outcome === 'rejected', JSON.stringify(rejected.structuredContent));
  assert.deepEqual(await read(), beforeDenied);
  report.checks.push('Reject deletion, another application and an unspecified item without changing state');
  const finalMetadata = await host.peers.application();
  decodeLogGenesis(authorityRecordBytes(finalMetadata.genesis));
  const publication = await host.peers.publication();
  assert.equal(publication.opId, beforePublication);
  if (publication.op) await verifySignedOperation(decodeSignedOperation(authorityRecordBytes(publication.op)));
  report.publication = publication.opId;
  await display.reload(); await display.getByText('✓ Complete · Check labels', { exact: true }).waitFor();
  await display.screenshot({ path: resolve(output, 'completed-checklist.png'), fullPage: true });
  report.checks.push('Verify the signed publication and retained state after reload');
  report.passed = true;
} finally {
  await browser.close();
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(`Reviewer service acceptance passed. Report saved in ${output}. This is direct service evidence. Use npm run test:plugin:live for native MCP client qualification and recording.`);
