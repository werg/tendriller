/**
 * Tendriller Edge CAS Mirror & Binary CBOR Sync-v3 Endpoint powered by Chronolog's
 * WinterCG `@chronolog/peer-session/mirror`.
 *
 * Unifies public CAS nodes (`v2_public_cas`), public-log mailbox CAS (`v2_mailbox_cas`),
 * R2 publication blobs (`stored_files` via Workers Cache API `immutableObject`), and
 * O(log N) binary CBOR sync-v3 reconciliation behind one verified HTTP surface:
 *   - GET/HEAD/PUT /_tendril/cas/sha256-<hash>     (plus ?subgraph=1 CBOR bundle, ETag/304, Range/206)
 *   - POST /_tendril/cas/batch                     (CBOR subgraph upload)
 *   - GET/PUT /_tendril/derivations/sha256-<hash>  (Ed25519-verified build attestations)
 *   - GET/PUT /_tendril/audits/sha256-<hash>       (Ed25519-verified audit attestations)
 *   - GET/HEAD /_tendril/trees/sha256-<hash>/*     (chronolog-tree/v1 static serving with 304/Range)
 *   - POST /_tendril/sync/control                  (binary CBOR sync-v3 public control reconciliation)
 *   - POST /_tendril/sync/mailbox                  (binary CBOR sync-v3 blind mailbox reconciliation)
 */
import {
  createCasMirrorHandler,
  createHttpSyncHandler,
  type BlindSyncStore,
  type CasMirrorStore,
  type HttpSyncFactItem,
  type MirrorAuditAttestation,
  type MirrorBuildAttestation,
} from '@chronolog/peer-session/mirror';
import { allows, type Principal } from './access';
import {
  listMailboxEnvelopeRows,
  listMailboxPublicOpRows,
  listPublicOpRows,
  readControlState,
  validateMailboxEnvelopes,
  type MaterializedControlState,
} from './authority';
import { hostRevision, notifyDiscoveryWatchers } from './discovery';
import { fileKey } from './files';
import { immutableObject } from './immutable-cache';
import { guessType } from './mime';
import { notifyMcpSyncWatchers } from './publication-watch';
import type { Tendril } from './tendril';

const MAX_ATTESTATIONS_PER_HASH = 32;
const MAX_MIRROR_CAS_NODES = 1024;
const MAX_MIRROR_CAS_TOTAL_BYTES = 8 * 1024 * 1024;

export const CAS_MIRROR_ROUTE = /^(?:cas\/(?:batch|(?:sha256-)?[0-9a-f]{64})|(?:derivations|audits)\/(?:sha256-)?[0-9a-f]{64}|trees\/(?:sha256-)?[0-9a-f]{64}(?:\/.*)?|sync\/(?:control|mailbox))$/u;

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
}

