import { createHash, generateKeyPairSync } from 'node:crypto';
import { bytesToHex, createSigningIdentity, hexToBytes, type SigningIdentity } from '@chronolog/authority';
import { encodeSignedOperation, genesisChainId, signOperationCore, verifySignedOperation } from '@chronolog/peer-session/kernel';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import type { PeersClient } from '../../dist/sdk/peers.mjs';

/** The agent's one shared signing key. It signs publications for every page the agent created. */
export type AgentSigner = SigningIdentity;
export type PublicationReceipt = { opId: string; revision: number; version: number; release?: unknown; finalized?: boolean };
export type PublishedAssets = Record<string, { body: string | Uint8Array; type: string }>;

export const newAgentSigner = (): Promise<AgentSigner> => createSigningIdentity();
/** Chronolog Ed25519 public keys are hex; the host registers an agent's key as base64url. */
export const registrationKey = (signer: AgentSigner): string => Buffer.from(signer.publicKey, 'hex').toString('base64url');
/** A fresh X25519 key-wrap public key (64 hex) for agent registration; these fixtures never receive wrapped page keys. */
export const registrationWrapKey = (): string => generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Prepare the independent publication grant for this agent's key. Idempotent for the same signer. */
async function publicationScope(peers: PeersClient, signer: AgentSigner) {
  let metadata = await peers.application();
  if (!metadata.configuration?.publisherKeys?.length) {
    metadata = await peers.prepare({ publisherKeys: [signer.publicKey] });
  }
  const publisherKeys = metadata.configuration?.publisherKeys ?? [];
  if (!publisherKeys.includes(signer.publicKey)) {
    throw new Error('The host publication configuration does not name this agent signer');
  }
  const chainId = metadata.genesis
    ? bytesToHex(genesisChainId(authorityRecordBytes(metadata.genesis, 1024 * 1024)))
    : metadata.selection.id;
  return { chainId, publisherKeys };
}

/**
 * Sign a Chronolog v2 `$publications` SignedOperation with the agent's shared key and deliver it
 * through the public authority client.
 */
export async function publishAssetGraph(
  peers: PeersClient,
  signer: AgentSigner,
  assets: PublishedAssets,
  entry = 'index.html',
): Promise<PublicationReceipt> {
  const scope = await publicationScope(peers, signer);
  const previous = await peers.publication() as PublicationReceipt | null;
  const files: { path: string; hash: string; size: number; type: string }[] = [];
  const chunks = new Map<string, { hash: string; bytes: string }>();
  for (const path of Object.keys(assets).sort()) {
    const asset = assets[path];
    const bytes = typeof asset.body === 'string' ? new TextEncoder().encode(asset.body) : asset.body;
    const hash = sha256(bytes);
    files.push({ path, hash, size: bytes.byteLength, type: asset.type });
    chunks.set(hash, { hash, bytes: Buffer.from(bytes).toString('base64') });
  }
  const signed = await signOperationCore({
    version: 1,
    chainId: hexToBytes(scope.chainId),
    author: hexToBytes(signer.publicKey),
    authorTimestampMs: BigInt(Date.now()),
    operationId: crypto.randomUUID(),
    nonce: crypto.getRandomValues(new Uint8Array(16)),
    visibility: 'public',
    updates: [{
      topic: '$publications',
      input: {
        action: 'publish',
        entry,
        files,
        ...(previous ? { expectedRevision: previous.revision } : {}),
      },
    }],
  }, signer.privateKey);
  const { opId } = await verifySignedOperation(signed);
  const id = bytesToHex(opId);
  const receipt = await peers.publish(authorityRecord(encodeSignedOperation(signed)), [...chunks.values()]) as PublicationReceipt;
  if (receipt.opId !== id) throw new Error('Publication response changed the signed release');
  return receipt;
}
