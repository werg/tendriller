import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importSigningIdentity, signPublicationManifest } from '@chronolog/authority';
import { project, readPrivate, savePrivate } from './local.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { html: 'text/html; charset=utf-8', mjs: 'text/javascript', js: 'text/javascript', json: 'application/json', wasm: 'application/wasm', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };
export async function publishPage({ root = new URL('./page/', import.meta.url), projectState = project, read = readPrivate, save = savePrivate } = {}) {
  const { handle, host } = await projectState(), files = [], assets = new Map();
  async function visit(base, prefix = '') {
    for (const item of await readdir(base, { withFileTypes: true })) {
      const path = prefix + item.name;
      if (item.isSymbolicLink()) throw Error('Publication must not contain symbolic links');
      if (item.isDirectory()) await visit(new URL(item.name + '/', base), path + '/');
      else if (item.isFile()) {
        const bytes = await readFile(new URL(item.name, base)), digest = hash(bytes);
        files.push({ path, hash: digest, size: bytes.length, type: types[path.split('.').at(-1)] ?? 'application/octet-stream' });
        assets.set(digest, { hash: digest, bytes: bytes.toString('base64') });
      }
    }
  }
  await visit(root); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const graph = hash(JSON.stringify(files)), recordName = `publication-${graph}.json`;
  let publication = await read(recordName, true);
  if (!publication) {
    const [metadata, previous] = await Promise.all([host.peers.application(), host.peers.publication()]);
    const scope = metadata.publicationAuthority;
    if (!scope) throw Error('Run npm run init before publishing');
    const publisher = await importSigningIdentity(await read('publisher.json'));
    publication = await signPublicationManifest({ applicationId: handle.application.id, membershipId: scope.grantId, author: publisher.publicKey,
      operationId: `publish-${graph}`, revision: previous === null ? 0 : previous.publication.payload.revision + 1,
      previous: previous?.publication.id ?? null, executionManifestDigest: scope.executionManifestDigest, entry: 'index.html', files }, publisher);
    await save(recordName, publication);
  }
  const receipt = await host.peers.publish(publication, [...assets.values()]);
  if (receipt.publication.id !== publication.id) throw Error('Publication receipt does not match the retained signed intent');
  return { page_url: handle.page_url, publicationId: publication.id, version: receipt.version,
    next: 'Open this ready signed page. The owner signs in and this browser initializes its own local identity and keys. No native process must remain running for ordinary data writes.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await publishPage(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