function createTendrilMirrorStore(t: Tendril, privateLog: boolean): CasMirrorStore {
  return {
    async hasNode(hash: string): Promise<boolean> {
      if (t.db.one('SELECT 1 AS x FROM v2_public_cas WHERE hash = ?', hash)) return true;
      if (!privateLog && t.db.one('SELECT 1 AS x FROM v2_mailbox_cas WHERE hash = ? AND partition = ?', hash, 'public')) return true;
      if (t.db.one("SELECT 1 AS x FROM stored_files WHERE hash = ? AND status = 'ready'", hash)) return true;
      return false;
    },

    async getNode(hash: string): Promise<Uint8Array | null> {
      const pubRow = t.db.one<{ bytes: ArrayBuffer | Uint8Array }>('SELECT bytes FROM v2_public_cas WHERE hash = ?', hash);
      if (pubRow) return asBytes(pubRow.bytes);
      if (!privateLog) {
        const mbRow = t.db.one<{ bytes: ArrayBuffer | Uint8Array }>(
          'SELECT bytes FROM v2_mailbox_cas WHERE hash = ? AND partition = ?',
          hash, 'public',
        );
        if (mbRow) return asBytes(mbRow.bytes);
      }
      if (t.env.FILES && t.db.one("SELECT 1 AS x FROM stored_files WHERE hash = ? AND status = 'ready'", hash)) {
        const resp = await immutableObject(t.env, fileKey(t, hash), { context: t.ctx });
        if (resp) return new Uint8Array(await resp.arrayBuffer());
      }
      return null;
    },

    async putNode(hash: string, encodedNode: Uint8Array): Promise<void> {
      if (t.db.one('SELECT 1 AS x FROM v2_public_cas WHERE hash = ?', hash)) return;
      const stats = t.db.one<{ n: number; total: number }>(
        'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(bytes)), 0) AS total FROM v2_public_cas',
      );
      if ((stats?.n ?? 0) >= MAX_MIRROR_CAS_NODES || (stats?.total ?? 0) + encodedNode.byteLength > MAX_MIRROR_CAS_TOTAL_BYTES) {
        throw new Error('MIRROR_CAS_QUOTA_EXCEEDED');
      }
      const copy = new Uint8Array(encodedNode.byteLength);
      copy.set(encodedNode);
      t.db.run('INSERT OR IGNORE INTO v2_public_cas(hash, bytes) VALUES(?, ?)', hash, copy.buffer);
    },

    async listAttestations(drvHash: string): Promise<readonly MirrorBuildAttestation[]> {
      return t.db.get<MirrorBuildAttestation[]>(`cas_drv:${drvHash}`, []);
    },

    async putAttestation(drvHash: string, attestation: MirrorBuildAttestation): Promise<void> {
      const key = `cas_drv:${drvHash}`;
      const existing = t.db.get<MirrorBuildAttestation[]>(key, []);
      if (existing.some(a =>
        a.signer === attestation.signer &&
        a.payload.outputRef === attestation.payload.outputRef &&
        a.payload.runtime === attestation.payload.runtime,
      )) return;
      const next = [...existing, attestation].slice(-MAX_ATTESTATIONS_PER_HASH);
      t.db.set(key, next);
    },

    async listAudits(pkgHash: string): Promise<readonly MirrorAuditAttestation[]> {
      return t.db.get<MirrorAuditAttestation[]>(`cas_audit:${pkgHash}`, []);
    },

    async putAudit(pkgHash: string, audit: MirrorAuditAttestation): Promise<void> {
      const key = `cas_audit:${pkgHash}`;
      const existing = t.db.get<MirrorAuditAttestation[]>(key, []);
      if (existing.some(a =>
        a.signer === audit.signer &&
        a.payload.verdict === audit.payload.verdict &&
        (a.payload.notes ?? '') === (audit.payload.notes ?? ''),
      )) return;
      const next = [...existing, audit].slice(-MAX_ATTESTATIONS_PER_HASH);
      t.db.set(key, next);
    },
  };
}

