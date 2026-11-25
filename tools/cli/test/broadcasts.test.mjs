import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateBroadcastKeyPair, signBroadcastPayload } from '@tendriller/core/broadcasts';
import { acknowledgeWorkspaceBroadcast, detectWorkspaceVersions, openWorkspace, syncWorkspaceBroadcasts } from '../lib/workspace.mjs';
import { handleStdioMcpMessage } from '../lib/mcp-stdio.mjs';

test('workspace detects installed versions, verifies signed broadcasts, matches constraints, and persists acknowledgements', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-bc-ws-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, '.tendriller/agent'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/@tendriller/core'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/@chronolog/peer-session'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@tendriller/core/package.json'), JSON.stringify({ name: '@tendriller/core', version: '0.3.0-rc.17' }));
  writeFileSync(join(dir, 'node_modules/@chronolog/peer-session/package.json'), JSON.stringify({ name: '@chronolog/peer-session', version: '0.4.1' }));
  writeFileSync(join(dir, 'tendriller.json'), JSON.stringify({
    schemaVersion: 1,
    service: 'https://service.test',
    agent: { id: 'ag_' + 'a'.repeat(26), handle: 'atlas', bio: 'Primary' },
    pages: {},
  }));
  writeFileSync(join(dir, '.tendriller/agent/credential.json'), JSON.stringify({
    schemaVersion: 1,
    service: 'https://service.test',
    agent: { id: 'ag_' + 'a'.repeat(26), handle: 'atlas', bio: 'Primary' },
    token: 'ta_' + 'b'.repeat(32),
    publicKey: 'c'.repeat(64),
  }));

  const versions = await detectWorkspaceVersions(dir);
  assert.equal(versions.core, '0.3.0-rc.17');
  assert.equal(versions.chronolog, '0.4.1');

  const { publicJwk, privateJwk } = await generateBroadcastKeyPair();
  const upgradeNotice = await signBroadcastPayload({
    schema_version: 1,
    id: 'bc_' + 'm'.repeat(26),
    seq: 1,
    issuer: 'https://service.test',
    kind: 'upgrade',
    severity: 'urgent',
    audiences: ['agents'],
    title: 'Upgrade Chronolog to 0.5.0',
    summary: 'Required for relay cutover.',
    body: '',
    docs_url: 'https://service.test/docs/RELEASE_COMPOSITION.md',
    action: { kind: 'upgrade_dependencies', packages: { '@chronolog/peer-session': '>=0.5.0' }, requires_republish: true },
    match: { packages: { '@chronolog/peer-session': '<0.5.0' } },
    dismissible: true,
    created_at: Date.now() - 1000,
    expires_at: null,
    superseded_by: null,
  }, privateJwk);

  const unrelatedNotice = await signBroadcastPayload({
    schema_version: 1,
    id: 'bc_' + 'n'.repeat(26),
    seq: 2,
    issuer: 'https://service.test',
    kind: 'upgrade',
    severity: 'info',
    audiences: ['agents'],
    title: 'Ancient core notice',
    summary: 'Only affects core < 0.2.0.',
    body: '',
    docs_url: null,
    action: null,
    match: { packages: { '@tendriller/core': '<0.2.0' } },
    dismissible: true,
    created_at: Date.now() - 500,
    expires_at: null,
    superseded_by: null,
  }, privateJwk);

  const fetcher = async url => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/tendriller-broadcast-keys.json') {
      return new Response(JSON.stringify({ issuer: 'https://service.test', keys: [publicJwk] }), { status: 200 });
    }
    if (u.pathname === '/api/broadcasts') {
      return new Response(JSON.stringify({
        issuer: 'https://service.test',
        keys: [publicJwk],
        latest_seq: 2,
        broadcasts: [upgradeNotice, unrelatedNotice],
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  const workspace = await openWorkspace({ root: dir, fetch: fetcher });
  const synced = await syncWorkspaceBroadcasts(workspace);
  assert.equal(synced.latest_seq, 2);
  assert.equal(synced.all.length, 2);
  assert.equal(synced.active.length, 1);
  assert.equal(synced.active[0].id, upgradeNotice.payload.id);

  // Local stdio MCP exposes system_broadcasts tool so the agent decides how to act.
  const mcpRes = await handleStdioMcpMessage({
    list: async () => [],
    broadcasts: async ({ acknowledgeId } = {}) => acknowledgeId
      ? acknowledgeWorkspaceBroadcast(workspace, acknowledgeId)
      : syncWorkspaceBroadcasts(workspace),
  }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system_broadcasts', arguments: {} } });
  assert.equal(mcpRes.result.structuredContent.active.length, 1);

  // Acknowledging removes it from active() without deleting history.
  const ackRes = await handleStdioMcpMessage({
    list: async () => [],
    broadcasts: async ({ acknowledgeId } = {}) => acknowledgeId
      ? acknowledgeWorkspaceBroadcast(workspace, acknowledgeId)
      : syncWorkspaceBroadcasts(workspace),
  }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'system_broadcasts', arguments: { acknowledgeId: upgradeNotice.payload.id } } });
  assert.equal(ackRes.result.structuredContent.acknowledged, true);

  const afterAck = await syncWorkspaceBroadcasts(workspace);
  assert.equal(afterAck.active.length, 0);
  assert.equal(afterAck.all.length, 2);
});
