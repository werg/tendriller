import { createPeerIdentity, participantGrant, bytesDigest, signPublicationManifest, verifyAuthorityBundle,
  verifyPublicationManifest, type PeerIdentity, type AuthorityBundle } from '@chronolog/peer-generation/control';
import type { PeerControlsClient } from '../../dist/sdk/peer-controls.mjs';

const authors = new WeakMap<PeerControlsClient, Promise<{ author: PeerIdentity; authority: AuthorityBundle }>>();

/** Code-only test application: no alternate database, application executor or publication protocol. */
async function publisher(peers: PeerControlsClient) {
  let pending = authors.get(peers);
  if (!pending) {
    pending = (async () => {
      const author = await createPeerIdentity();
      const authority = await peers.configureApplication({ historyId: 'browser-publication-check',
        executionManifestDigest: await bytesDigest(new TextEncoder().encode('code-only-browser-fixture')),
        definition: { id: 'authored-page-check', version: '1', schema: null, commands: [], queries: [] },
        schemaAdministrator: author.publicKey, epoch: 0,
        keyDigest: await bytesDigest(crypto.getRandomValues(new Uint8Array(32))),
        members: [{ grant: participantGrant(author.publicKey, { publisher: true }) }],
      });
      await verifyAuthorityBundle(authority);
      return { author, authority };
    })();
    authors.set(peers, pending);
  }
  return pending;
}

/** Complete signed authored graph, delivered through the public participant transport. */
export async function publishAssetGraph(peers: PeerControlsClient,
  assets: Record<string, { body: string | Uint8Array; type: string }>, entry = 'index.html') {
  const { author, authority } = await publisher(peers);
  const previous = await peers.publication(), descriptor = authority.descriptor.payload;
  const files = [], chunks = new Map<string, { hash: string; bytes: string }>();
  for (const path of Object.keys(assets).sort()) {
    const asset = assets[path];
    const bytes = typeof asset.body === 'string' ? new TextEncoder().encode(asset.body) : asset.body;
    const hash = await bytesDigest(bytes);
    files.push({ path, hash, size: bytes.byteLength, type: asset.type });
    chunks.set(hash, { hash, bytes: Buffer.from(bytes).toString('base64') });
  }
  const publication = await signPublicationManifest({ applicationId: descriptor.applicationId,
    historyId: descriptor.historyId, profile: descriptor.profile,
    controlRevision: authority.controls.at(-1)!.payload.revision, author: author.publicKey,
    operationId: crypto.randomUUID(), revision: previous ? previous.publication.payload.revision + 1 : 0,
    previous: previous?.publication.id ?? null, definitionDigest: descriptor.definitionDigest,
    executionManifestDigest: descriptor.executionManifestDigest, entry, files }, author);
  await verifyPublicationManifest(publication, await verifyAuthorityBundle(authority));
  const result = await peers.publish(publication, [...chunks.values()]);
  if (result.publication.id !== publication.id) throw new Error('Publication response changed the signed release');
  return result;
}
