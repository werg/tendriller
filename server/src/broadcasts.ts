/**
 * System-wide Ed25519-signed broadcasts, signing key management, and fleet version tracking.
 */
import {
  BROADCAST_AUDIENCES,
  BROADCAST_LIMITS,
  BROADCAST_SCHEMA_VERSION,
  generateBroadcastKeyPair,
  publicJwkFromPrivate,
  signBroadcastPayload,
  validateBroadcastInput,
  validateBroadcastKey,
  validateClientVersions,
  type BroadcastAudience,
  type BroadcastPayload,
  type BroadcastPrivateJwk,
  type BroadcastPublicJwk,
  type ClientVersions,
  type SignedBroadcast,
} from '../../contract/broadcasts.mjs';
import type { Env } from './env';
import { HttpError } from './http';
import { BROADCAST_ID_RE, newBroadcastId, safeEqual, sha256Hex } from './ids';
import { publicBase } from './urls';

interface BroadcastRow {
  seq: number;
  id: string;
  kind: string;
  severity: string;
  audiences: string;
  title: string;
  summary: string;
  body: string;
  docs_url: string | null;
  action_json: string | null;
  match_json: string | null;
  dismissible: number;
  issuer: string;
  payload_json: string;
  signature_alg: string;
  signature_kid: string;
  signature_b64: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  superseded_by: string | null;
}

export interface StoredBroadcastRecord extends SignedBroadcast {
  created_by: string;
  revoked_at: number | null;
}

export interface BroadcastListResponse {
  issuer: string;
  keys: BroadcastPublicJwk[];
  latest_seq: number;
  etag: string;
  broadcasts: SignedBroadcast[];
}

function issuerOrigin(env: Env): string {
  return new URL(publicBase(env)).origin;
}

async function parseConfiguredPrivateKey(raw: string): Promise<BroadcastPrivateJwk> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(500, 'broadcast_key_invalid', 'BROADCAST_SIGNING_JWK is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || parsed.kty !== 'OKP' || parsed.crv !== 'Ed25519' || typeof parsed.x !== 'string' || typeof parsed.d !== 'string') {
    throw new HttpError(500, 'broadcast_key_invalid', 'BROADCAST_SIGNING_JWK must be an Ed25519 OKP private JWK');
  }
  let kid = typeof parsed.kid === 'string' && parsed.kid.trim() ? parsed.kid.trim() : '';
  if (!kid) {
    const hash = await sha256Hex(parsed.x);
    kid = 'bk_' + hash.slice(0, 16);
  }
  const jwk: BroadcastPrivateJwk = { kid, kty: 'OKP', crv: 'Ed25519', x: parsed.x, d: parsed.d };
  // Validate structure strictly.
  publicJwkFromPrivate(jwk);
  return jwk;
}

function parseAdditionalPublicKeys(raw: string | undefined): BroadcastPublicJwk[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { keys?: unknown }).keys) ? (parsed as { keys: unknown[] }).keys : []);
    return list.filter(validateBroadcastKey);
  } catch {
    return [];
  }
}

