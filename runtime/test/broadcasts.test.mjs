import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { generateBroadcastKeyPair, signBroadcastPayload } from '../../contract/broadcasts.mjs';

const built = await build({
  entryPoints: [new URL('../src/broadcasts.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'Broadcasts',
  platform: 'browser',
  write: false,
});

function setup({ broadcastKeys, fetchImpl }) {
  const storage = new Map();
  const context = {
    URL,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    location: { href: 'https://page.example/p/' },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    fetch: fetchImpl,
  };
  runInNewContext(built.outputFiles[0].text, context);
  const controller = context.Broadcasts.createBroadcastsStore({
    id: 'pg1234567890',
    base: '/p/',
    version: 1,
    documentPath: null,
    application: { id: 'a'.repeat(64) },
    features: { speech: null, shared_by: 'Owner' },
    broadcastKeys,
  });
  return { controller, api: controller.api, storage };
}

test('createBroadcastsStore verifies Ed25519 signatures, rejects tampered notices, matches agentless pages, and honors dismissible', async () => {
  const { publicJwk, privateJwk } = await generateBroadcastKeyPair();
  const issuer = 'https://tendriller.dev';

  const validDismissible = await signBroadcastPayload({
    schema_version: 1,
    id: 'bc_' + 'c'.repeat(26),
    seq: 1,
    issuer,
    kind: 'upgrade',
    severity: 'recommended',
    audiences: ['page_owners'],
    title: 'Republish agentless page',
    summary: 'Connect an agent to update this page.',
    body: '',
    docs_url: 'https://tendriller.dev/docs/RELEASE_COMPOSITION.md',
    action: { kind: 'republish_page', requires_republish: true },
    match: { agentless_only: true },
    dismissible: true,
    created_at: Date.now() - 1000,
    expires_at: null,
    superseded_by: null,
  }, privateJwk);

  const criticalUndismissible = await signBroadcastPayload({
    schema_version: 1,
    id: 'bc_' + 'd'.repeat(26),
    seq: 2,
    issuer,
    kind: 'security',
    severity: 'critical',
    audiences: ['page_all'],
    title: 'Critical security advisory',
    summary: 'Action required immediately.',
    body: '',
    docs_url: null,
    action: null,
    match: null,
    dismissible: false,
    created_at: Date.now() - 500,
    expires_at: null,
    superseded_by: null,
  }, privateJwk);

  const tampered = {
    payload: { ...validDismissible.payload, id: 'bc_' + 'e'.repeat(26), title: 'Forged' },
    signature: validDismissible.signature,
  };

  const { api } = setup({
    broadcastKeys: [publicJwk],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: name => (name === 'ETag' ? '"bc-1"' : null) },
      json: async () => ({
        issuer,
        keys: [publicJwk],
        latest_seq: 2,
        page: {
          role: 'owner',
          version: 1,
          runtime_id: '1'.repeat(64),
          runtime_version: '0.3.0-rc.17',
          published_at: Date.now() - 10_000,
          agent_count: 0,
        },
        broadcasts: [validDismissible, tampered, criticalUndismissible],
      }),
    }),
  });

  // Zero eager I/O when autoFetch is false.
  assert.equal(api.list().length, 0);

  const list = await api.refresh();
  assert.equal(list.length, 2, 'Tampered broadcast must be rejected');
  assert.equal(api.active().length, 2);

  // Dismissing the dismissible notice hides it from active().
  api.dismiss(validDismissible.payload.id);
  assert.equal(api.active().length, 1);
  assert.equal(api.active()[0].id, criticalUndismissible.payload.id);

  // Non-dismissible critical notice cannot be dismissed.
  api.dismiss(criticalUndismissible.payload.id);
  assert.equal(api.active().length, 1);
});
