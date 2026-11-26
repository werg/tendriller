import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { encodeSignedOperation, hexToBytes } from '@chronolog/peer-session';
import { authorityRecord } from '@tendriller/core/authority';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const types = {
  html: 'text/html; charset=utf-8',
  mjs: 'text/javascript',
  js: 'text/javascript',
  json: 'application/json',
  wasm: 'application/wasm',
  css: 'text/css',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export async function publishPage(context, { root = new URL('./dist/', import.meta.url) } = {}) {
  const files = [];
  const assets = new Map();
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
  let op = await context.readPrivate(name, true);
  if (!op) {
    const previous = await context.host.peers.publication();
    const { signOperationCore } = await import('@chronolog/peer-session/kernel');
    const signed = await signOperationCore({
      version: 1,
      chainId: hexToBytes(context.page.applicationId),
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
    }, context.signer);
    op = authorityRecord(encodeSignedOperation(signed));
    await context.savePrivate(name, op);
  }
  const receipt = await context.host.peers.publish(op, [...assets.values()]);
  return {
    page_url: context.page.pageUrl,
    publicationId: receipt.opId,
    version: receipt.version,
    next: 'Open this ready signed page. Sign in to sync directly over Chronolog v2.',
  };
}