function createTendrilBlindSyncStore(t: Tendril, state: MaterializedControlState): BlindSyncStore {
  return {
    async listIds(scope) {
      if (scope === 'control') {
        return t.db.all<{ op_id: string }>('SELECT op_id FROM v2_public_ops').map(r => r.op_id);
      }
      if (state.genesis.privateLog) {
        return t.db.all<{ digest: string }>('SELECT digest FROM v2_mailbox_envelopes').map(r => r.digest);
      }
      return t.db.all<{ op_id: string; author: string }>('SELECT op_id, author FROM v2_mailbox_ops')
        .filter(r => !state.permissions.blockedAuthors.has(r.author))
        .map(r => r.op_id);
    },

    async getFacts(scope, ids) {
      const want = new Set(ids);
      const out: HttpSyncFactItem[] = [];
      if (scope === 'control') {
        for (const row of listPublicOpRows(t)) {
          if (want.has(row.op_id)) out.push({ id: row.op_id, bytes: row.raw });
        }
        return out;
      }
      if (state.genesis.privateLog) {
        for (const row of listMailboxEnvelopeRows(t)) {
          if (want.has(row.digest)) out.push({ id: row.digest, bytes: row.raw });
        }
        return out;
      }
      for (const row of listMailboxPublicOpRows(t)) {
        if (want.has(row.op_id) && !state.permissions.blockedAuthors.has(row.author)) {
          out.push({ id: row.op_id, bytes: row.raw });
        }
      }
      return out;
    },

    async putFacts(scope, items, casPush) {
      if (scope === 'mailbox' && state.genesis.privateLog) {
        const accepted = validateMailboxEnvelopes(t, state, items.map(i => i.bytes));
        const now = t.now();
        if (accepted.length > 0) {
          t.transaction(() => {
            for (const env of accepted) {
              const copy = new Uint8Array(env.raw.byteLength);
              copy.set(env.raw);
              t.db.run(
                'INSERT OR IGNORE INTO v2_mailbox_envelopes(digest, epoch, author, raw, stored_at) VALUES(?, ?, ?, ?, ?)',
                env.digest, env.epoch, env.author, copy.buffer, now,
              );
            }
          });
          notifyMcpSyncWatchers(t);
          notifyDiscoveryWatchers(t, 'm');
        }
        return { accepted: accepted.length, meta: { logId: state.logId, privateLog: true, revision: hostRevision(t, 'm') } };
      }
      // For public CAS nodes pushed on public-log sync
      if (!state.genesis.privateLog && casPush.length > 0) {
        const now = t.now();
        t.transaction(() => {
          for (const node of casPush) {
            const copy = new Uint8Array(node.bytes.byteLength);
            copy.set(node.bytes);
            t.db.run(
              'INSERT OR IGNORE INTO v2_mailbox_cas(hash, partition, bytes, stored_at) VALUES(?, ?, ?, ?)',
              node.hash, 'public', copy.buffer, now,
            );
          }
        });
      }
      return { accepted: 0, meta: { logId: state.logId, stateRoot: state.stateRoot, historyDigest: state.historyDigest } };
    },

    async getCasNodes(scope, hashes) {
      const out: { hash: string; bytes: Uint8Array }[] = [];
      for (const hash of hashes) {
        const pub = t.db.one<{ bytes: ArrayBuffer | Uint8Array }>('SELECT bytes FROM v2_public_cas WHERE hash = ?', hash);
        if (pub) { out.push({ hash, bytes: asBytes(pub.bytes) }); continue; }
        if (scope === 'mailbox' && !state.genesis.privateLog) {
          const mb = t.db.one<{ bytes: ArrayBuffer | Uint8Array }>(
            'SELECT bytes FROM v2_mailbox_cas WHERE hash = ? AND partition = ?',
            hash, 'public',
          );
          if (mb) out.push({ hash, bytes: asBytes(mb.bytes) });
        }
      }
      return out;
    },

    async getMeta(scope) {
      return {
        logId: state.logId,
        privateLog: state.genesis.privateLog,
        stateRoot: state.stateRoot,
        historyDigest: state.historyDigest,
        revision: hostRevision(t, scope === 'control' ? 'c' : 'm'),
      };
    },
  };
}

/**
 * Handle `/_tendril/{cas,derivations,audits,trees,sync}/*` requests inside a Tendril Durable Object.
 */
export async function handleCasMirror(
  t: Tendril,
  req: Request,
  sub: string,
  principal: Principal,
): Promise<Response> {
  const control = await readControlState(t);
  const orig = new URL(req.url);
  const rewrittenUrl = new URL(`/${sub}${orig.search}`, orig.origin);
  const forwarded = new Request(rewrittenUrl.toString(), {
    method: req.method,
    headers: req.headers,
    ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req.body } : {}),
  });

  if (sub === 'sync/control' || sub === 'sync/mailbox') {
    if (!control) {
      return new Response(JSON.stringify({ error: 'application_uninitialized' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const syncHandler = createHttpSyncHandler({ store: createTendrilBlindSyncStore(t, control) });
    return syncHandler(forwarded);
  }

  const privateLog = control?.genesis.privateLog ?? true;
  const store = createTendrilMirrorStore(t, privateLog);
  const handler = createCasMirrorHandler({
    store,
    resolveMediaType: path => guessType(path),
    authorizeWrite: (_r, kind) => {
      if (kind === 'derivation' || kind === 'audit') {
        return allows(principal, 'page.write') || allows(principal, 'page.owner');
      }
      return allows(principal, 'page.owner') || allows(principal, 'page.write');
    },
  });
  return handler(forwarded);
}
