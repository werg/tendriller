import {
  RELEASE_PROFILE, peerDigest, signReleaseManifest, signReleaseActivationRequest,
  type PeerIdentity, type ReleaseApplicationBinding, type ReleasePublication, type SignedReleaseActivation,
  type SignedReleaseActivationRequest, type SignedReleasePolicy,
} from '@chronolog/peer-generation/control';
import { api, apiJson, type Handle } from './helpers';
import { sha256Hex } from '../src/ids';

export const releaseApplicationId = () => crypto.randomUUID().replaceAll('-', '').repeat(2);
export async function releasePolicy(h: Handle, publishers: PeerIdentity[], expectedPolicy: string | null = null) {
  return apiJson<SignedReleasePolicy>(h, 'PUT', 'peers/releases/policy', {
    requestId: crypto.randomUUID(), expectedPolicy, publishers: publishers.map(publisher => ({ publicKey: publisher.publicKey })),
  });
}
export async function releaseManifest(applicationId: string, signer: PeerIdentity, files: Record<string, string>,
  policyRevision = 0, application: ReleaseApplicationBinding | null = null) {
  const contents = await Promise.all(Object.keys(files).sort().map(async path => {
    const bytes = new TextEncoder().encode(files[path]);
    return { bytes, asset: { path, digest: await sha256Hex(bytes), bytes: bytes.byteLength,
      mediaType: path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' } };
  }));
  const manifest = await signReleaseManifest({ applicationId, profile: RELEASE_PROFILE, scope: 'page',
    publisher: signer.publicKey, policyRevision, entry: 'index.html', assets: contents.map(value => value.asset), application }, signer);
  return { manifest, contents, id: await peerDigest(manifest) };
}
export async function publishRelease(h: Handle, applicationId: string, signer: PeerIdentity, files: Record<string, string>,
  policyRevision = 0, application: ReleaseApplicationBinding | null = null) {
  const prepared = await releaseManifest(applicationId, signer, files, policyRevision, application);
  for (const content of prepared.contents) {
    const response = await api(h, 'PUT', `peers/releases/content/${content.asset.digest}`, content.bytes, { 'Content-Type': content.asset.mediaType });
    if (!response.ok) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }
  const publication = await apiJson<ReleasePublication>(h, 'POST', 'peers/releases/manifests', prepared.manifest);
  return { ...prepared, publication };
}
export async function releaseRequest(applicationId: string, signer: PeerIdentity, releaseId: string,
  expectedActivation: string | null = null, policyRevision = 0, requestId = crypto.randomUUID()): Promise<SignedReleaseActivationRequest> {
  return signReleaseActivationRequest({ profile: RELEASE_PROFILE, applicationId, requestId, publisher: signer.publicKey,
    policyRevision, expectedActivation, releaseId }, signer);
}
export async function activateRelease(h: Handle, applicationId: string, signer: PeerIdentity, releaseId: string,
  expectedActivation: string | null = null, policyRevision = 0) {
  const request = await releaseRequest(applicationId, signer, releaseId, expectedActivation, policyRevision);
  return { request, activation: await apiJson<SignedReleaseActivation>(h, 'POST', 'peers/releases/activations', request) };
}
