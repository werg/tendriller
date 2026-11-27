import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  retainPublicationBlobs,
  recoverPublicationAsset,
  recoverPublication,
} from '../../session/publication-blobs.mjs';

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

function createMockBlobSession() {
  const blobs = new Map();
  return {
    blobs,
    content: {
      async putBlob(bytes) {
        const copy = new Uint8Array(bytes);
        const hash = sha256Hex(copy);
        blobs.set(hash, copy);
        return { hash, bytes: copy.byteLength };
      },
      async getBlob(hash, options = {}) {
        const found = blobs.get(hash) ?? null;
        if (found === null) return null;
        if (options.expectedBytes !== undefined && found.byteLength !== options.expectedBytes) {
          throw new Error('CONTENT_BLOB_INVALID');
        }
        return new Uint8Array(found);
      },
      async hasBlob(hash) { return blobs.has(hash); },
      async deleteBlob(hash) { blobs.delete(hash); },
    },
  };
}

test('retainPublicationBlobs no-ops gracefully on sessions without putBlob and verifies hashes when supported', async () => {
  const html = new TextEncoder().encode('<!doctype html><h1>v1</h1>');
  const htmlHash = sha256Hex(html);

  const legacy = await retainPublicationBlobs({ content: {} }, [{ hash: htmlHash, bytes: html }]);
  assert.deepEqual(legacy, { supported: false, retained: 0, skipped: 1 });

  const session = createMockBlobSession();
  const retained = await retainPublicationBlobs(session, [
    { hash: htmlHash, bytes: Buffer.from(html).toString('base64') },
    { hash: htmlHash, bytes: html }, // duplicate hash skipped cleanly
  ]);
  assert.deepEqual(retained, { supported: true, retained: 1, skipped: 1 });
  assert.deepEqual(await session.content.getBlob(htmlHash), html);

  await assert.rejects(
    retainPublicationBlobs(session, [{ hash: '00'.repeat(32), bytes: html }]),
    /PUBLICATION_HASH_MISMATCH|hash mismatch/i,
  );
  assert.equal(await session.content.hasBlob(htmlHash), true);
});

test('recoverPublication falls back to Chronolog P2P blobs when host prunes old versions (404)', async () => {
  const v1Html = new TextEncoder().encode('<!doctype html><h1>Pruned historical v1</h1>');
  const sharedCss = new TextEncoder().encode('body { color: #222; }');
  const v1HtmlFile = { path: 'index.html', hash: sha256Hex(v1Html), size: v1Html.byteLength, type: 'text/html' };
  const sharedCssFile = { path: 'app.css', hash: sha256Hex(sharedCss), size: sharedCss.byteLength, type: 'text/css' };
  const publication = { id: 'pub-v1', payload: { files: [v1HtmlFile, sharedCssFile] } };

  // Peer 1 retained v1's blobs locally when publishing; host later pruned v1's HTML (404), keeping only shared CSS.
  const peerSession = createMockBlobSession();
  await retainPublicationBlobs(peerSession, [{ hash: v1HtmlFile.hash, bytes: v1Html }]);

  const recovered = await recoverPublication(peerSession, publication, {
    seedFromHost: true,
    async fetchHost(file) {
      if (file.hash === sharedCssFile.hash) {
        return new Response(sharedCss, { status: 200, headers: { 'Content-Type': 'text/css' } });
      }
      return new Response(JSON.stringify({ error: { code: 'publication_not_found' } }), { status: 404 });
    },
  });

  assert.equal(recovered.complete, true);
  assert.equal(recovered.fromHost, 1);
  assert.equal(recovered.fromPeers, 1);
  assert.equal(recovered.missing.length, 0);
  assert.deepEqual(recovered.assets.get(v1HtmlFile.hash), v1Html);
  assert.deepEqual(recovered.assets.get(sharedCssFile.hash), sharedCss);
  assert.equal(recovered.files.find(f => f.path === 'index.html')?.source, 'peer');
  assert.equal(recovered.files.find(f => f.path === 'app.css')?.source, 'host');
  // seedFromHost seeded the host-fetched CSS into the local peer blob store too
  assert.equal(await peerSession.content.hasBlob(sharedCssFile.hash), true);
});

test('recoverPublicationAsset rejects tampered peer bytes and reports missing blobs cleanly', async () => {
  const realBytes = new TextEncoder().encode('authentic v1 bundle');
  const file = { path: 'app.js', hash: sha256Hex(realBytes), size: realBytes.byteLength, type: 'text/javascript' };

  const missingSession = createMockBlobSession();
  const notFound = await recoverPublicationAsset(missingSession, file, {
    fetchHost: async () => new Response('not found', { status: 404 }),
  });
  assert.equal(notFound, null);

  const tamperedBytes = new TextEncoder().encode('TAMPERED! v1 bundle');
  const corruptSession = {
    content: {
      async getBlob() { return tamperedBytes; },
    },
  };
  await assert.rejects(
    recoverPublicationAsset(corruptSession, file, {
      fetchHost: async () => new Response('not found', { status: 404 }),
    }),
  );
});
