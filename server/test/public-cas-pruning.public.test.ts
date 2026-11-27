import { describe, expect, it } from 'vitest';
import { encodeRecord } from '@chronolog/peer-session';
import { computeCasHash, encodeCasNode } from '@chronolog/peer-session/kernel';
import { collectReferencedPublicCasHashes, isSeenOpsCasBlob } from '../src/authority';

describe('collectReferencedPublicCasHashes', () => {
  it('retains genesis/reducer modules and transitive CAS links while excluding unreferenced seenOps blobs', () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);

    const leafBytes = utf8('export const helper = () => 42;');
    const leafHash = computeCasHash(leafBytes, []);
    const leafNode = encodeCasNode(leafBytes, []);

    const reducerBytes = utf8('export default { reduce(s) { return { ok: true, state: s }; } }');
    const reducerHash = computeCasHash(reducerBytes, [leafHash]);
    const reducerNode = encodeCasNode(reducerBytes, [leafHash]);

    const leakedSeenOpsBytes = utf8('encrypted:deadbeef:op-1,encrypted:deadbeef:op-2');
    const leakedSeenOpsHash = computeCasHash(leakedSeenOpsBytes, []);
    const leakedSeenOpsNode = encodeCasNode(leakedSeenOpsBytes, []);

    const casMap = new Map<string, Uint8Array>([
      [leafHash, leafNode],
      [reducerHash, reducerNode],
      [leakedSeenOpsHash, leakedSeenOpsNode],
    ]);

    const genesis = {
      initialReducers: {
        imports: { 'app/main': `cas:sha256-${reducerHash}` },
        topics: { main: { module: 'app/main' } },
      },
    };

    const kept = collectReferencedPublicCasHashes(genesis, [], {
      $reducers: genesis.initialReducers,
      $permissions: { members: [] },
    }, casMap);

    expect(kept.has(reducerHash)).toBe(true);
    expect(kept.has(leafHash)).toBe(true);
    expect(kept.has(leakedSeenOpsHash)).toBe(false);
    expect(kept.size).toBe(2);
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
