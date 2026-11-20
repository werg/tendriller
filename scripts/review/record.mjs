import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importReviewPackages } from './packages.mjs';
import { chromium } from '@playwright/test';
import { nativeHost } from './codex-host.mjs';
import { reviewError } from './diagnostics.mjs';
import { readWithAdmissionRetry } from './read.mjs';
import { readReviewAccess, authorizeReview } from './access.mjs';
import { preflightReviewDeployment, reviewProvenance } from './preflight.mjs';

export async function recordReview({ project, accessPath, output, composition, video = true, frameMs = 1500 }) {
  project = resolve(project); output = resolve(output);
  const access = readReviewAccess(accessPath), handle = JSON.parse(readFileSync(resolve(project, '.private/handle.json')));
  assert.equal(new URL(handle.api).origin, access.origin);
  const readiness = await preflightReviewDeployment(access.origin, composition, { allowStagingCreationPause: true });
  // The SDK and verifier use the same installed public archives as the native fixture.
  const { core: { createClient }, session: { verifyAuthorityBundle, verifyPublicationManifest } } = await importReviewPackages(project);
  const definition = JSON.parse(readFileSync(new URL('../../integrations/chatgpt/plugin/plugin.json', import.meta.url)));
  const cases = definition.extensions['com.openai'].review.test_cases;
  assert.equal(cases.positive.length, 6, 'Update the qualification when packaged cases change');
  assert.equal(cases.negative.length, 3, 'Update the qualification when packaged cases change');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const report = { passed: false, client: 'Codex app-server MCP', codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
    agentBehaviorEvaluated: false, chatgptWebVerified: false, usesModelTokens: false,
    ...reviewProvenance(composition, readiness), browserApplicationPeerQualified: false, firstAppKitQualified: false,
    denialScope: 'Unlisted application ID rejected; no live second-account fixture is provisioned by this runner',
    origin: access.origin, applicationId: handle.application.id, cases: [], checks: [] };
  const browser = await chromium.launch();
  let client, context, page;
  const recorded = [];
  const present = async (title, prompt, observation) => {
    await page.goto('about:blank');
    await page.setContent('<!doctype html><html><meta charset="utf-8"><title>Tendriller MCP qualification</title><style>body{background:#f4f6f4;color:#16372d;font:20px/1.5 system-ui;margin:0;padding:48px}main{max-width:1160px;margin:auto}small{font-size:16px}h1{font-size:34px;margin:18px 0}pre{background:#fff;border:1px solid #c9d8d0;border-radius:16px;padding:24px;white-space:pre-wrap;font:17px/1.45 ui-monospace;max-height:600px;overflow:hidden}.badge{font-size:15px;background:#164b37;color:white;padding:7px 12px;border-radius:20px;display:inline-block}</style><main><span class="badge">LIVE MCP · CODEX CLIENT</span><h1></h1><p></p><pre></pre><small>Automated deterministic tool execution through the real Codex MCP host. This is not a recording of ChatGPT web or an LLM conversation.</small></main></html>');
    await page.locator('h1').evaluate((node, value) => { node.textContent = value; }, title);
    await page.locator('p').evaluate((node, value) => { node.textContent = value; }, prompt);
    await page.locator('pre').evaluate((node, value) => { node.textContent = value; }, JSON.stringify(observation, null, 2).slice(0, 3800));
    if (video && frameMs) await new Promise(done => setTimeout(done, frameMs));
  };
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(video ? { recordVideo: { dir: resolve(output, 'video'), size: { width: 1440, height: 1000 } } } : {}) });
    const authorized = await authorizeReview(context, access); page = authorized.page;
    if (video) recorded.push(page.video());
    client = await nativeHost({ origin: access.origin, token: authorized.token, cwd: project });
    const server = client.status.data.find(item => item.name === 'tendriller_review');
    assert(server && server.tools.tendril_guide && server.tools.call_application_command);
    report.checks.push('Static reviewer login, live OAuth consent, PKCE and native MCP discovery');
    await present('Selected service MCP connected', access.origin + '/mcp', { client: report.codex, authenticated: server.authStatus, tools: Object.keys(server.tools).sort() });
    const call = async (tool, arguments_ = {}) => {
      const result = await client.call(tool, arguments_);
      report.checks.push(tool);
      return result;
    };
    const app = { applicationId: handle.application.id };
    const positive = async (index, check) => {
      const observation = await check();
      report.cases.push({ kind: 'positive', prompt: cases.positive[index].prompt, passed: true });
      await present('Positive case ' + (index + 1), cases.positive[index].prompt, observation);
    };
    const negative = async (index, check) => {
      const observation = await check();
      report.cases.push({ kind: 'negative', prompt: cases.negative[index].prompt, passed: true });
      await present('Negative case ' + (index + 1), cases.negative[index].prompt, observation);
    };
    const query = async () => {
      const result = await call('query_application', { ...app, query: 'checklist', input: null });
      assert(!result.isError); return result.structuredContent.value;
    };
    await positive(0, async () => {
      const result = await call('list_tendrils'); assert(result.structuredContent.applications.some(item => item.applicationId === app.applicationId));
      return { applications: result.structuredContent.applications };
    });
    await positive(1, async () => {
      const result = await call('describe_application', app); assert(JSON.stringify(result.structuredContent).includes('completeItem'));
      const value = result.structuredContent;
      return { queries: value.queries.map(item => item.name), commands: value.commands.map(item => item.name), events: value.events.map(item => item.name), provider: value.provider };
    });
    await positive(2, async () => { const value = await query(); assert.equal(value.find(item => item.id === 'check-labels').complete, false); return value; });
    const host = createClient(handle, { applicationId: app.applicationId });
    const originalPublication = (await readWithAdmissionRetry(() => host.peers.publication())).publication.id;
    await page.goto(handle.page_url); await page.getByText('Incomplete · Check labels', { exact: true }).waitFor();
    if (video && frameMs) await new Promise(done => setTimeout(done, frameMs));
    let operationId;
    const operationFile = resolve(project, '.private/record-operation.json');
    try { const saved = JSON.parse(readFileSync(operationFile)); assert.equal(saved.applicationId, app.applicationId); operationId = saved.operationId; }
    catch (error) { if (error.code !== 'ENOENT') throw error; operationId = randomUUID(); writeFileSync(operationFile, JSON.stringify({ ...app, operationId }), { flag: 'wx', mode: 0o600, flush: true }); }
    await positive(3, async () => {
      const args = { ...app, command: 'completeItem', input: { id: 'check-labels' }, operationId };
      const result = await call('call_application_command', args); assert(!result.isError);
      const deadline = Date.now() + 20000;
      while (!(await query()).find(item => item.id === 'check-labels').complete) { assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 200)); }
      assert(!(await call('call_application_command', args)).isError);
      return { operationId, outcome: result.structuredContent.outcome, verified: await query(), exactRetryPreservedOperationId: true };
    });
    await positive(4, async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const result = await call('read_application_events', app);
        const events = result.structuredContent.events.filter(event => event.data.payload.id === 'check-labels');
        if (events.length) { assert.equal(events.length, 1); return { retainedEvents: events.map(event => ({ sourceEventId: event.sourceEventId, data: event.data })), duplicateEvents: 0 }; }
        assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 200));
      }
    });
    await positive(5, async () => {
      const result = await call('tendril_guide', { topic: 'start' }); assert(result.structuredContent.text.includes('before asking'));
      const build = await call('tendril_guide', { topic: 'build' }); assert(build.structuredContent.text.includes('npm run init'));
      return { serviceOrigin: result.structuredContent.serviceOrigin, instructions: result.structuredContent.text.slice(0, 1800), buildGuide: build.structuredContent.url };
    });
    const unchanged = await query();
    await negative(0, async () => { const result = await call('call_application_command', { ...app, command: 'deleteAll', input: null, operationId: randomUUID() }); assert(result.isError); return result.structuredContent; });
    await negative(1, async () => { const result = await call('describe_application', { applicationId: 'f'.repeat(64) }); assert(result.isError); return result.structuredContent; });
    await negative(2, async () => {
      assert.deepEqual(await query(), unchanged);
      return { decision: 'Ask which item: Check labels or Check links?', requestedWriteSent: false, stateUnchanged: true };
    });
    const invalid = await call('call_application_command', { ...app, command: 'completeItem', input: {}, operationId: randomUUID() });
    assert(invalid.isError); report.checks.push('Additional server guard rejects malformed input before admission');
    assert.deepEqual(await query(), unchanged);
    const deadline = Date.now() + 20000;
    while ((await readWithAdmissionRetry(() => host.peers.publication())).publication.id === originalPublication) { assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 200)); }
    const authority = await verifyAuthorityBundle(await host.peers.application());
    const publication = await readWithAdmissionRetry(() => host.peers.publication()); await verifyPublicationManifest(publication.publication, authority);
    report.publication = publication.publication.id;
    await page.goto(handle.page_url); await page.getByText('✓ Complete · Check labels', { exact: true }).waitFor();
    await page.reload(); await page.getByText('✓ Complete · Check labels', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, 'verified-page.png'), fullPage: true });
    if (video && frameMs) await new Promise(done => setTimeout(done, frameMs * 2));
    report.checks.push('Signed page publication, exact retry, no duplicate event, rejected writes leave state unchanged, persistence after reload');
    await present('All packaged cases passed', 'Live data and signed publication verified after reload.', { positive: 6, negative: 3, client: report.codex, publication: report.publication, chatgptWebVerified: false });
    const finalReadiness = await preflightReviewDeployment(access.origin, composition, { allowStagingCreationPause: true });
    report.deploymentAtCompletion = reviewProvenance(composition, finalReadiness).deployment;
    report.passed = true;
  } catch (error) {
    report.error = reviewError(error); throw Error('Plugin qualification failed; see the sanitized report.');
  } finally {
    let finalizationError;
    try {
      await client?.close();
      await context?.close();
      // Save while the Playwright transport is still connected, after page/context closure flushes the frames.
      for (const [index, recording] of recorded.entries()) if (recording) await recording.saveAs(resolve(output, index ? `walkthrough-${index}.webm` : 'walkthrough.webm'));
      if (report.passed && video) {
        const bytes = readFileSync(resolve(output, 'walkthrough.webm'));
        report.video = { file: 'walkthrough.webm', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
    } catch (error) {
      finalizationError = error;
      report.passed = false;
      report.recordingError = reviewError(error);
    } finally {
      await browser.close();
      writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    if (finalizationError && !report.error) throw Error('Review evidence could not be finalized; see the sanitized report.');
  }

  return report;
}
