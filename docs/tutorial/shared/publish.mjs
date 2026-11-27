import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { bytesToHex, encodeSignedOperation, genesisLogId, hexToBytes } from '@chronolog/peer-session';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { html: 'text/html; charset=utf-8', mjs: 'text/javascript', js: 'text/javascript', json: 'application/json', wasm: 'application/wasm', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };

/**
 * Signed Chronolog v2 code publication.
 * Signs a public-control `$publications` operation (`chronolog/publications`) and uploads
 * only referenced asset bytes not yet stored on the host.
 */
export async function publishPage(context, { root, session } = {}) {
  const files = [], assets = new Map();
  async function visit(base, prefix = '') {
    for (const item of await readdir(base, { withFileTypes: true })) {
      const path = prefix + item.name;
      if (item.isSymbolicLink()) throw Error('Authored output may not contain symbolic links');
      if (item.isDirectory()) await visit(new URL(item.name + '/', base), path + '/');
      else if (item.isFile()) {
        const bytes = await readFile(new URL(item.name, base));
        const digest = hash(bytes);
        files.push({ path, hash: digest, size: bytes.length, type: types[path.split('.').at(-1)] ?? 'application/octet-stream' });
        assets.set(digest, { hash: digest, bytes: bytes.toString('base64') });
      }
    }
  }
  await visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const graph = hash(JSON.stringify(files));
  const name = `publication-v2-${graph}.json`;
  let opHex = await context.readPrivate(name, true);
  if (!opHex) {
    if (session && typeof session.publishRelease === 'function') {
      const op = await session.publishRelease({ entry: 'index.html', files, operationId: `publish-${graph}` });
      const facts = await session.exportFacts();
      const rawOp = facts.publicOps.at(-1);
      opHex = authorityRecord(rawOp);
    } else {
      const { signOperationCore } = await import('@chronolog/peer-session/kernel');
      const metadata = await context.host.peers.application();
      const targetLogId = metadata.genesis
        ? bytesToHex(genesisLogId(authorityRecordBytes(metadata.genesis, 1024 * 1024)))
        : metadata.selection.id;
      const previous = await context.host.peers.publication();
      const signed = await signOperationCore({
        version: 1,
        logId: hexToBytes(targetLogId),
        author: hexToBytes(context.signer.publicKey),
        operationId: `publish-${graph}`,
        authorTimestampMs: BigInt(Date.now()),
        nonce: crypto.getRandomValues(new Uint8Array(16)),
        visibility: 'public',
        updates: [{
          topic: '$publications',
          input: {
            action: 'publish',
            entry: 'index.html',
            files,
            ...(previous ? { expectedRevision: previous.revision } : {}),
          },
        }],
      }, context.signer.privateKey);
      opHex = authorityRecord(encodeSignedOperation(signed));
    }
    await context.savePrivate(name, opHex);
  }
  const receipt = await context.host.peers.publish(opHex, [...assets.values()]);
  return {
    page_url: context.page.pageUrl,
    publicationId: receipt.opId,
    version: receipt.version,
    next: 'Open this ready signed page. The owner signs in and syncs directly with peers over Chronolog v2.',
  };
}
