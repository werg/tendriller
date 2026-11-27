import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationSession, openApplicationDevice } from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { createPageGenesis } from '../../session/admission.mjs';
import { getMediaBytes, putMedia } from '../../docs/tutorial/shared/helpers/lazy-media.mjs';
import { listPublicationHistory, rollbackPublication } from '../../docs/tutorial/shared/helpers/publications-view.mjs';
import { runSessionCommand } from '../../tools/cli/lib/session.mjs';

test('lazy-media putMedia/getMediaBytes transfers encrypted private and public blobs lazily across connected peers + CLI content put/get', async () => {
  const devA = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const devB = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const wrapA = devA.wrapKey;
  const wrapB = devB.wrapKey;

  const created = await createPageGenesis({
    identity: devA.identity,
    wrapKey: wrapA.publicKey,
    privateLog: true,
    admission: null,
  });

  const epochKeys = new Map([[0, created.epoch0Key]]);
  const peerA = await createApplicationSession({ device: devA, genesis: created.genesisBytes, casNodes: created.casNodes, epochKeys });
  const peerB = await createApplicationSession({ device: devB, genesis: created.genesisBytes, casNodes: created.casNodes });
  const scratch = mkdtempSync(join(tmpdir(), 'tendril-media-'));

  try {
    // Admit Peer B atomically so Peer B unlocks epoch 0 key from $keys
    await peerA.admitMember({
      publicKey: devB.identity.publicKey,
      wrapKey: wrapB.publicKey,
      reader: true,
      writer: true,
      administrator: false,
      publisher: false,
      finalizer: false,
    });
    await peerB.mergeFacts(await peerA.exportFacts());
    assert.equal(peerB.hasEpochKey(0), true);

    // Connect Peer B's content source directly to Peer A's local content store (lazy P2P pull!)
    const detach = peerB.content.attachSource(devA.identity.publicKey, peerA.content.source());
    try {
      const payload = new Uint8Array(96 * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;

      // 1. Private encrypted blob with deduplication
      const ref1 = await putMedia(peerA, payload, { visibility: 'private', mediaType: 'application/octet-stream', name: 'sample.bin' });
      const ref2 = await putMedia(peerA, payload, { visibility: 'private', mediaType: 'application/octet-stream', name: 'sample.bin' });
      assert.equal(ref1.visibility, 'private');
      assert.equal(ref1.bytes, payload.byteLength);
      assert.equal(ref1.ref.id, ref2.ref.id);

      const pulled = await getMediaBytes(peerB, ref1);
      assert.ok(pulled instanceof Uint8Array);
      assert.deepEqual(pulled, payload);

      // 2. Public hash-addressed blob via CLI `content put` & `content get`
      const inFile = join(scratch, 'hello.txt');
      const outFile = join(scratch, 'recovered.txt');
      writeFileSync(inFile, 'Peer-backed lazy blob content!');
      const putRes = await runSessionCommand({ session: peerA }, 'content', ['put', inFile], { visibility: 'public', type: 'text/plain' });
      assert.equal(putRes.visibility, 'public');
      assert.ok(typeof putRes.ref.hash === 'string' && putRes.ref.hash.length === 64);

      const getRes = await runSessionCommand({ session: peerB }, 'content', ['get', putRes.ref.hash, outFile], {});
      assert.equal(getRes.writtenTo, outFile);
      assert.equal(readFileSync(outFile, 'utf8'), 'Peer-backed lazy blob content!');
    } finally {
      detach();
    }

    // 3. Signed `$publications` history & rollback via helper + CLI `publication-history`
    const file1Bytes = new TextEncoder().encode('<!doctype html><h1>v1</h1>');
    const file2Bytes = new TextEncoder().encode('<!doctype html><h1>v2</h1>');
    const hash1 = createHash('sha256').update(file1Bytes).digest('hex');
    const hash2 = createHash('sha256').update(file2Bytes).digest('hex');

    await peerA.submit({
      visibility: 'public',
      operationId: 'pub-v1',
      updates: [{ topic: '$publications', input: { action: 'publish', entry: 'index.html', files: [{ path: 'index.html', hash: hash1, size: file1Bytes.byteLength, type: 'text/html' }] } }],
    });
    await peerA.submit({
      visibility: 'public',
      operationId: 'pub-v2',
      updates: [{ topic: '$publications', input: { action: 'publish', entry: 'index.html', files: [{ path: 'index.html', hash: hash2, size: file2Bytes.byteLength, type: 'text/html' }] } }],
    });

    const rbOp = await rollbackPublication(peerA, 1, { operationId: 'pub-rb-1' });
    assert.equal((await rbOp.materialized()).outcome, 'accepted');

    const hist = await listPublicationHistory(peerA);
    assert.equal(hist.length, 3);
    assert.equal(hist[0].revision, 3);
    assert.equal(hist[0].rollbackOf, 1);
    assert.equal(hist[0].files[0].hash, hash1);

    const cliHist = await runSessionCommand({ session: peerA }, 'publication-history', [], {});
    assert.equal(cliHist.currentRevision, 3);
    assert.equal(cliHist.releases.length, 3);
    assert.equal(cliHist.releases[2].rollbackOf, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await peerA.close();
    await peerB.close();
    await devA.close();
    await devB.close();
  }
});
