/**
 * Chronolog v2 signed code publications.
 *
 * A publication is a normal signed public-control operation targeting `$publications`
 * (`chronolog/publications` standard reducer), accompanied by any referenced asset
 * bytes not already stored in R2. The blind host replays the candidate op through
 * `TopicKernel({ blindHostMode: true })` so publisher/admin rights, revision guards,
 * and late-revocation reconciliation obey the exact same CRDT semantics as every replica.
 */
import { bytesToHex, decodeRecord, type FinalityCheckpoint } from '@chronolog/authority';
import type { KernelOperationInput } from '@chronolog/peer-session/kernel';
import { sha256Hex } from './ids';
import { authorityRecordBytes } from '../../contract/authority.mjs';
import { assertFilePath } from '../../contract/index.mjs';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';
import { requireAgentScope, type Principal } from './access';
import {
  activeLogId, authorityAccount, authorityError, freshAuthorityAccess, listCheckpointRows,
  listPublicCasRows, listPublicOpRows, readControlState, readStoredGenesisBytes, storedKernelOp,
  reconcileHostEffects, replayBlindHostControl, verifyPublicControlOp, withAuthorityMutation,
  type ControlRelease,
} from './authority';
import type { HostAppConfig } from '../../contract/authority.mjs';
import { notifyDiscoveryWatchers } from './discovery';
import { createVersion, storeContent, type VersionFile } from './files';
import { cachedAccountEntitlements } from './billing/entitlements';
import { HttpError } from './http';
import type { Tendril } from './tendril';

const CONTENT_LIMIT = 8 * 1024 * 1024;
const MAX_PUBLICATION_FILES = 256;
const ASSET_UPLOAD_CONCURRENCY = 4;

async function storeSuppliedAssets(
  t: Tendril,
  principal: Principal,
  supplied: Map<string, Uint8Array>,
  required: Map<string, { path: string; hash: string; size: number; type: string }>,
): Promise<void> {
  await freshAuthorityAccess(t, principal);
  if (supplied.size === 0) return;
  const owner = t.db.get<string | null>('owner_account', null);
  const pageLimit = owner
    ? (await cachedAccountEntitlements(t.env, owner).catch(() => null))?.quotas.pageStorageBytes
    : undefined;
  const entries = [...supplied.entries()];
  for (let i = 0; i < entries.length; i += ASSET_UPLOAD_CONCURRENCY) {
    const batch = entries.slice(i, i + ASSET_UPLOAD_CONCURRENCY);
    await Promise.all(batch.map(([hash, bytes]) =>
      storeContent(t, bytes.slice().buffer, required.get(hash)!.type, { pageLimit }),
    ));
  }
  await freshAuthorityAccess(t, principal);
}

export interface PeerPublicationReceipt {
  readonly opId: string;
  readonly revision: number;
  readonly version: number;
  readonly release: ControlRelease;
  readonly finalized: boolean;
}

function record(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new HttpError(400, 'peer_publication_invalid', 'Unexpected publication fields');
  }
  return value as Record<string, any>;
}

function assetBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(CONTENT_LIMIT / 3) * 4) {
    throw new HttpError(413, 'peer_publication_too_large');
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new HttpError(400, 'peer_publication_bytes_invalid'); }
  if (btoa(binary) !== value) throw new HttpError(400, 'peer_publication_bytes_invalid', 'Expected canonical base64 bytes');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function exchangePeerPublication(
  t: Tendril,
  principal: Principal,
  action: 'read' | 'publish',
  input: unknown,
): Promise<unknown> {
  // A receipt read observes committed state only, so it need not wait behind
  // an in-flight publication that is still uploading assets.
  const run = action === 'read' ? <T>(work: () => Promise<T>) => work() : <T>(work: () => Promise<T>) => withAuthorityMutation(t, work);
  return run(async () => {
    await freshAuthorityAccess(t, principal);
    const genesisBytes = readStoredGenesisBytes(t);
    const state = genesisBytes ? await readControlState(t) : null;
    const config = t.db.get<HostAppConfig | null>('application_configuration', null);
    if (!genesisBytes && !config) {
      throw new HttpError(409, 'application_uninitialized', 'Prepare or initialize Chronolog v2 genesis before publishing.');
    }

    if (action === 'read') {
      const query = record(input, ['id']);
      if (query.id !== undefined && (typeof query.id !== 'string' || !/^[0-9a-f]{64}$/.test(query.id))) {
        throw new HttpError(400, 'peer_publication_id_invalid');
      }
      if (query.id !== undefined) {
        return structuredClone(t.db.get<PeerPublicationReceipt | null>(`v2_pub_receipt:${query.id}`, null));
      }
      if (!state) {
        return structuredClone(t.db.get<PeerPublicationReceipt | null>('v2_bootstrap_pub_receipt', null));
      }
      const effective = state.hasActiveFinality ? state.finalizedPublications?.current ?? null : state.publications.current;
      if (!effective) return structuredClone(t.db.get<PeerPublicationReceipt | null>('v2_bootstrap_pub_receipt', null));
      const version = t.db.get<number | null>(`v2_pub_version:${effective.opId}`, null) ?? 0;
      const receipt: PeerPublicationReceipt = {
        opId: effective.opId,
        revision: effective.revision,
        version,
        release: effective,
        finalized: state.hasActiveFinality && state.finalizedPublications?.current?.opId === effective.opId,
      };
      return structuredClone(receipt);
    }

    authorityAccount(t, principal, true);
    if (principal.kind === 'agent') requireAgentScope(principal, 'publication:write');

    const value = record(input, ['op', 'assets']);
    const rawOp = authorityRecordBytes(value.op, 512 * 1024);
    const logId = activeLogId(t);
    const parsed = await verifyPublicControlOp(rawOp, logId);
    const pubUpdate = parsed.kernelInput.core.updates.find(u => u.topic === '$publications');
    if (!pubUpdate || !pubUpdate.input || typeof pubUpdate.input !== 'object' || Array.isArray(pubUpdate.input)) {
      throw new HttpError(400, 'peer_publication_invalid', 'Publication operation must update $publications');
    }

    // Idempotent retry of an already-stored publication op.
    const existingReceipt = t.db.get<PeerPublicationReceipt | null>(`v2_pub_receipt:${parsed.opId}`, null);
    if (existingReceipt) return structuredClone(existingReceipt);

    const payload = pubUpdate.input as { action?: unknown; entry?: unknown; files?: unknown };
    if (payload.action !== 'publish' || typeof payload.entry !== 'string' || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > MAX_PUBLICATION_FILES) {
      throw new HttpError(400, 'peer_publication_invalid', 'Invalid $publications payload');
    }

    const files = new Map<string, VersionFile>();
    const required = new Map<string, { path: string; hash: string; size: number; type: string }>();
    try {
      assertFilePath(payload.entry);
      for (const rawFile of payload.files as Array<Record<string, unknown>>) {
        if (!rawFile || typeof rawFile !== 'object' || typeof rawFile.path !== 'string' ||
          typeof rawFile.hash !== 'string' || !/^[0-9a-f]{64}$/.test(rawFile.hash) ||
          typeof rawFile.size !== 'number' || !Number.isSafeInteger(rawFile.size) || rawFile.size < 0 ||
          typeof rawFile.type !== 'string') {
          throw new Error('Invalid publication file entry');
        }
        assertFilePath(rawFile.path);
        if (rawFile.size > RESOURCE_LIMITS.file_bytes) throw new HttpError(413, 'peer_publication_file_too_large');
        const entry = { path: rawFile.path, hash: rawFile.hash, size: rawFile.size, type: rawFile.type };
        files.set(entry.path, entry);
        const dup = required.get(entry.hash);
        if (dup && dup.size !== entry.size) throw new Error('Conflicting file size for content hash');
        required.set(entry.hash, entry);
      }
      const entryFile = files.get(payload.entry);
      if (!entryFile || !/\.html?$/i.test(entryFile.path) || !/^text\/html(?:;|$)/i.test(entryFile.type)) {
        throw new Error('The publication entry must be an authored HTML file');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'peer_publication_invalid', error instanceof Error ? error.message : 'Invalid page entry');
    }

    if (!Array.isArray(value.assets) || value.assets.length > files.size) {
      throw new HttpError(400, 'peer_publication_assets_invalid');
    }
    let total = 0;
    const supplied = new Map<string, Uint8Array>();
    for (const inputAsset of value.assets) {
      const asset = record(inputAsset, ['hash', 'bytes']);
      if (typeof asset.hash !== 'string' || !required.has(asset.hash) || supplied.has(asset.hash)) {
        throw new HttpError(400, 'peer_publication_assets_invalid', 'Only unique referenced code content may reach the host');
      }
      const bytes = assetBytes(asset.bytes);
      total += bytes.byteLength;
      if (total > CONTENT_LIMIT) throw new HttpError(413, 'peer_publication_too_large');
      if (bytes.byteLength !== required.get(asset.hash)!.size || (await sha256Hex(bytes)) !== asset.hash) {
        throw new HttpError(400, 'peer_publication_assets_invalid', 'Asset content hash or size mismatch');
      }
      supplied.set(asset.hash, bytes);
    }
    for (const [hash, file] of required) {
      const stored = t.db.one<{ size: number; status: string }>('SELECT size,status FROM stored_files WHERE hash=?', hash);
      if (stored?.status === 'ready' && stored.size === file.size) continue;
      if (!supplied.has(hash)) {
        throw new HttpError(409, 'peer_publication_content_missing', 'A code publication requires every referenced asset');
      }
    }

    // Pre-genesis bootstrap publication (browser-first flow): authorize against prepared `publisherKeys`,
    // store immutable R2 assets, and serve v1 so the owner's browser can initialize Chronolog v2 genesis.
    if (!genesisBytes || !state) {
      if (!config?.publisherKeys?.includes(parsed.author)) {
        throw new HttpError(403, 'publisher_required', 'Author is not in prepared publisherKeys');
      }
      await storeSuppliedAssets(t, principal, supplied, required);
      const release: ControlRelease = {
        revision: 0,
        opId: parsed.opId,
        author: parsed.author,
        timestampMs: Number(parsed.authorTimestampMs),
        entry: payload.entry,
        files: [...files.values()],
      };
      let receipt: PeerPublicationReceipt | null = null;
      await createVersion(t, files, null, parsed.author, {
        entry: payload.entry,
        beforeCommit: () => freshAuthorityAccess(t, principal),
        commit(version) {
          t.db.set(`v2_pub_version:${parsed.opId}`, version);
          receipt = { opId: parsed.opId, revision: 0, version, release, finalized: false };
          t.db.set(`v2_pub_receipt:${parsed.opId}`, receipt);
          t.db.set('v2_bootstrap_pub_receipt', receipt);
          notifyDiscoveryWatchers(t);
        },
      });
      if (receipt === null) throw new HttpError(500, 'peer_publication_receipt_missing');
      return structuredClone(receipt);
    }

    // Replay the candidate publication op through TopicKernel BEFORE writing assets or versions!
    // Stored control ops were verified when inserted.
    const allOps: KernelOperationInput[] = listPublicOpRows(t).map(storedKernelOp);
    allOps.push(parsed.kernelInput);
    const checkpoints = listCheckpointRows(t).map(r => decodeRecord<FinalityCheckpoint>(r.raw));
    const nextState = await replayBlindHostControl({
      genesisBytes,
      publicCas: listPublicCasRows(t),
      publicOps: allOps,
      checkpoints,
    });
    const accepted = nextState.publications.current?.opId === parsed.opId ||
      nextState.publications.history.some(h => h.opId === parsed.opId);
    if (!accepted) {
      // Distinguish unauthorized publisher vs revision conflict for clear caller errors.
      const isPub = state.permissions.publishers.has(parsed.author) || state.permissions.administrators.has(parsed.author);
      if (!isPub) throw new HttpError(403, 'publisher_required', 'Author is not an authorized publisher or administrator');
      throw new HttpError(409, 'peer_publication_rejected', 'The $publications reducer rejected this release');
    }

    // Store all referenced assets in R2 before creating the DO version.
    await storeSuppliedAssets(t, principal, supplied, required);

    const release: ControlRelease = nextState.publications.current?.opId === parsed.opId
      ? nextState.publications.current
      : {
          revision: nextState.publications.revision,
          opId: parsed.opId,
          author: parsed.author,
          timestampMs: Number(parsed.authorTimestampMs),
          entry: payload.entry,
          files: [...files.values()],
        };

    let receipt: PeerPublicationReceipt | null = null;
    await createVersion(t, files, null, parsed.author, {
      entry: payload.entry,
      beforeCommit: () => freshAuthorityAccess(t, principal),
      commit(version) {
        const copy = new Uint8Array(rawOp.byteLength); copy.set(rawOp);
        t.db.run('INSERT OR IGNORE INTO v2_public_ops(op_id, author, author_ts, raw) VALUES(?, ?, ?, ?)',
          parsed.opId, parsed.author, Number(parsed.authorTimestampMs), copy.buffer);
        t.db.set('v2_publications_managed', true);
        t.db.set(`v2_pub_version:${parsed.opId}`, version);
        const finalized = nextState.hasActiveFinality && nextState.finalizedPublications?.current?.opId === parsed.opId;
        receipt = { opId: parsed.opId, revision: release.revision, version, release, finalized };
        t.db.set(`v2_pub_receipt:${parsed.opId}`, receipt);
        // Reconcile `current` according to finality policy (if finality is active and this release is not yet finalized,
        // `current` stays on the last finalized version rather than advancing provisionally!).
        reconcileHostEffects(t, nextState);
        notifyDiscoveryWatchers(t);
      },
    });
    if (receipt === null) throw new HttpError(500, 'peer_publication_receipt_missing');
    return structuredClone(receipt);
  }).catch(authorityError);
}
