import assert from 'node:assert/strict';
import test from 'node:test';
import { createMembersClient } from '../members.mjs';

test('membership client preserves exact signed request and operation identity through the host API', async () => {
  const calls = [];
  const client = createMembersClient({ base: 'https://host.test/api/', headers: () => ({ Authorization: 'Bearer owner' }), fetch: async (url, input) => {
    calls.push({ url, ...input });
    return Response.json({ status: 'approved', signedApproval: 'exact-receipt' });
  } });
  await client.requestEnrollment('exact-signed-device-request');
  const decision = { operationId: 'approved-once', requestId: 'r_123', roles: ['reader'], grantFullHistory: true };
  await client.approve(decision); await client.approve(decision);
  assert.equal(calls[0].url, 'https://host.test/api/members/requests');
  assert.equal(calls[0].body, JSON.stringify({ signedRequest: 'exact-signed-device-request' }));
  assert.equal(calls[1].body, calls[2].body);
  assert.equal(calls[1].headers.Authorization, 'Bearer owner');
});

test('membership history bounds its stream, preserves exact bytes and propagates host authorization failures', async () => {
  const expected = new Uint8Array([1, 3, 5]);
  let oversized = false, cancelled = false, denied = false;
  const client = createMembersClient({ base: 'https://host.test/api', fetch: async () => {
    if (denied) return Response.json({ error: { code: 'membership_approval_required', message: 'Approve this device first' } }, { status: 403 });
    if (!oversized) return new Response(expected);
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }));
  } });
  assert.deepEqual(await client.history({ after: 0 }), expected);
  assert.throws(() => client.history({ after: 0, limit: 129 }), /Invalid membership history range/);
  oversized = true;
  await assert.rejects(client.history({ after: 0 }), /bounded response/);
  assert.equal(cancelled, true);
  denied = true;
  await assert.rejects(client.history({ after: 0 }), error => error.status === 403 && error.code === 'membership_approval_required');
});
