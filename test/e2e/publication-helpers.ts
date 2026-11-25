import { createHash } from 'node:crypto';
import { createSigningIdentity, signPublicationManifest, verifyPublicationManifest,
  type SigningIdentity, type SignedPublication } from '@chronolog/authority';
import type { PeersClient } from '../../dist/sdk/peers.mjs';

/** The agent's one shared signing key. It signs publications for every page the agent created. */
export type AgentSigner = SigningIdentity;
export type PublicationReceipt = { publication: SignedPublication; version: number };
export type PublishedAssets = Record<string, { body: string | Uint8Array; type: string }>;

export const newAgentSigner = (): Promise<AgentSigner> => createSigningIdentity();
/** Chronolog Ed25519 public keys are hex; the host registers an agent's key as base64url. */
export const registrationKey = (signer: AgentSigner): string => Buffer.from(signer.publicKey, 'hex').toString('base64url');

/** Code-only fixture: it has no database, so the execution graph is a fixed label, never a schema. */
const executionManifestDigest = createHash('sha256').update('tendriller-e2e-code-only-publication').digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Prepare the independent publication grant for this agent's key. Idempotent for the same signer and graph. */
async function publicationScope(peers: PeersClient, signer: AgentSigner) {
  let metadata = await peers.application();
  if (metadata.publicationAuthority === null)
    metadata = await peers.prepare({ executionManifestDigest, executionProfile: 'events', publisherKeys: [signer.publicKey] });
  const scope = metadata.publicationAuthority;
  if (!scope || !scope.publisherKeys.includes(signer.publicKey) || scope.executionManifestDigest !== executionManifestDigest)
    throw new Error('The host publication grant does not name this agent signer and fixture execution graph');
  return scope;
}

/**
 * Sign a complete authored graph with the agent's shared key and deliver the raw SignedPublication JSON
 * through the public authority client. The manifest names the publication grant revision the host
 * returned, so the host independently re-verifies publisher, application, execution graph and head.
 */
export async function publishAssetGraph(peers: PeersClient, signer: AgentSigner, assets: PublishedAssets,
  entry = 'index.html'): Promise<PublicationReceipt> {
  const scope = await publicationScope(peers, signer);
  const previous = await peers.publication() as PublicationReceipt | null;
  const files: { path: string; hash: string; size: number; type: string }[] = [], chunks = new Map<string, { hash: string; bytes: string }>();
  for (const path of Object.keys(assets).sort()) {
    const asset = assets[path];
    const bytes = typeof asset.body === 'string' ? new TextEncoder().encode(asset.body) : asset.body;
    const hash = sha256(bytes);
    files.push({ path, hash, size: bytes.byteLength, type: asset.type });
    chunks.set(hash, { hash, bytes: Buffer.from(bytes).toString('base64') });
  }
  const publication = await signPublicationManifest({ applicationId: scope.applicationId, membershipId: scope.grantId,
    author: signer.publicKey, operationId: crypto.randomUUID(),
    revision: previous ? previous.publication.payload.revision + 1 : 0, previous: previous?.publication.id ?? null,
    executionManifestDigest: scope.executionManifestDigest, entry, files }, signer);
  await verifyPublicationManifest(publication, scope);
  const receipt = await peers.publish(publication, [...chunks.values()]) as PublicationReceipt;
  if (receipt.publication.id !== publication.id) throw new Error('Publication response changed the signed release');
  return receipt;
}
