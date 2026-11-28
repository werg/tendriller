import { describe, expect, it } from 'vitest';
import { DEFAULT_GENESIS_LIMITS, encodeRecord } from '@chronolog/peer-session';
import {
  casRef, computeCasHash, ContentAddressedStore, encodeCasNode, MemoryBytesStore, putPackageDag,
} from '@chronolog/peer-session/kernel';
import { collectReferencedPublicCasHashes, isSeenOpsCasBlob } from '../src/authority';

describe('collectReferencedPublicCasHashes', () => {
  it('retains genesis/reducer modules, chronolog-pkg/v1 subgraphs, and $mounts while excluding unreferenced seenOps blobs', async () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);

    const leafBytes = utf8('export const helper = () => 42;');
    const leafHash = computeCasHash(leafBytes, []);
    const leafNode = encodeCasNode(leafBytes, []);

    const reducerBytes = utf8('export default { reduce(s) { return { ok: true, state: s }; } }');
    const reducerHash = computeCasHash(reducerBytes, [leafHash]);
    const reducerNode = encodeCasNode(reducerBytes, [leafHash]);

    // Multi-file chronolog-pkg/v1 package DAG
    const tmpCas = new ContentAddressedStore({ store: new MemoryBytesStore() });
    const pkg = await putPackageDag(tmpCas, {
      name: 'demo/pkg',
      files: {
        'index.js': 'import { v } from "./sub.js"; export default { query() { return v; } };',
        'sub.js': 'export const v = 7;',
      },
      exports: { '.': 'index.js' },
    }, 'public');
    const pkgSubgraph = await tmpCas.collectSubgraph([pkg.hash], { allowedPartition: 'public' });

    const mountedRootBytes = utf8('{"mounted":true}');
    const mountedRootHash = computeCasHash(mountedRootBytes, []);
    const mountedRootNode = encodeCasNode(mountedRootBytes, []);

    const leakedSeenOpsBytes = utf8('encrypted:deadbeef:op-1,encrypted:deadbeef:op-2');
    const leakedSeenOpsHash = computeCasHash(leakedSeenOpsBytes, []);
    const leakedSeenOpsNode = encodeCasNode(leakedSeenOpsBytes, []);

    const casMap = new Map<string, Uint8Array>([
      [leafHash, leafNode],
      [reducerHash, reducerNode],
      [mountedRootHash, mountedRootNode],
      [leakedSeenOpsHash, leakedSeenOpsNode],
      ...pkgSubgraph.map(n => [n.hash, n.bytes] as const),
    ]);

    const genesis = {
      version: 1 as const,
      privateLog: true,
      initialTopics: {
        $reducers: {
          imports: {
            'app/main': casRef(reducerHash),
            'demo/pkg': pkg.ref,
          },
          topics: { main: { module: 'app/main' } },
        },
      },
      limits: DEFAULT_GENESIS_LIMITS,
      salt: new Uint8Array(16),
    };

    const kept = await collectReferencedPublicCasHashes(genesis, [], {
      $reducers: genesis.initialTopics.$reducers,
      $permissions: { members: [] },
      $mounts: { mounts: { registry: { logId: '11'.repeat(32), stateRoot: '22'.repeat(32), casRoots: [mountedRootHash] } } },
    }, casMap);

    expect(kept.has(reducerHash)).toBe(true);
    expect(kept.has(leafHash)).toBe(true);
    for (const n of pkgSubgraph) expect(kept.has(n.hash)).toBe(true);
    expect(kept.has(mountedRootHash)).toBe(true);
    expect(kept.has(leakedSeenOpsHash)).toBe(false);
    expect(kept.size).toBe(3 + pkgSubgraph.length);
  });

  it('detects canonical CBOR seenOps CAS blobs without flagging normal reducer or data nodes', () => {
    const author = 'a'.repeat(64);
    const seenOpsBlob = encodeCasNode(encodeRecord([`encrypted:${author}:op-1`, `public:${author}:op-2`]), []);
    const reducerBlob = encodeCasNode(new TextEncoder().encode('export default { reduce(s) { return { ok: true, state: s }; } }'), []);
    const normalListBlob = encodeCasNode(encodeRecord(['hello', 'world']), []);

    expect(isSeenOpsCasBlob(seenOpsBlob)).toBe(true);
    expect(isSeenOpsCasBlob(reducerBlob)).toBe(false);
    expect(isSeenOpsCasBlob(normalListBlob)).toBe(false);
  });
});