async function ensureSigningKey(env: Env): Promise<BroadcastPrivateJwk> {
  if (env.BROADCAST_SIGNING_JWK?.trim()) {
    return parseConfiguredPrivateKey(env.BROADCAST_SIGNING_JWK.trim());
  }
  if (!env.ACCOUNTS) throw new HttpError(503, 'unavailable', 'Accounts database is not configured');
  const existing = await env.ACCOUNTS.prepare('SELECT kid, private_jwk FROM broadcast_keys WHERE active = 1 AND private_jwk IS NOT NULL ORDER BY created_at DESC LIMIT 1')
    .first<{ kid: string; private_jwk: string }>();
  if (existing?.private_jwk) {
    return JSON.parse(existing.private_jwk) as BroadcastPrivateJwk;
  }
  const generated = await generateBroadcastKeyPair();
  await env.ACCOUNTS.prepare('INSERT OR IGNORE INTO broadcast_keys (kid, public_jwk, private_jwk, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .bind(generated.kid, JSON.stringify(generated.publicJwk), JSON.stringify(generated.privateJwk), Date.now()).run();
  const winner = await env.ACCOUNTS.prepare('SELECT private_jwk FROM broadcast_keys WHERE active = 1 AND private_jwk IS NOT NULL ORDER BY created_at ASC LIMIT 1')
    .first<{ private_jwk: string }>();
  return winner?.private_jwk ? JSON.parse(winner.private_jwk) as BroadcastPrivateJwk : generated.privateJwk;
}

/** Public Ed25519 keys trusted to verify signed broadcasts from this service origin. Never leaks private material. */
export async function publicBroadcastKeys(env: Env): Promise<{ issuer: string; keys: BroadcastPublicJwk[] }> {
  const issuer = issuerOrigin(env);
  const byKid = new Map<string, BroadcastPublicJwk>();
  if (env.BROADCAST_SIGNING_JWK?.trim()) {
    const priv = await parseConfiguredPrivateKey(env.BROADCAST_SIGNING_JWK.trim());
    const pub = publicJwkFromPrivate(priv);
    byKid.set(pub.kid, pub);
  }
  for (const extra of parseAdditionalPublicKeys(env.BROADCAST_PUBLIC_JWKS)) {
    byKid.set(extra.kid, extra);
  }
  if (env.ACCOUNTS) {
    try {
      const rows = await env.ACCOUNTS.prepare('SELECT public_jwk FROM broadcast_keys ORDER BY active DESC, created_at DESC LIMIT 16')
        .all<{ public_jwk: string }>();
      for (const row of rows.results) {
        try {
          const parsed = JSON.parse(row.public_jwk) as unknown;
          if (validateBroadcastKey(parsed) && !byKid.has(parsed.kid)) byKid.set(parsed.kid, parsed);
        } catch { /* ignore corrupt row */ }
      }
      if (byKid.size === 0 && !env.BROADCAST_SIGNING_JWK?.trim()) {
        const key = await ensureSigningKey(env);
        const pub = publicJwkFromPrivate(key);
        byKid.set(pub.kid, pub);
      }
    } catch { /* table not yet applied in partial migration tests */ }
  }
  return { issuer, keys: [...byKid.values()] };
}

function rowToSigned(row: BroadcastRow): SignedBroadcast {
  const payload = JSON.parse(row.payload_json) as BroadcastPayload;
  return {
    payload,
    signature: {
      alg: 'Ed25519',
      kid: row.signature_kid,
      sig: row.signature_b64,
    },
  };
}

/** Create and Ed25519-sign a new system broadcast, persisting it in D1 and recording an audit entry. */
export async function createBroadcast(env: Env, actor: string, rawInput: unknown): Promise<SignedBroadcast> {
  if (!env.ACCOUNTS) throw new HttpError(503, 'unavailable', 'Accounts database is not configured');
  let input: ReturnType<typeof validateBroadcastInput>;
  try { input = validateBroadcastInput(rawInput); }
  catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid broadcast'); }
  const now = Date.now();
  if (input.expires_at !== null && input.expires_at <= now) {
    throw new HttpError(400, 'bad_request', 'expires_at must be in the future');
  }
  const signingKey = await ensureSigningKey(env);
  const id = newBroadcastId();
  const issuer = issuerOrigin(env);
  // Reserve the monotonic sequence number first so `seq` is embedded inside the signed payload.
  const inserted = await env.ACCOUNTS.prepare(`INSERT INTO system_broadcasts (
      id, kind, severity, audiences, title, summary, body, docs_url, action_json, match_json,
      dismissible, issuer, payload_json, signature_alg, signature_kid, signature_b64, created_by, created_at, expires_at, superseded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'Ed25519', ?, '', ?, ?, ?, ?) RETURNING seq`)
    .bind(
      id, input.kind, input.severity, JSON.stringify(input.audiences), input.title, input.summary, input.body,
      input.docs_url, input.action ? JSON.stringify(input.action) : null, input.match ? JSON.stringify(input.match) : null,
      input.dismissible ? 1 : 0, issuer, signingKey.kid, actor, now, input.expires_at, input.superseded_by,
    ).first<{ seq: number }>();
  if (!inserted) throw new HttpError(500, 'broadcast_create_failed', 'Could not allocate broadcast sequence');
  const payload: BroadcastPayload = {
    schema_version: BROADCAST_SCHEMA_VERSION,
    id,
    seq: inserted.seq,
    issuer,
    kind: input.kind,
    severity: input.severity,
    audiences: input.audiences,
    title: input.title,
    summary: input.summary,
    body: input.body,
    docs_url: input.docs_url,
    action: input.action,
    match: input.match,
    dismissible: input.dismissible,
    created_at: now,
    expires_at: input.expires_at,
    superseded_by: input.superseded_by,
  };
  const signed = await signBroadcastPayload(payload, signingKey);
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare('UPDATE system_broadcasts SET payload_json = ?, signature_alg = ?, signature_kid = ?, signature_b64 = ? WHERE id = ?')
      .bind(JSON.stringify(payload), signed.signature.alg, signed.signature.kid, signed.signature.sig, id),
    env.ACCOUNTS.prepare('INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), actor, 'broadcast_publish', id, `${input.kind}/${input.severity}: ${input.title}`, now),
  ]);
  return signed;
}

