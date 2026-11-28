import { describe, expect, it } from 'vitest';
import quickJsWasm from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import {
  casRef, ContentAddressedStore, MemoryBytesStore, putPackageDag, putTreeDag, signBuildAttestation,
} from '@chronolog/peer-session/kernel';
import { createCasMirrorClient, createHttpSyncClient, FactIdSet, type HttpSyncFactItem } from '@chronolog/peer-session/mirror';
import { createLogGenesis, createApplicationSession, openApplicationDevice } from '@chronolog/peer-session';
import { createSigningIdentity } from '@chronolog/authority';
import { authorityRecord } from '../../contract/authority.mjs';
import { createTestPage } from './public-fixture';
import { ownerHeaders, req } from './helpers';

describe('Tendriller Edge CAS & Derivation Mirror (/_tendril/cas, /_tendril/derivations, /_tendril/trees)', () => {
  it('stores and serves chronolog-pkg/v1 subgraphs, chronolog-tree/v1 files (with 304), and Ed25519-verified derivation attestations', async () => {
    const page = await createTestPage();
    const mirrorBase = `${page.pageUrl}_tendril`;
    const baseHeaders = ownerHeaders(page.pageUrl);

    const authedFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(baseHeaders)) headers.set(k, v);
      return req(url, { ...init, headers });
    };

    const client = createCasMirrorClient(mirrorBase, { fetch: authedFetch });

    // 1. Push a multi-file chronolog-pkg/v1 DAG via POST /_tendril/cas/batch and pull in 1 RTT via ?subgraph=1
    const localCas = new ContentAddressedStore({ store: new MemoryBytesStore() });
    const pkg = await putPackageDag(localCas, {
      name: 'tendriller/demo-pkg',
      version: '1.0.0',
      files: {
        'index.js': 'import { double } from "./math.js"; export default { query() { return double(21); } };',
        'math.js': 'export const double = n => n * 2;',
      },
      exports: { '.': 'index.js' },
    }, 'public');
    const pkgNodes = await localCas.collectSubgraph([pkg.hash], { allowedPartition: 'public' });
    expect(pkgNodes.length).toBe(3);

    expect(await client.pushSubgraph(pkg.hash, pkgNodes.map(n => ({ hash: n.hash, bytes: n.bytes })))).toBe(true);
    const pulled = await client.fetchSubgraph(pkg.hash);
    expect(pulled.map(n => n.hash).sort()).toEqual(pkgNodes.map(n => n.hash).sort());

    // ETag + 304 on single node
    const head = await authedFetch(`${mirrorBase}/cas/sha256-${pkg.hash}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    const etag = head.headers.get('ETag');
    expect(etag).toBe(`"${pkg.hash}"`);
    const notMod = await authedFetch(`${mirrorBase}/cas/sha256-${pkg.hash}`, { headers: { 'If-None-Match': etag! } });
    expect(notMod.status).toBe(304);

    // 2. Serve a chronolog-tree/v1 release tree with metadata-first 304
    const tree = await putTreeDag(localCas, {
      'index.html': '<!doctype html><h1>Mirror Tree</h1>',
    }, 'public');
    const treeNodes = await localCas.collectSubgraph([tree.hash], { allowedPartition: 'public' });
    expect(await client.pushSubgraph(tree.hash, treeNodes.map(n => ({ hash: n.hash, bytes: n.bytes })))).toBe(true);

    const htmlRes = await authedFetch(`${mirrorBase}/trees/sha256-${tree.hash}/index.html`);
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toBe('<!doctype html><h1>Mirror Tree</h1>');
    const html304 = await authedFetch(`${mirrorBase}/trees/sha256-${tree.hash}/index.html`, {
      headers: { 'If-None-Match': htmlRes.headers.get('ETag')! },
    });
    expect(html304.status).toBe(304);

    // 3. Publish and verify Ed25519 derivation attestation (forged rejected!)
    const builder = await createSigningIdentity();
    const drvRef = casRef('11'.repeat(32));
    const att = await signBuildAttestation(
      { drvRef, outputRef: pkg.ref, runtime: 'chronolog-quickjs/v2' },
      builder.publicKey,
      builder.privateKey,
    );
    expect(await client.publishDerivationAttestation(att)).toBe(true);
    expect(await client.publishDerivationAttestation({ ...att, signature: '00'.repeat(64) })).toBe(false);

    const fetched = await client.fetchDerivationAttestations(drvRef, {
      trustedBuilders: [builder.publicKey],
      threshold: 1,
    });
    expect(fetched.attestations).toHaveLength(1);
    expect(fetched.trusted?.outputRef).toBe(pkg.ref);
  });

  it('reconciles public control ops and blind encrypted mailbox envelopes via binary CBOR sync-v3 (/_tendril/sync/{control,mailbox})', async () => {
    const page = await createTestPage();
    const mirrorBase = `${page.pageUrl}_tendril`;
    const baseHeaders = ownerHeaders(page.pageUrl);
    const authedFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(baseHeaders)) headers.set(k, v);
      return req(url, { ...init, headers });
    };

    // Initialize a real Chronolog v2 private log genesis on the page
    const signer = await createSigningIdentity();
    const wrapKey = '07'.repeat(32);
    const created = await createLogGenesis({
      privateLog: true,
      creator: { publicKey: signer.publicKey, wrapKey },
      imports: { '@app/kv': 'chronolog/kv' },
      topics: { items: { module: '@app/kv' } },
    });
    const initRes = await authedFetch(`${page.pageUrl}_tendril/peers/enrollment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'initialize',
        genesis: authorityRecord(created.genesisBytes),
        casNodes: created.casNodes.map(n => ({ hash: n.hash, bytes: Buffer.from(n.bytes).toString('hex') })),
      }),
    });
    expect(initRes.status).toBe(200);

    // Author an encrypted op locally with a real ApplicationSession
    const device = await openApplicationDevice({ store: new MemoryBytesStore(), managedSigner: signer, create: true });
    const session = await createApplicationSession({
      device,
      genesis: created.genesisBytes,
      casNodes: created.casNodes,
      epochKeys: new Map([[0, created.epoch0Key!]]),
      wasmModule: quickJsWasm,
    });
    await session.submit({
      visibility: 'encrypted',
      operationId: 'sync-v3-op-1',
      updates: [{ topic: 'items', input: { action: 'set', key: 'hello', value: 'world' } }],
    });
    const exported = await session.exportFacts();
    expect(exported.encryptedEnvelopes.length).toBe(1);
    const { encryptedEnvelopeDigest, bytesToHex } = await import('@chronolog/peer-session');
    const envRaw = exported.encryptedEnvelopes[0]!;
    const envDigest = bytesToHex(encryptedEnvelopeDigest(envRaw));

    const syncClient = createHttpSyncClient(mirrorBase, { fetch: authedFetch });

    // 1. Control sync returns revision metadata cleanly
    const ctrl = await syncClient.reconcile('control', {
      ids: new FactIdSet(),
      getFacts: async () => [],
      onReceive: async () => {},
    });
    expect(typeof ctrl.meta?.revision).toBe('string');

    // 2. Peer A pushes encrypted envelope via binary CBOR sync-v3 /_tendril/sync/mailbox
    const peerAIds = new FactIdSet();
    peerAIds.add(envDigest);
    const peerAReceived: HttpSyncFactItem[] = [];
    const pushRes = await syncClient.reconcile('mailbox', {
      ids: peerAIds,
      getFacts: async ids => ids.includes(envDigest) ? [{ id: envDigest, bytes: envRaw }] : [],
      onReceive: async items => { peerAReceived.push(...items); },
    });
    expect(pushRes.pushed).toBe(1);
    expect(peerAReceived).toHaveLength(0);

    // 3. Peer B starts empty and pulls the exact encrypted envelope in 1 RTT
    const peerBIds = new FactIdSet();
    const peerBReceived: HttpSyncFactItem[] = [];
    const pullRes = await syncClient.reconcile('mailbox', {
      ids: peerBIds,
      getFacts: async () => [],
      onReceive: async items => { peerBReceived.push(...items); },
    });
    expect(pullRes.pulled).toBe(1);
    expect(peerBReceived).toHaveLength(1);
    expect(peerBReceived[0]!.id).toBe(envDigest);
    expect(Buffer.from(peerBReceived[0]!.bytes)).toEqual(Buffer.from(envRaw));

    await session.close();
  });

  it('evaluates programmable state-defined $finality predicates identically inside the blind Cloudflare Worker runtime', async () => {
    const { replayBlindHostControl } = await import('@chronolog/peer-session/kernel');
    const { decodeSignedOperation, operationIdDigest, bytesToHex, encodeLogGenesis } = await import('@chronolog/peer-session');
    const admin = await createSigningIdentity();
    const val = await createSigningIdentity();
    const created = await createLogGenesis({
      privateLog: true,
      creator: { publicKey: admin.publicKey, wrapKey: '07'.repeat(32), reader: true, writer: true, administrator: true },
      topics: { items: { module: 'chronolog/crdt', export: 'lwwMap' } },
    });
    const device = await openApplicationDevice({ store: new MemoryBytesStore(), managedSigner: admin, create: true });
    const session = await createApplicationSession({
      device,
      genesis: created.genesisBytes,
      casNodes: created.casNodes,
      epochKeys: new Map([[0, created.epoch0Key!]]),
      wasmModule: quickJsWasm,
    });
    try {
      const t0 = BigInt(Date.now());
      const op1 = await session.submit({
        awaitMaterialized: true,
        authorTimestampMs: t0 + 10n,
        updates: [{ topic: 'items', input: { action: 'set', key: 'k', value: 'v' } }],
      });
      await (await session.submit({
        visibility: 'public',
        awaitMaterialized: true,
        authorTimestampMs: t0 + 20n,
        updates: [{
          topic: '$finality',
          input: {
            action: 'schedulePolicy',
            effectiveAfterMs: Number(t0 + 50n),
            policy: {
              kind: 'predicate',
              module: 'chronolog/finality-predicates',
              export: 'thresholdQuorumPredicate',
              config: { validators: { [admin.publicKey]: 1, [val.publicKey]: 1 }, threshold: 2 },
            },
          },
        }],
      })).materialized();

      const canonical = (v: unknown): string => {
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
        return '{' + Object.keys(v as Record<string, unknown>).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
      };
      const signPayload = async (payload: {
        logId: string; policyScopeId: string; closedThroughMs: bigint; includedSetDigest: string; historyDigest: string; stateRoot: string;
        inclusions: readonly { opId: string; authorTimestampMs: bigint; author: string }[];
      }, signer: { publicKey: string; privateKey: CryptoKey }) => {
        const jsonSafe = {
          logId: payload.logId,
          policyScopeId: payload.policyScopeId,
          closedThroughMs: Number(payload.closedThroughMs),
          includedSetDigest: payload.includedSetDigest,
          historyDigest: payload.historyDigest,
          stateRoot: payload.stateRoot,
          inclusions: payload.inclusions.map(i => ({ opId: i.opId, authorTimestampMs: Number(i.authorTimestampMs), author: i.author })),
        };
        const msg = new TextEncoder().encode(canonical(['chronolog/finality-predicate/v1', jsonSafe]));
        const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', signer.privateKey, msg));
        return { signer: signer.publicKey, signature: bytesToHex(sig) };
      };

      const { checkpoint } = await session.finality.createCheckpoint({
        throughMs: t0 + 100n,
        attestation: async payload => ({
          kind: 'evidence',
          data: { signatures: [await signPayload(payload, admin), await signPayload(payload, val)] },
        }),
      });
      expect(session.finality.status().closedThroughMs).toBe(t0 + 100n);
      expect(session.finalityStatus(op1.id)).toBe('finalized');

      const facts = await session.exportFacts();
      const { decodeOperationCore } = await import('@chronolog/peer-session/kernel');
      const publicOps = facts.publicOps.map(raw => {
        const signed = decodeSignedOperation(raw);
        return { opId: operationIdDigest(signed.coreBytes), core: decodeOperationCore(signed.coreBytes) };
      });
      const blind = await replayBlindHostControl({
        genesis: created.genesis,
        publicCasNodes: facts.casNodes.filter(n => n.partition === 'public'),
        publicOps,
        checkpoints: [checkpoint],
        wasmModule: quickJsWasm,
      });
      expect(blind.finality.closedThroughMs).toBe(t0 + 100n);
      expect(blind.finality.includedOpIds.has(op1.id)).toBe(true);
      expect(encodeLogGenesis(created.genesis).length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});
