import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOAuthVerifier } from '../auth.mjs';
import { createSessionBridge } from '../bridge.mjs';
import { createConsentService } from '../consent.mjs';
import { createOutbox } from '../outbox.mjs';
import { createMcpHandler } from '../server.mjs';
import { openDeliveryStore } from '../store.mjs';
import { createSubscriptions, selectedTail } from '../subscriptions.mjs';
import { kitchenEventProjection } from '../examples/kitchen/projection.mjs';
import { createNativeFixture, loadNativePackage } from './native-fixture.mjs';

// The native stores, signed attempts, replication, OAuth cryptography, MCP
// handler, consent and encrypted delivery database below are real. JWKS hosting
// and the callback receiver are explicitly injected test transports. This is
// not evidence of a live ChatGPT subscription, public HTTPS, browser UI or RTC.
test('native kitchen request traverses authenticated MCP and durable signed delivery, then replies across two peers',
  { skip: !process.env.CHRONOLOG_SESSION_PACKAGE, timeout: 45000 }, async () => {
    const { packagePath } = await loadNativePackage();
    const directory = await mkdtemp(join(tmpdir(), 'tendriller-roundtrip-'));
    const applicationId = 'e'.repeat(64), issuer = 'https://identity.example.test';
    const resource = 'https://integration.example.test/mcp';
    const scopes = ['tendrils:list', 'applications:read', 'applications:write', 'events:subscribe'];
    const databasePath = join(directory, 'delivery.sqlite'), databaseKey = randomBytes(32);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'roundtrip-key', alg: 'EdDSA', use: 'sig' };
    const token = (subject, granted = scopes) => {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: jwk.kid, typ: 'at+jwt' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: resource, sub: subject,
        exp: Math.floor(Date.now() / 1000) + 3600, scope: granted.join(' ') })).toString('base64url');
      const body = `${header}.${claims}`;
      return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
    };
    const aliceToken = token('alice'), bobToken = token('bob'), readOnlyToken = token('alice', ['applications:read']);
    const callbackSecrets = new Map([
      ['https://callback.example.test/help', `whsec_${randomBytes(32).toString('base64')}`],
      ['https://callback.example.test/inventory', `whsec_${randomBytes(32).toString('base64')}`],
    ]);
    const challenges = [], deliveries = [];
    let fixture, bridge, store, runtime, rpcId = 0;
    const accountAccess = (principal, id) => principal.id === 'alice' && principal.issuer === issuer && id === applicationId;
    async function syntheticReceiver(url, { body, headers }) {
      const secret = callbackSecrets.get(url);
      assert.ok(secret, 'Only the two explicitly configured test callbacks may receive data');
      assert.ok(headers['X-MCP-Subscription-Id']);
      assert.match(headers['webhook-timestamp'], /^\d+$/);
      // Independently verify the Standard Webhooks wire signature, not a call
      // back into the production signing helper.
      const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
      assert.ok(headers['webhook-signature'].split(' ').includes(`v1,${expected}`));
      const envelope = JSON.parse(body);
      if (envelope.type === 'verification') {
        challenges.push({ url, subscriptionId: headers['X-MCP-Subscription-Id'] });
        assert.ok(envelope.challenge.length >= 32);
        return { status: 200, body: JSON.stringify({ challenge: envelope.challenge }) };
      }
      assert.equal(envelope.eventId, headers['webhook-id']);
      deliveries.push({ url, body, envelope, subscriptionId: headers['X-MCP-Subscription-Id'] });
      return { status: 202, body: '' };
    }
    function compose() {
      const auth = createOAuthVerifier({ issuer, resource, jwksUri: `${issuer}/jwks`, scopesSupported: scopes,
        fetch: async (url, options) => {
          assert.equal(url, `${issuer}/jwks`); assert.equal(options.redirect, 'error');
          return Response.json({ keys: [jwk] });
        },
      });
      const consent = createConsentService({ store, authorizeOwner: accountAccess });
      const authorizeEvent = async (principal, id, name) => {
        if (!accountAccess(principal, id)) throw Object.assign(Error('Account access denied'), { status: 403, code: 'ACCOUNT_ACCESS_DENIED' });
        await consent.assertAccess(principal, { applicationId: id, kind: 'event', name });
        await bridge.getStatus(id); // Refresh actual signed native authority.
      };
      const subscriptions = createSubscriptions({ store, authorize: authorizeEvent,
        applicationIds: async principal => accountAccess(principal, applicationId) ? [applicationId] : [],
        captureCursor: id => selectedTail(bridge, id), send: syntheticReceiver });
      const outbox = createOutbox({ store, bridge, authorize: authorizeEvent, send: syntheticReceiver });
      subscriptions.onChange(() => { void outbox.cancelInactive(); });
      const handler = createMcpHandler({ auth, bridge, consent, subscriptions, outbox, store, resource,
        authorizeAccountAccess: accountAccess });
      return { auth, consent, subscriptions, outbox, handler };
    }
    async function rpc(method, params = {}, accessToken = aliceToken) {
      const response = await runtime.handler(new Request(resource, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      }));
      return { status: response.status, value: await response.json(), headers: response.headers };
    }
    async function successfulRpc(method, params) {
      const { status, value } = await rpc(method, params);
      assert.equal(status, 200); assert.equal(value.error, undefined, JSON.stringify(value.error));
      return value.result;
    }
    async function call(name, args) {
      const result = await successfulRpc('tools/call', { name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    }
    try {
      // The authored kitchen imports only the independently packed public API.
      await mkdir(join(directory, 'node_modules', '@chronolog'), { recursive: true });
      await symlink(packagePath, join(directory, 'node_modules', '@chronolog', 'peer-session'), 'dir');
      for (const name of ['domain.mjs', 'projection.mjs']) await cp(new URL(`../examples/kitchen/${name}`, import.meta.url), join(directory, name));
      const { definition } = await import(pathToFileURL(join(directory, 'domain.mjs')).href);
      fixture = await createNativeFixture(definition, { applicationId, historyId: 'chatgpt-native-roundtrip' });
      let page = await fixture.open(0);
      const enrolled = await fixture.open(1);
      const link = fixture.track(await fixture.peer.connectApplications(page.session, enrolled.session));
      bridge = createSessionBridge({ applications: [{ id: applicationId, label: 'Round-trip kitchen',
        openSession: async () => enrolled, allowedQueries: ['kitchenContext', 'assistanceStatus'],
        allowedCommands: ['replyToAssistance'], eventTopics: ['assistant'], eventProjection: kitchenEventProjection }] });
      store = openDeliveryStore({ path: databasePath, key: databaseKey }); runtime = compose();
      const principal = await runtime.auth.authenticate(new Request(resource, { headers: { authorization: `Bearer ${aliceToken}` } }));
      await runtime.consent.grant(principal, { applicationId, queries: ['kitchenContext', 'assistanceStatus'],
        commands: ['replyToAssistance'], events: ['assistant.help_requested', 'inventory.review_requested'], readEvents: true });
      const applyPage = async (command, input, operationId) => {
        const operation = await page.session.command(command, input, { operationId });
        assert.equal((await operation.applied({ signal: AbortSignal.timeout(5000) })).outcome, 'accepted');
        await link.synchronize();
      };
      await applyPage('setCookingStep', { stepId: 'cream-step', text: 'Finish the sauce' }, 'select-step');
      const initial = await successfulRpc('initialize', { protocolVersion: '2025-11-25' });
      assert.deepEqual(initial.capabilities.events, {});
      assert.equal((await rpc('initialize', {}, null)).status, 401);
      const subscribeParams = (name, url) => ({ name, arguments: { application_id: applicationId },
        delivery: { mode: 'webhook', url, secret: callbackSecrets.get(url) }, cursor: null });
      const helpParams = subscribeParams('assistant.help_requested', 'https://callback.example.test/help');
      const help = await successfulRpc('events/subscribe', helpParams);
      const inventory = await successfulRpc('events/subscribe', subscribeParams('inventory.review_requested', 'https://callback.example.test/inventory'));
      assert.equal(challenges.length, 2);
      assert.notEqual(help.id, inventory.id);
      assert.ok((await rpc('events/subscribe', helpParams, bobToken)).value.error);
      assert.ok((await rpc('events/subscribe', helpParams, readOnlyToken)).value.error);
      assert.ok((await rpc('events/subscribe', { ...helpParams, arguments: { application_id: 'f'.repeat(64) } })).value.error);
      assert.equal(challenges.length, 2, 'Failed account/scope/filter checks must not challenge or export to a callback');

      const context = await page.session.query('kitchenContext', null);
      const question = 'Should I lower the heat before adding cream?';
      await applyPage('requestAssistance', { requestId: 'help-1', kind: 'recipe_help', question,
        cookingStepId: 'cream-step', cookingStepEventId: context.value.currentStep.eventId,
        contextRevision: JSON.stringify(context.revision), expiresAtMs: Date.now() + 900000 }, 'request-help-1');
      for (const subscriptionId of [help.id, inventory.id]) {
        const before = (await store.read()).subscriptions[subscriptionId];
        const batch = await bridge.readEvents(applicationId, { cursor: before.sourceCursor, limit: 128 });
        assert.equal(batch.events.length, 1);
        assert.equal(batch.events[0].sourceOperationId, 'request-help-1');
        assert.equal(JSON.stringify(batch.events).includes(question), false);
        assert.equal(await runtime.outbox.ingest(subscriptionId, batch, { expectedCursor: before.sourceCursor }), true);
        assert.equal((await store.read()).subscriptions[subscriptionId].sourceCursor, batch.cursor);
      }
      assert.equal(Object.keys((await store.read()).jobs).length, 1, 'Inventory filter must not receive kitchen-help events');
      assert.equal(await runtime.outbox.dispatchDue(), 1);
      assert.equal(deliveries.length, 1); assert.equal(deliveries[0].url, helpParams.delivery.url);
      assert.equal(deliveries[0].subscriptionId, help.id);
      assert.equal(deliveries[0].envelope.name, 'assistant.help_requested');
      assert.equal(deliveries[0].body.includes(question), false);
      const sourceEventId = deliveries[0].envelope.data.source_event_id;
      const details = await call('get_event_details', { applicationId, sourceEventId });
      assert.equal(details.event.payload.question, question);
      assert.equal(details.event.author, page.session.deviceId);
      const deniedDetails = await rpc('tools/call', { name: 'get_event_details', arguments: { applicationId, sourceEventId } }, bobToken);
      assert.equal(deniedDetails.value.result.isError, true);
      assert.equal(deniedDetails.value.result.structuredContent.code, 'ACCOUNT_ACCESS_DENIED');
      const beforeReply = await call('get_assistance_status', { applicationId, requestId: 'help-1' });
      assert.equal(beforeReply.assistance.status, 'requested');
      assert.equal(beforeReply.delivery.jobs[0].state, 'accepted');
      assert.equal(beforeReply.delivery.jobs[0].responseOperationId, null);

      const answer = 'Lower the heat, then stir in the cream slowly.';
      const reply = { applicationId, operationId: 'reply-help-1', requestId: 'help-1',
        requestEventId: beforeReply.assistance.requestEventId, answer, suggestedSteps: ['Reduce the heat', 'Stir in the cream'],
        cookingStepId: 'cream-step', basedOnContextRevision: beforeReply.assistance.contextRevision, basedOn: beforeReply.revision };
      const firstReply = await call('reply_to_assistance', reply);
      assert.equal(firstReply.operationId, reply.operationId);
      const nativeReplyId = firstReply.operationReference.operationId;
      assert.match(nativeReplyId, /^integration_v2_/u);
      assert.equal(firstReply.operationReference.deviceId, enrolled.session.deviceId);
      await enrolled.session.operations.wait(nativeReplyId, { signal: AbortSignal.timeout(5000) });
      await link.synchronize();
      const saved = await enrolled.session.operations.inspect(nativeReplyId);
      assert.ok(saved.attempt);
      assert.equal((await call('reply_to_assistance', reply)).operationId, reply.operationId);
      assert.deepEqual((await enrolled.session.operations.inspect(nativeReplyId)).attempt, saved.attempt);
      await link.synchronize();
      const canonicalReply = (await page.session.query('assistanceStatus', { requestId: 'help-1' })).value;
      assert.equal(canonicalReply.status, 'answered'); assert.equal(canonicalReply.answer.answer, answer);
      assert.equal(canonicalReply.answer.author, enrolled.session.deviceId);
      assert.equal(canonicalReply.replies.length, 1);
      const changedRetry = await rpc('tools/call', { name: 'reply_to_assistance', arguments: { ...reply, answer: 'Different answer' } });
      assert.equal(changedRetry.value.result.structuredContent.code, 'OPERATION_ID_CONFLICT');
      const operationStatus = await call('get_operation_status', { applicationId, operationId: reply.operationId });
      assert.equal(operationStatus.operation.status, 'applied');
      assert.equal(operationStatus.operationReference.attemptId, saved.attempt.id);
      assert.equal((await call('retry_application_operation', { applicationId, operationId: reply.operationId })).operationReference.attemptId, saved.attempt.id);
      assert.equal((await call('wait_application_operation', { applicationId, operationId: reply.operationId, timeoutMs: 1000 })).operationReference.attemptId, saved.attempt.id);
      assert.deepEqual((await enrolled.session.operations.inspect(nativeReplyId)).attempt, saved.attempt);
      const answered = await call('get_assistance_status', { applicationId, requestId: 'help-1' });
      assert.equal(answered.assistance.answer.answer, answer);
      assert.equal(answered.delivery.jobs[0].responseOperationId, nativeReplyId);

      const persisted = await store.read();
      await store.close(); store = openDeliveryStore({ path: databasePath, key: databaseKey }); runtime = compose();
      assert.deepEqual(await store.read(), persisted);
      assert.equal((await runtime.subscriptions.active()).length, 2);
      assert.equal(await runtime.outbox.dispatchDue(), 0);
      assert.equal(deliveries.length, 1, 'Reopen must retain the accepted receipt and avoid another delivery');
      assert.equal((await call('reply_to_assistance', reply)).operationId, reply.operationId);
      assert.deepEqual((await enrolled.session.operations.inspect(nativeReplyId)).attempt, saved.attempt);
      await link.close(); await page.session.close(); page = await fixture.open(0, true);
      const reopened = (await page.session.query('assistanceStatus', { requestId: 'help-1' })).value;
      assert.equal(reopened.answer.answer, answer); assert.equal(reopened.replies.length, 1);
    } finally {
      await store?.close();
      await bridge?.close();
      await fixture?.close();
      await rm(directory, { recursive: true, force: true });
      databaseKey.fill(0);
    }
  });