export async function revokeBroadcast(env: Env, actor: string, id: string, reason = 'Revoked by administrator'): Promise<boolean> {
  if (!env.ACCOUNTS) throw new HttpError(503, 'unavailable', 'Accounts database is not configured');
  if (!BROADCAST_ID_RE.test(id)) throw new HttpError(400, 'bad_request', 'Invalid broadcast id');
  const now = Date.now();
  const res = await env.ACCOUNTS.prepare('UPDATE system_broadcasts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id')
    .bind(now, id).first();
  if (!res) return false;
  await env.ACCOUNTS.prepare('INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), actor, 'broadcast_revoke', id, reason.slice(0, 500), now).run();
  return true;
}

/** Query active signed broadcasts, optionally filtered by audience(s) and sequence cursor. */
export async function listActiveBroadcasts(env: Env, options: {
  audience?: BroadcastAudience;
  audiences?: readonly BroadcastAudience[];
  since?: number;
  limit?: number;
} = {}): Promise<BroadcastListResponse> {
  const { issuer, keys } = await publicBroadcastKeys(env);
  if (!env.ACCOUNTS) {
    return { issuer, keys, latest_seq: 0, etag: '"bc-empty"', broadcasts: [] };
  }
  const now = Date.now();
  const since = Number.isSafeInteger(options.since) && (options.since as number) > 0 ? (options.since as number) : 0;
  const limit = Math.min(BROADCAST_LIMITS.listMax, Math.max(1, options.limit ?? BROADCAST_LIMITS.listMax));
  const wantedAudiences = options.audiences?.length
    ? options.audiences
    : options.audience
      ? [options.audience]
      : null;
  let rows: BroadcastRow[] = [];
  let maxSeq = 0;
  try {
    const [latest, active] = await Promise.all([
      env.ACCOUNTS.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM system_broadcasts').first<{ max_seq: number }>(),
      env.ACCOUNTS.prepare(`SELECT * FROM system_broadcasts
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND seq > ? AND signature_b64 != ''
        ORDER BY seq DESC LIMIT ?`).bind(now, since, limit * 2).all<BroadcastRow>(),
    ]);
    maxSeq = latest?.max_seq ?? 0;
    rows = active.results;
  } catch {
    return { issuer, keys, latest_seq: 0, etag: '"bc-empty"', broadcasts: [] };
  }
  const signed: SignedBroadcast[] = [];
  for (const row of rows) {
    if (signed.length >= limit) break;
    const item = rowToSigned(row);
    if (wantedAudiences && !wantedAudiences.some(a => item.payload.audiences.includes(a))) continue;
    signed.push(item);
  }
  // Return oldest-to-newest so sequential cursor consumers process in order.
  signed.reverse();
  const fingerprint = await sha256Hex(JSON.stringify({
    maxSeq,
    kids: keys.map(k => k.kid),
    ids: signed.map(b => [b.payload.id, b.payload.seq]),
  }));
  return {
    issuer,
    keys,
    latest_seq: maxSeq,
    etag: `"bc-${fingerprint.slice(0, 20)}"`,
    broadcasts: signed,
  };
}

/** Admin view including recently revoked/expired broadcasts. */
export async function listAllBroadcastsForAdmin(env: Env, limit = 50): Promise<StoredBroadcastRecord[]> {
  if (!env.ACCOUNTS) return [];
  try {
    const rows = await env.ACCOUNTS.prepare("SELECT * FROM system_broadcasts WHERE signature_b64 != '' ORDER BY seq DESC LIMIT ?")
      .bind(limit).all<BroadcastRow>();
    return rows.results.map(row => ({
      ...rowToSigned(row),
      created_by: row.created_by,
      revoked_at: row.revoked_at,
    }));
  } catch {
    return [];
  }
}

/** Lightweight readiness summary (never throws if migration hasn't run). */
export async function broadcastSummary(env: Env): Promise<{ latestSeq: number; activeCount: number; criticalCount: number }> {
  if (!env.ACCOUNTS) return { latestSeq: 0, activeCount: 0, criticalCount: 0 };
  try {
    const now = Date.now();
    const row = await env.ACCOUNTS.prepare(`SELECT
      COALESCE(MAX(seq), 0) AS latest_seq,
      SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND signature_b64 != '' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND signature_b64 != '' AND severity IN ('urgent', 'critical') THEN 1 ELSE 0 END) AS critical_count
      FROM system_broadcasts`).bind(now, now).first<{ latest_seq: number; active_count: number | null; critical_count: number | null }>();
    return {
      latestSeq: row?.latest_seq ?? 0,
      activeCount: row?.active_count ?? 0,
      criticalCount: row?.critical_count ?? 0,
    };
  } catch {
    return { latestSeq: 0, activeCount: 0, criticalCount: 0 };
  }
}

/** Record an agent's self-reported package/runtime versions in D1. */
export async function recordAgentVersions(env: Env, agentId: string, rawVersions: unknown): Promise<ClientVersions> {
  if (!env.ACCOUNTS) throw new HttpError(503, 'unavailable');
  let versions: ClientVersions;
  try { versions = validateClientVersions(rawVersions); }
  catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid client versions'); }
  const now = Date.now();
  await env.ACCOUNTS.prepare(`INSERT INTO agent_versions (
      agent_id, core_version, tools_version, chronolog_version, authority_version, node_version, kit_id, packages_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      core_version = excluded.core_version,
      tools_version = excluded.tools_version,
      chronolog_version = excluded.chronolog_version,
      authority_version = excluded.authority_version,
      node_version = excluded.node_version,
      kit_id = excluded.kit_id,
      packages_json = excluded.packages_json,
      updated_at = excluded.updated_at`)
    .bind(
      agentId,
      versions.core ?? null,
      versions.tools ?? null,
      versions.chronolog ?? null,
      versions.authority ?? null,
      versions.node ?? null,
      versions.kit ?? null,
      versions.packages ? JSON.stringify(versions.packages) : null,
      now,
    ).run();
  return versions;
}

export async function getAgentVersions(env: Env, agentId: string): Promise<(ClientVersions & { updated_at: number }) | null> {
  if (!env.ACCOUNTS) return null;
  try {
    const row = await env.ACCOUNTS.prepare('SELECT core_version, tools_version, chronolog_version, authority_version, node_version, kit_id, packages_json, updated_at FROM agent_versions WHERE agent_id = ?')
      .bind(agentId).first<{ core_version: string | null; tools_version: string | null; chronolog_version: string | null; authority_version: string | null; node_version: string | null; kit_id: string | null; packages_json: string | null; updated_at: number }>();
    if (!row) return null;
    return {
      ...(row.core_version ? { core: row.core_version } : {}),
      ...(row.tools_version ? { tools: row.tools_version } : {}),
      ...(row.chronolog_version ? { chronolog: row.chronolog_version } : {}),
      ...(row.authority_version ? { authority: row.authority_version } : {}),
      ...(row.node_version ? { node: row.node_version } : {}),
      ...(row.kit_id ? { kit: row.kit_id } : {}),
      ...(row.packages_json ? { packages: JSON.parse(row.packages_json) as Record<string, string> } : {}),
      updated_at: row.updated_at,
    };
  } catch {
    return null;
  }
}

/** Record a page's latest published runtime version in D1 for fleet observability. */
export async function recordPageVersion(env: Env, pageId: string, version: number, runtimeId: string, runtimeVersion: string, publishedAt: number): Promise<void> {
  if (!env.ACCOUNTS) return;
  try {
    await env.ACCOUNTS.prepare(`INSERT INTO page_versions (page_id, version, runtime_id, runtime_version, published_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET
        version = excluded.version,
        runtime_id = excluded.runtime_id,
        runtime_version = excluded.runtime_version,
        published_at = excluded.published_at`)
      .bind(pageId, version, runtimeId, runtimeVersion, publishedAt).run();
  } catch { /* Non-fatal if table absent in minimal test fixtures */ }
}

export interface FleetVersionSummary {
  agents: {
    total: number;
    reporting: number;
    byCore: Array<{ version: string; count: number }>;
    byChronolog: Array<{ version: string; count: number }>;
    byTools: Array<{ version: string; count: number }>;
  };
  pages: {
    published: number;
    agentlessPublished: number;
    byRuntime: Array<{ version: string; runtimeId: string; count: number }>;
  };
}

/** Fleet version breakdown for /admin (zero dormant DO wakeups). */
export async function fleetVersionSummary(env: Env): Promise<FleetVersionSummary> {
  const empty: FleetVersionSummary = {
    agents: { total: 0, reporting: 0, byCore: [], byChronolog: [], byTools: [] },
    pages: { published: 0, agentlessPublished: 0, byRuntime: [] },
  };
  if (!env.ACCOUNTS) return empty;
  try {
    const [agentTotals, byCore, byChronolog, byTools, pageTotals, byRuntime] = await Promise.all([
      env.ACCOUNTS.prepare(`SELECT
        (SELECT COUNT(*) FROM agents WHERE revoked_at IS NULL) AS total,
        (SELECT COUNT(*) FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.revoked_at IS NULL) AS reporting`).first<{ total: number; reporting: number }>(),
      env.ACCOUNTS.prepare(`SELECT COALESCE(v.core_version, 'unknown') AS version, COUNT(*) AS count
        FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.revoked_at IS NULL
        GROUP BY version ORDER BY count DESC, version DESC LIMIT 20`).all<{ version: string; count: number }>(),
      env.ACCOUNTS.prepare(`SELECT COALESCE(v.chronolog_version, 'unknown') AS version, COUNT(*) AS count
        FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.revoked_at IS NULL
        GROUP BY version ORDER BY count DESC, version DESC LIMIT 20`).all<{ version: string; count: number }>(),
      env.ACCOUNTS.prepare(`SELECT COALESCE(v.tools_version, 'unknown') AS version, COUNT(*) AS count
        FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE a.revoked_at IS NULL
        GROUP BY version ORDER BY count DESC, version DESC LIMIT 20`).all<{ version: string; count: number }>(),
      env.ACCOUNTS.prepare(`SELECT
        COUNT(*) AS published,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM agent_grants g JOIN agents a ON a.id = g.agent_id WHERE g.page_id = pv.page_id AND a.revoked_at IS NULL) THEN 1 ELSE 0 END) AS agentless
        FROM page_versions pv JOIN tendrils t ON t.id = pv.page_id WHERE t.state = 'active'`).first<{ published: number; agentless: number | null }>(),
      env.ACCOUNTS.prepare(`SELECT pv.runtime_version AS version, pv.runtime_id AS runtimeId, COUNT(*) AS count
        FROM page_versions pv JOIN tendrils t ON t.id = pv.page_id WHERE t.state = 'active'
        GROUP BY pv.runtime_version, pv.runtime_id ORDER BY count DESC, pv.runtime_version DESC LIMIT 20`).all<{ version: string; runtimeId: string; count: number }>(),
    ]);
    return {
      agents: {
        total: agentTotals?.total ?? 0,
        reporting: agentTotals?.reporting ?? 0,
        byCore: byCore.results,
        byChronolog: byChronolog.results,
        byTools: byTools.results,
      },
      pages: {
        published: pageTotals?.published ?? 0,
        agentlessPublished: pageTotals?.agentless ?? 0,
        byRuntime: byRuntime.results,
      },
    };
  } catch {
    return empty;
  }
}

/** Verify optional bearer BROADCAST_ADMIN_TOKEN for operator/CI broadcast API calls. */
export async function checkBroadcastAdminToken(req: Request, env: Env): Promise<boolean> {
  const configured = env.BROADCAST_ADMIN_TOKEN?.trim();
  if (!configured) return false;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!bearer) return false;
  return safeEqual(await sha256Hex(bearer), await sha256Hex(configured));
}

export function validAudienceParam(raw: string | null): BroadcastAudience | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim() as BroadcastAudience;
  if (!BROADCAST_AUDIENCES.includes(trimmed)) {
    throw new HttpError(400, 'bad_request', `audience must be one of ${BROADCAST_AUDIENCES.join(', ')}`);
  }
  return trimmed;
}
