import { describe, expect, it } from 'vitest';
import {
  casRef, ContentAddressedStore, MemoryBytesStore, putPackageDag, putTreeDag, signBuildAttestation,
} from '@chronolog/peer-session/kernel';
import { createCasMirrorClient } from '@chronolog/peer-session/mirror';
import { createSigningIdentity } from '@chronolog/authority';
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
});
