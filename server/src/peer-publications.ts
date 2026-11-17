import { createPublicationRegistry, authorizePublication, verifyAuthorityBundle, verifyPublicationAsset,
  PUBLICATION_LIMITS, type AuthorityBundle, type BytesStore, type SignedPublication } from '@chronolog/peer-generation/control';
import { assertFilePath } from '../../contract/index.mjs';
import { createVersion, storeContent, versionFiles, type VersionFile } from './files';
import { HttpError } from './http';
import { isHtmlType } from './mime';
import type { Tendril } from './tendril';

const VERSIONS = 'peer_publication_versions';
interface PublicationVersion { id: string; version: number }
interface PublicationReceipt { publication: SignedPublication; version: number }
export interface PeerPublicationContext {
  readonly store: BytesStore;
  authority(): Promise<AuthorityBundle>;
  authorize(author?: string): Promise<void>;
  guard(author?: string): void;
}

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      !fields.every(field => Object.hasOwn(value, field))) throw new HttpError(400, 'peer_publication_invalid');
}
function versions(t: Tendril): PublicationVersion[] {
  const rows = t.db.get<PublicationVersion[]>(VERSIONS, []);
  if (!Array.isArray(rows) || rows.length > PUBLICATION_LIMITS.revisions || rows.some(row => !row ||
      !/^[0-9a-f]{64}$/.test(row.id) || !Number.isSafeInteger(row.version) || row.version < 1) ||
      new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.version)).size !== rows.length)
    throw new HttpError(503, 'peer_publication_state_mismatch');
  return rows;
}
function receipt(t: Tendril, publication: SignedPublication, requireFiles = true): PublicationReceipt {
  const mapping = versions(t).find(row => row.id === publication.id);
  if (!mapping) throw new HttpError(503, 'peer_publication_state_missing');
  // Metadata never retargets a retired immutable version. Normal host retention
  // and byte quotas still apply; a pruned old release is explicitly unavailable.
  const version = t.db.one<{ entry: string }>('SELECT entry FROM versions WHERE version=?', mapping.version);
  if (!version) {
    if (requireFiles) throw new HttpError(410, 'peer_publication_unavailable', 'The signed publication is retained, but its hosted files have expired');
    return { publication, version: mapping.version };
  }
  const files = versionFiles(t, mapping.version);
  if (version.entry !== publication.payload.entry || files.length !== publication.payload.files.length || files.some((file, index) => {
    const signed = publication.payload.files[index];
    return file.path !== signed.path || file.hash !== signed.hash || file.type !== signed.type || file.size !== signed.size;
  })) throw new HttpError(503, 'peer_publication_state_mismatch');
  return { publication, version: mapping.version };
}

/** Stage the portable registry until the hosted immutable files can commit with it. */
async function stagedRegistry(context: PeerPublicationContext) {
  const writes = new Map<string, Uint8Array>();
  const store: BytesStore = { get: async key => writes.get(key)?.slice() ?? context.store.get(key),
    put: async (key, bytes) => {
      if (!key.startsWith('peer-generation/publications/') || bytes.length > 16 * 1024 * 1024)
        throw new HttpError(413, 'peer_publication_storage_full');
      writes.set(key, bytes.slice());
    } };
  const registry = await createPublicationRegistry({ store, authority: () => context.authority() });
  const commit = (t: Tendril) => {
    for (const [key, bytes] of writes)
      t.db.run('INSERT INTO membership_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, bytes.buffer);
  };
  return { registry, commit };
}

export async function readPeerPublication(t: Tendril, context: PeerPublicationContext, id?: string): Promise<PublicationReceipt | null> {
  const { registry, commit } = await stagedRegistry(context), publications = await registry.read();
  const head = id === undefined ? publications.at(-1) : publications.find(value => value.id === id);
  if (id !== undefined && !head) throw new HttpError(404, 'peer_publication_not_found');
  const selected = head ? receipt(t, head, id === undefined) : null;
  await context.authorize();
  t.transaction(() => { context.guard(); commit(t); });
  return selected;
}

export async function publishPeerPublication(t: Tendril, input: unknown, context: PeerPublicationContext): Promise<PublicationReceipt> {
  exact(input, ['publication', 'assets']);
  const { registry, commit } = await stagedRegistry(context), previous = await registry.read();
  // This verifies signed scope, semantics, current admin authority and exact
  // publication retry identity before any asset upload. Writes are still staged.
  const publication = await registry.publish(input.publication as SignedPublication);
  const author = publication.payload.author;
  await context.authorize(author);
  const files = publication.payload.files;
  try {
    for (const file of files) assertFilePath(file.path);
    assertFilePath(publication.payload.entry);
    if (!/\.html?$/i.test(publication.payload.entry) || !isHtmlType(files.find(file => file.path === publication.payload.entry)!.type))
      throw new TypeError('Publication entry must be authored HTML');
  } catch (error) { throw new HttpError(400, 'peer_publication_path_invalid', error instanceof Error ? error.message : 'Invalid publication path'); }
  if (!Array.isArray(input.assets) || input.assets.length > PUBLICATION_LIMITS.files) throw new HttpError(400, 'peer_publication_assets_invalid');
  const expected = new Map(files.map(file => [file.hash, file])), assets = new Map<string, Uint8Array>();
  if (input.assets.length !== expected.size) throw new HttpError(400, 'peer_publication_assets_invalid');
  for (const asset of input.assets) {
    exact(asset, ['hash', 'bytes']);
    const file = typeof asset.hash === 'string' ? expected.get(asset.hash) : undefined;
    if (!file || assets.has(file.hash) || typeof asset.bytes !== 'string' || asset.bytes.length !== Math.ceil(file.size / 3) * 4)
      throw new HttpError(400, 'peer_publication_assets_invalid');
    let decoded: string;
    try { decoded = atob(asset.bytes); if (btoa(decoded) !== asset.bytes) throw new Error('Non-canonical base64'); }
    catch { throw new HttpError(400, 'peer_publication_assets_invalid'); }
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    await verifyPublicationAsset(file, bytes); assets.set(file.hash, bytes);
  }
  for (const file of files) await verifyPublicationAsset(file, assets.get(file.hash)!);
  if (previous.some(value => value.id === publication.id)) {
    const accepted = receipt(t, publication);
    await context.authorize(author);
    t.transaction(() => { context.guard(author); commit(t); });
    return accepted;
  }
  const mappings = versions(t), headRevision = t.db.get<number>('publication_head_revision', 0);
  const retained = new Map<string, VersionFile>();
  for (const file of files) {
    const bytes = assets.get(file.hash)!;
    const stored = await storeContent(t, bytes.slice().buffer, file.type);
    if (stored.hash !== file.hash || stored.size !== file.size) throw new HttpError(400, 'peer_publication_asset_mismatch');
    await context.authorize(author);
    retained.set(file.path, { ...file });
  }
  const version = await createVersion(t, retained, `Signed publication ${publication.id}`, author, {
    entry: publication.payload.entry, expectedHeadRevision: headRevision, signedPeerPublication: true,
    async beforeCommit() {
      const authority = await verifyAuthorityBundle(await context.authority());
      await authorizePublication(publication, authority, previous.at(-1) ?? null);
      await context.authorize(author);
    },
    commit(version) {
      context.guard(author);
      commit(t);
      t.db.set(VERSIONS, [...mappings, { id: publication.id, version }]);
    },
  });
  return { publication, version };
}
