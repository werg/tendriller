/**
 * Tendriller Edge CAS & Derivation Mirror powered by Chronolog's WinterCG `@chronolog/peer-session/mirror`.
 *
 * Unifies public CAS nodes (`v2_public_cas`), public-log mailbox CAS (`v2_mailbox_cas`),
 * and R2 publication blobs (`stored_files` via Workers Cache API `immutableObject`) behind
 * one verified HTTP surface:
 *   - GET/HEAD/PUT /_tendril/cas/sha256-<hash>  (plus ?subgraph=1 CBOR bundle, ETag/304, Range/206)
 *   - POST /_tendril/cas/batch                  (CBOR subgraph upload)
 *   - GET/PUT /_tendril/derivations/sha256-<hash> (Ed25519-verified build attestations)
 *   - GET/PUT /_tendril/audits/sha256-<hash>      (Ed25519-verified audit attestations)
 *   - GET/HEAD /_tendril/trees/sha256-<hash>/*    (chronolog-tree/v1 static serving with 304/Range)
 */
import {
  createCasMirrorHandler,
  type CasMirrorStore,
  type MirrorAuditAttestation,
  type MirrorBuildAttestation,
} from '@chronolog/peer-session/mirror';
import { allows, type Principal } from './access';
import { readControlState } from './authority';
import { fileKey } from './files';
import { immutableObject } from './immutable-cache';
import { guessType } from './mime';
import type { Tendril } from './tendril';

const MAX_ATTESTATIONS_PER_HASH = 32;
const MAX_MIRROR_CAS_NODES = 1024;
const MAX_MIRROR_CAS_TOTAL_BYTES = 8 * 1024 * 1024;

export const CAS_MIRROR_ROUTE = /^(?:cas\/(?:batch|(?:sha256-)?[0-9a-f]{64})|(?:derivations|audits)\/(?:sha256-)?[0-9a-f]{64}|trees\/(?:sha256-)?[0-9a-f]{64}(?:\/.*)?)$/u;

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

/**
 * Handle `/_tendril/{cas,derivations,audits,trees}/*` requests inside a Tendril Durable Object.
 * Rewrites the request path to `/${sub}` so Chronolog's `createCasMirrorHandler` works identically
 * across bare, keyed `/s/<key>/`, named-subdomain, and custom-domain page origins.
 */
export async function handleCasMirror(
  t: Tendril,
  req: Request,
  sub: string,
  principal: Principal,
): Promise<Response> {
  const control = await readControlState(t);
  const privateLog = control?.genesis.privateLog ?? true;
  const store = createTendrilMirrorStore(t, privateLog);
  const handler = createCasMirrorHandler({
    store,
    resolveMediaType: path => guessType(path),
    authorizeWrite: (_r, kind) => {
      if (kind === 'derivation' || kind === 'audit') {
        // Ed25519 signature is verified by Chronolog's handler; require page write or agent/owner access.
        return allows(principal, 'page.write') || allows(principal, 'page.owner');
      }
      return allows(principal, 'page.owner') || allows(principal, 'page.write');
    },
  });
  const orig = new URL(req.url);
  const rewrittenUrl = new URL(`/${sub}${orig.search}`, orig.origin);
  const forwarded = new Request(rewrittenUrl.toString(), {
    method: req.method,
    headers: req.headers,
    ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req.body } : {}),
  });
  return handler(forwarded);
}
