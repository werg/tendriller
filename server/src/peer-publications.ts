import {
  authorizePublication, verifyPublicationManifest, verifyPublicationAsset, recordDigest,
  encodeRecord, PUBLICATION_LIMITS, type SignedPublication, type PublicationFile, type PublicationAuthority,
} from '@chronolog/authority';
import { assertFilePath } from '../../contract/index.mjs';
import type { Principal } from './access';
import type { Tendril } from './tendril';
import { createVersion, storeContent, type VersionFile } from './files';
import { HttpError } from './http';
import { withPublicationAuthority } from './authority';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';

const HEAD = 'peer_publication_head';
const CONTENT_LIMIT = PUBLICATION_LIMITS.bytes;
export interface PeerPublicationReceipt {
  readonly publication: SignedPublication;
  readonly version: number;
}
function current(t: Tendril): PeerPublicationReceipt | null {
  return t.db.get<PeerPublicationReceipt | null>(HEAD, null);
}
async function verifyRetained(t: Tendril, receipt: PeerPublicationReceipt, authority: PublicationAuthority): Promise<void> {
  // Only retained records participate; caller-supplied manifests are always
  // verified. Weak references cannot retain history beyond Db's bounded cache.
  const cache = () => t.db.cached('peer-publication:verified', () => new WeakSet<PeerPublicationReceipt>());
  const verified = cache();
  if (verified.has(receipt)) return;
  await verifyPublicationManifest(receipt.publication, authority);
  if (verified === cache()) verified.add(receipt);
}
function record(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
    throw new HttpError(400, 'peer_publication_invalid', 'Unexpected publication fields');
  return value as Record<string, any>;
}
function assetBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(CONTENT_LIMIT / 3) * 4)
    throw new HttpError(413, 'peer_publication_too_large');
  let binary: string;
  try { binary = atob(value); } catch { throw new HttpError(400, 'peer_publication_bytes_invalid'); }
  if (btoa(binary) !== value) throw new HttpError(400, 'peer_publication_bytes_invalid', 'Expected canonical base64 bytes');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Signed code releases are durable control publications, independent of the lossy SQL history. */
