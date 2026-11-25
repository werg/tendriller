import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_SLUG, createReviewPage, registerAgentThroughMcp } from '../../plugin/review-setup.mjs';
import { cleanupFixturePage, readFixtureHandle } from '../review/fixture.mjs';

const service = 'https://selected.example', agent = { id: 'ag_' + 'a'.repeat(26) }, other = 'f'.repeat(64);
const listed = (id, applicationId, extra = {}) => ({ id, name: 'Review checklist', page_url: `https://${id}.pages.example/`, api: `${service}/api/agent/pages/${id}`, application: { id: applicationId }, scopes: [], ...extra });

test('the fixture names only its slug and title; page creation, intent and recovery belong to the central workspace helper', async () => {
  const calls = [], signal = AbortSignal.timeout(1000);
  const workspace = { async createPage(...args) { calls.push(args); return { id: 'bbbbbbbbbbbb' }; } };
  assert.equal(REVIEW_SLUG, 'review');
  assert.deepEqual(await createReviewPage(workspace, 'Review checklist', { signal }), { id: 'bbbbbbbbbbbb' });
  // No application ID, mode, owner or name-based recovery option is supplied by the fixture.
  assert.deepEqual(calls, [['review', { name: 'Review checklist' }, { signal }]]);
});

test('the linked-account register_agent request is a plain bearer JSON-RPC call and a refusal exposes nothing private', async () => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, init }); return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { token: 'ta_' + 'a'.repeat(32), agent: { id: agent.id } } } }); };
  const result = await registerAgentThroughMcp(service, 'PRIVATE_OAUTH', { name: 'review-fixture', publicKey: 'A'.repeat(43) }, { fetch });
  assert.equal(result.agent.id, agent.id); assert.equal(requests[0].url, service + '/mcp');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer PRIVATE_OAUTH'); assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body).params, { name: 'register_agent', arguments: { name: 'review-fixture', publicKey: 'A'.repeat(43) } });
  for (const refused of [Response.json({ error: { code: -32000 } }), Response.json({ result: { isError: true } }), new Response('nope', { status: 403 })])
    await assert.rejects(registerAgentThroughMcp(service, 'PRIVATE_OAUTH', {}, { fetch: async () => refused }), error => error.message === 'The linked account refused register_agent' && !error.message.includes('PRIVATE_OAUTH'));
});

test('cleanup of an uncertain creation deletes only the page with the exact retained application ID', async t => {
  const project = mkdtempSync(join(tmpdir(), 'review-uncertain-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.tendriller/agent'), { recursive: true });
  const token = 'ta_' + 'a'.repeat(32), applicationId = '12'.repeat(32);
  writeFileSync(join(project, '.tendriller/agent/credential.json'), JSON.stringify({ service, token, publicKey: 'ab'.repeat(32), agent }));
  writeFileSync(join(project, 'tendriller.json'), JSON.stringify({ schemaVersion: 1, service, pages: {} }));
  mkdirSync(join(project, '.tendriller/page-intents/review'), { recursive: true });
  writeFileSync(join(project, '.tendriller/page-intents/review/intent.json'), JSON.stringify({ schemaVersion: 1, service, agentId: agent.id, applicationId, name: 'Review checklist' }));
  assert.equal(readFixtureHandle(project).intendedApplicationId, applicationId);
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push((options.method ?? 'GET') + ' ' + url);
    if (url.startsWith(service + '/api/agent/pages?') || url === service + '/api/agent/pages')
      return Response.json({ pages: [listed('cccccccccccc', other), listed('bbbbbbbbbbbb', applicationId)], next_cursor: null });
    return new Response(null, { status: 204 });
  };
  assert.deepEqual(await cleanupFixturePage({ project, origin: service, creationAttempted: true, fetch }), []);
  assert.deepEqual(calls.filter(call => call.startsWith('DELETE')), ['DELETE ' + service + '/api/agent/pages/bbbbbbbbbbbb', 'DELETE ' + service + '/api/agent']);
});
