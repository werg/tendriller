import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { signPublicationManifest } from '@chronolog/authority';

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
  const name = `publication-${graph}.json`;
  let publication = await context.readPrivate(name, true);
  if (!publication) {
    const [metadata, previous] = await Promise.all([context.host.peers.application(), context.host.peers.publication()]);
    const scope = metadata.publicationAuthority;
    if (scope?.applicationId !== context.page.applicationId || !scope.publisherKeys.includes(context.signer.publicKey)) {
      throw Error('Prepare this page and review its independent publication grant first');
    }
    publication = await signPublicationManifest({
      applicationId: context.page.applicationId,
      membershipId: scope.grantId,
      author: context.signer.publicKey,
      operationId: `publish-${graph}`,
      revision: previous === null ? 0 : previous.publication.payload.revision + 1,
      previous: previous?.publication.id ?? null,
      executionManifestDigest: scope.executionManifestDigest,
      entry: 'index.html',
      files,
    }, context.signer);
    await context.savePrivate(name, publication);
  }
  const receipt = await context.host.peers.publish(publication, [...assets.values()]);
  if (receipt.publication.id !== publication.id) throw Error('Publication receipt does not identify the retained signed graph');
  return {
    page_url: context.page.pageUrl,
    publicationId: publication.id,
    version: receipt.version,
    next: 'Open this ready signed page. Sign in to initialize local data; edits save locally and sync to the repo agent once paired.',
  };
}