export async function exchangePeerPublication(t: Tendril, principal: Principal, action: 'read' | 'publish', input: unknown): Promise<unknown> {
  return withPublicationAuthority(t, principal, async ({ authority, authorizeAuthor, checkAccess }) => {
    const previous = current(t);
    if (previous !== null) await verifyRetained(t, previous, authority);
    if (action === 'read') {
      const query = record(input, ['id']);
      if (query.id !== undefined && (typeof query.id !== 'string' || !/^[0-9a-f]{64}$/.test(query.id)))
        throw new HttpError(400, 'peer_publication_id_invalid');
      const result = query.id === undefined ? previous : t.db.get<PeerPublicationReceipt | null>(`peer_publication_record:${query.id}`, null);
      if (result !== null && result !== previous) await verifyRetained(t, result, authority);
      await checkAccess(); return structuredClone(result);
    }

    const value = record(input, ['publication', 'assets']);
    const publication = structuredClone(value.publication) as SignedPublication;
    await verifyPublicationManifest(publication, authority);
    authorizeAuthor(publication.payload.author);
    const operation = `peer_publication_operation:${await recordDigest(publication.payload.operationId)}`;
    const retainedId = t.db.get<string | null>(operation, null);
    const retained = retainedId === null ? null : t.db.get<PeerPublicationReceipt | null>(`peer_publication_record:${retainedId}`, null);
    if (retainedId !== null && retained === null) throw new HttpError(503, 'peer_publication_state_missing');
    // Retrying retained authenticated evidence never becomes a new publication,
    // including after a later release or control transition.
    if (retained !== null) {
      if (await recordDigest(retained.publication) !== await recordDigest(publication)) throw new HttpError(409, 'peer_publication_operation_reused');
      await checkAccess(); authorizeAuthor(publication.payload.author); return structuredClone(retained);
    }
    await authorizePublication(publication, authority, previous?.publication ?? null);
    if (publication.payload.revision >= PUBLICATION_LIMITS.revisions) throw new HttpError(413, 'peer_publication_history_limit');
    const historyBytes = t.db.get<number>('peer_publication_bytes', 0) + encodeRecord(publication).byteLength;
    if (historyBytes > 16 * 1024 * 1024) throw new HttpError(413, 'peer_publication_history_limit');
    try {
      assertFilePath(publication.payload.entry);
      for (const file of publication.payload.files) assertFilePath(file.path);
      const entry = publication.payload.files.find(file => file.path === publication.payload.entry);
      if (!entry || !/\.html?$/i.test(entry.path) || !/^text\/html(?:;|$)/i.test(entry.type))
        throw new Error('The publication entry must be an authored HTML file');
    }
    catch (error) { throw new HttpError(400, 'peer_publication_invalid', error instanceof Error ? error.message : 'Invalid page entry'); }
    if (!Array.isArray(value.assets) || value.assets.length > publication.payload.files.length)
      throw new HttpError(400, 'peer_publication_assets_invalid');

    const files = new Map<string, VersionFile>(), required = new Map<string, PublicationFile>();
    for (const file of publication.payload.files) {
      if (file.size > RESOURCE_LIMITS.file_bytes) throw new HttpError(413, 'peer_publication_file_too_large');
      files.set(file.path, { path: file.path, hash: file.hash, size: file.size, type: file.type });
      const duplicate = required.get(file.hash);
      if (duplicate && duplicate.size !== file.size) throw new HttpError(400, 'peer_publication_assets_invalid');
      required.set(file.hash, file);
    }
    let total = 0;
    const supplied = new Map<string, Uint8Array>();
    for (const inputAsset of value.assets) {
      const asset = record(inputAsset, ['hash', 'bytes']);
      if (typeof asset.hash !== 'string' || !required.has(asset.hash) || supplied.has(asset.hash))
        throw new HttpError(400, 'peer_publication_assets_invalid', 'Only unique referenced code content may reach the host');
      const bytes = assetBytes(asset.bytes);
      total += bytes.byteLength;
      if (total > CONTENT_LIMIT) throw new HttpError(413, 'peer_publication_too_large');
      await verifyPublicationAsset(required.get(asset.hash)!, bytes);
      supplied.set(asset.hash, bytes);
    }
    for (const [hash, file] of required) {
      const stored = t.db.one<{ size: number; status: string }>('SELECT size,status FROM stored_files WHERE hash=?', hash);
      if (stored?.status === 'ready' && stored.size === file.size) continue;
      if (!supplied.has(hash)) throw new HttpError(409, 'peer_publication_content_missing', 'A code publication requires every referenced asset');
    }
    // All input bytes are checked before the first external storage effect.
    await checkAccess(); authorizeAuthor(publication.payload.author);
    for (const [hash, bytes] of supplied) {
      await storeContent(t, bytes.buffer as ArrayBuffer, required.get(hash)!.type);
      await checkAccess(); authorizeAuthor(publication.payload.author);
    }

    let receipt: PeerPublicationReceipt | null = null;
    await createVersion(t, files, null, publication.payload.author, {
      entry: publication.payload.entry,
      beforeCommit: checkAccess,
      commit(version) {
        authorizeAuthor(publication.payload.author);
        if ((current(t)?.publication.id ?? null) !== (previous?.publication.id ?? null))
          throw new HttpError(409, 'peer_publication_conflict');
        receipt = { publication, version };
        t.db.set(HEAD, receipt);
        t.db.set(operation, publication.id);
        t.db.set(`peer_publication_record:${publication.id}`, receipt);
        t.db.set('peer_publication_bytes', historyBytes);
      },
    });
    if (receipt === null) throw new HttpError(500, 'peer_publication_receipt_missing');
    return structuredClone(receipt);
  });
}
