/**
 * Opt-in hosted Chronolog MCP participant inside the Tendril Durable Object.
 *
 * - Zero plaintext keys at rest: `mcp_connections.wrapped_keys` holds X25519-sealed
 *   `{ signingSeedHex, signingPublicKey, epochKeys }`, and `mcp_store` holds encrypted
 *   Chronolog envelopes only.
 * - On an authenticated `/mcp` call, the OAuth Bearer token delivers `wrapPrivateKey`
 *   in RAM -> unseals keys in RAM -> opens an in-memory Chronolog session (Events or
 *   ephemeral in-memory DoltLite WASM) -> executes signed pure `domain.js` inside QuickJS-WASM
 *   -> persists only encrypted envelopes back to `mcp_store` -> discards all plaintext keys.
 */
import {
  createApplicationSession, createAuthorityProvider, decodeRecord, defineApplication,
  emit, encodeRecord, hexToBytes, importSigningIdentity, openApplicationDevice, parseApplicationInput, platformOp, program, sqlStatement,
} from '@chronolog/peer-session';
import { activeGrant } from './accounts/oauth-data';
import { allows, type PagePrincipal } from './access';
import { addActivity } from './activity';
import { notifyRosterChanged, pageAgents, reconcilePrimaryAgent, validAgentBio, validAgentHandle } from './agent-grants';
import { selectedApplication } from './application';
import { readAuthorityBundle } from './authority';
import { fileKey, servedVersion } from './files';
import { HttpError, isPlainObject, json, readJson } from './http';
import { base64url } from './accounts/oauth-support';
import { hexToBytes as parseHex, normalizeEd25519Pkcs8Hex, sealHostedRequests, sealSqlCheckpoint, unbase64url, unsealHostedKeys, unsealHostedRequests, unsealSqlCheckpoint } from './mcp-crypto';
import { createEphemeralSqlMaterializer, doltliteExecutionManifestDigest } from './mcp-sql';
import { describeDomainBundle, runDomainCommand, runDomainQuery, type SandboxProgramStep, type SandboxReadBridge } from './mcp-sandbox';
import { mcpOAuth, REQUEST_LIMIT, requireScope, string, type McpPrincipal } from './mcp-shared';
import { MemoryBytesStore } from './mcp-store';
import { notifyMcpSyncWatchers } from './publication-watch';
import { requireWritesOpen } from './service-state';
import { notifySetupChanged } from './setup-watch';
import type { Tendril } from './tendril';

interface McpConnectionRow {
  grant_id: string;
  handle: string;
  bio: string;
  public_key: string;
  wrapped_keys: ArrayBuffer | Uint8Array;
  label: string;
  capabilities: string;
  created_at: number;
  updated_at: number;
}

interface McpCapabilities {
  read: boolean;
  write: boolean;
  queries: string[] | null;
  commands: string[] | null;
}

const DEFAULT_CAPABILITIES: McpCapabilities = { read: true, write: true, queries: null, commands: null };
const ENVELOPE_PREFIX = 'envelope/';
const SQL_CHECKPOINT_PREFIX = 'sql-checkpoint/';
const REQUESTS_PREFIX = 'hosted-requests/';
const DEFAULT_SQL_CHECKPOINT_THRESHOLD = 8;
const MAX_SQL_CHECKPOINT_BYTES = 4 * 1024 * 1024;

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
}

function parseCapabilities(raw: unknown): McpCapabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CAPABILITIES };
  const input = raw as Record<string, unknown>;
  const list = (val: unknown): string[] | null => {
    if (val === undefined || val === null) return null;
    if (!Array.isArray(val) || val.length > 64 || val.some(x => typeof x !== 'string' || !x.trim() || x.length > 128)) {
      throw new HttpError(400, 'invalid_capabilities');
    }
    return [...new Set(val)];
  };
  return {
    read: input.read !== false,
    write: input.write !== false,
    queries: list(input.queries),
    commands: list(input.commands),
  };
}

function readStoredCapabilities(row: McpConnectionRow): McpCapabilities {
  try { return parseCapabilities(JSON.parse(row.capabilities)); }
  catch { return { ...DEFAULT_CAPABILITIES }; }
}

/** Load the page's published signed `domain.js` bundle from R2 if present in the active version. */
async function loadPublishedDomainBundle(t: Tendril): Promise<string | null> {
  const v = servedVersion(t);
  if (v <= 0) return null;
  const row = t.db.one<{ hash: string }>(
    "SELECT hash FROM version_files WHERE version=? AND path IN ('domain.js', '_domain.js', 'domain.mjs')", v,
  );
  if (!row) return null;
  const obj = await t.env.FILES.get(fileKey(t, row.hash));
  if (!obj) return null;
  return await obj.text();
}

/**
 * Validate input against the signed domain bundle's declared schema before any program is prepared, exactly as a
 * Chronolog `defineCommand`/`defineQuery` does for local callers. Invalid input is never signed or stored.
 */
async function declaredInput(domainBundle: string, kind: 'commands' | 'queries', name: string, input: unknown): Promise<void> {
  const declared = (await describeDomainBundle(domainBundle))[kind].find(item => item.name === name);
  if (!declared) throw new HttpError(404, kind === 'commands' ? 'command_not_found' : 'query_not_found', `No declared ${kind === 'commands' ? 'command' : 'query'} ${name}.`);
  try { parseApplicationInput(declared.input as Parameters<typeof parseApplicationInput>[0], input); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    throw new HttpError(400, 'invalid_input', `Input does not match the declared schema for ${name}${code ? ` (${code})` : ''}.`);
  }
}

/** Convert pure QuickJS-produced steps into a real Chronolog program. */
function buildChronologProgram(steps: SandboxProgramStep[]) {
  const built = steps.map(step => {
    if (step.kind === 'emit') {
      if (typeof step.topic !== 'string' || !step.topic) throw new HttpError(400, 'invalid_program_step');
      return emit(step.topic, (step.payload ?? null) as any);
    }
    if (step.kind === 'sql') {
      if (typeof step.sql !== 'string' || !step.sql) throw new HttpError(400, 'invalid_program_step');
      return sqlStatement(step.sql, Array.isArray(step.params) ? (step.params as any) : []);
    }
    if (step.kind === 'platform' && step.spec && typeof step.op === 'string') {
      const spec = { ...step.spec } as Record<string, unknown>;
      if (typeof spec.granteeHex === 'string') {
        spec.grantee = hexToBytes(spec.granteeHex);
        delete spec.granteeHex;
      }
      const fn = (platformOp as Record<string, unknown>)[step.op];
      if (typeof fn === 'function') return (fn as (input: unknown) => any)(spec);
    }
    throw new HttpError(400, 'invalid_program_step');
  });
  return program(...built);
}

/** Minimal Chronolog application definition; hosted MCP submits compiled programs and reads coherent snapshots directly. */
function builtinDefinition() {
  return defineApplication({
    id: 'tendriller-hosted-mcp',
    version: '1',
    commands: {},
    queries: {},
  });
}

async function readAllEventsFromView(view: any): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 64; page++) {
    const batch = await view.readEvents({ limit: 256, ...(cursor ? { cursor } : {}) });
    all.push(...batch.events);
    if (!batch.hasMore || !batch.cursor || batch.cursor === cursor) break;
    cursor = batch.cursor;
  }
  return all;
}

function listEnvelopeRows(t: Tendril): Array<{ k: string; v: Uint8Array }> {
  return t.db.all<{ k: string; v: ArrayBuffer | Uint8Array }>(
    "SELECT k, v FROM mcp_store WHERE k LIKE 'envelope/%' ORDER BY k",
  ).map(row => ({ k: row.k, v: asBytes(row.v) }));
}

/** Browser-facing opt-in enrollment and encrypted envelope sync routes under `_tendril/mcp/*`. */
export async function handlePageMcp(t: Tendril, req: Request, sub: string, principal: PagePrincipal): Promise<Response> {
  const m = req.method;
  if (sub === 'mcp/sync' && m === 'POST') {
    if (!allows(principal, 'page.write')) throw new HttpError(403, 'forbidden');
    return handleEnvelopeSync(t, req);
  }
  if (!allows(principal, 'page.owner') || !principal.accountId) {
    throw new HttpError(403, 'forbidden', 'Only the page owner can manage hosted MCP connections.');
  }
  const accountId = principal.accountId;

  if (sub === 'mcp/grants' && m === 'GET') {
    const oauth = await mcpOAuth(t.env);
    const grants = oauth
      ? (await t.env.ACCOUNTS.prepare(`SELECT id,client_id,scope,wrap_public_key,created_at,expires_at
          FROM integration_oauth_grants WHERE account_id=? AND resource=? AND revoked_at IS NULL AND expires_at>?
          ORDER BY created_at DESC LIMIT 50`).bind(accountId, oauth.resource, Date.now()).all<{
            id: string; client_id: string; scope: string; wrap_public_key: string; created_at: number; expires_at: number;
          }>()).results.map(row => ({
            ...row,
            client_name: oauth.clients.find(c => c.id === row.client_id)?.name ?? row.client_id,
          }))
      : [];
    const connections = t.db.all<McpConnectionRow>('SELECT * FROM mcp_connections ORDER BY created_at').map(row => ({
      grant_id: row.grant_id,
      handle: row.handle,
      bio: row.bio,
      public_key: row.public_key,
      label: row.label,
      capabilities: readStoredCapabilities(row),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    return json({ configured: Boolean(oauth), grants, connections, application: selectedApplication(t) });
  }

  if (sub === 'mcp/connect' && m === 'POST') {
    await requireWritesOpen(t.env);
    const oauth = await mcpOAuth(t.env);
    if (!oauth) throw new HttpError(503, 'mcp_oauth_unavailable', 'Hosted MCP OAuth is not configured on this service.');
    const body = await readJson(req, 64 * 1024);
    const grantId = string(body.grantId, 128);
    const grant = await activeGrant(t.env, oauth, grantId, accountId);
    if (!grant) throw new HttpError(404, 'grant_not_found', 'No active OAuth grant with that ID.');
    const handle = validAgentHandle(body.handle);
    const bio = validAgentBio(body.bio ?? 'Hosted MCP assistant');
    const publicKey = string(body.publicKey, 64, /^[a-f0-9]{64}$/u);
    const wrappedKeys = unbase64url(string(body.wrappedKeysBase64, 32 * 1024));
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 100) : t.db.get('name', 'Tendril');
    const capabilities = parseCapabilities(body.capabilities);
    const applicationId = selectedApplication(t).id;

    // Ensure handle doesn't collide with another agent on this page.
    const existing = pageAgents(t).agents.find(item => item.handle.toLowerCase() === handle && item.id !== `mcp:${grantId}`);
    if (existing) throw new HttpError(409, 'agent_handle_in_use', `@${handle} is already used by another agent on this page.`);

    const now = t.now();
    const copy = new Uint8Array(wrappedKeys.byteLength);
    copy.set(wrappedKeys);
    t.transaction(() => {
      t.db.run(`INSERT INTO mcp_connections(grant_id,handle,bio,public_key,wrapped_keys,label,capabilities,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(grant_id) DO UPDATE SET handle=excluded.handle,bio=excluded.bio,public_key=excluded.public_key,
          wrapped_keys=excluded.wrapped_keys,label=excluded.label,capabilities=excluded.capabilities,updated_at=excluded.updated_at`,
        grantId, handle, bio, publicKey, copy.buffer, label, JSON.stringify(capabilities), now, now);
      if (!t.db.get<string | null>('primary_agent_id', null)) {
        t.db.set('primary_agent_id', `mcp:${grantId}`);
      }
      addActivity(t, { kind: 'mcp_connect', summary: `Connected hosted MCP agent @${handle}`, by: `owner:${accountId}` });
      t.afterCommit(() => { notifyRosterChanged(t); notifySetupChanged(t); });
    });
    await t.env.ACCOUNTS.prepare(`INSERT INTO mcp_connections(page_id,grant_id,account_id,application_id,handle,public_key,label,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(page_id,grant_id) DO UPDATE SET handle=excluded.handle,public_key=excluded.public_key,label=excluded.label`)
      .bind(t.tid, grantId, accountId, applicationId, handle, publicKey, label, now).run();
    return json({ connected: true, grant_id: grantId, agent_id: `mcp:${grantId}`, handle, bio, public_key: publicKey, label, capabilities }, 201);
  }

  if (sub === 'mcp/rekey' && m === 'POST') {
    await requireWritesOpen(t.env);
    const body = await readJson(req, 64 * 1024);
    const grantId = string(body.grantId, 128);
    const row = t.db.one<McpConnectionRow>('SELECT * FROM mcp_connections WHERE grant_id=?', grantId);
    if (!row) throw new HttpError(404, 'not_found', 'No hosted MCP connection for that grant.');
    const wrappedKeys = unbase64url(string(body.wrappedKeysBase64, 32 * 1024));
    const copy = new Uint8Array(wrappedKeys.byteLength);
    copy.set(wrappedKeys);
    t.db.run('UPDATE mcp_connections SET wrapped_keys=?, updated_at=? WHERE grant_id=?', copy.buffer, t.now(), grantId);
    return json({ rekeyed: true, grant_id: grantId });
  }

  const delMatch = /^mcp\/([A-Za-z0-9_-]{1,128})$/.exec(sub);
  if (delMatch && m === 'DELETE') {
    const grantId = delMatch[1];
    const row = t.db.one<McpConnectionRow>('SELECT * FROM mcp_connections WHERE grant_id=?', grantId);
    if (!row) throw new HttpError(404, 'not_found', 'No hosted MCP connection for that grant.');
    t.transaction(() => {
      t.db.run('DELETE FROM mcp_connections WHERE grant_id=?', grantId);
      reconcilePrimaryAgent(t);
      addActivity(t, { kind: 'mcp_disconnect', summary: `Disconnected hosted MCP agent @${row.handle}`, by: `owner:${accountId}` });
      t.afterCommit(() => { notifyRosterChanged(t); notifySetupChanged(t); });
    });
    await t.env.ACCOUNTS.prepare('DELETE FROM mcp_connections WHERE page_id=? AND grant_id=?').bind(t.tid, grantId).run();
    return json({ disconnected: true, grant_id: grantId });
  }

  throw new HttpError(404, 'not_found');
}

/**
 * Blind encrypted-envelope sync for browsers and workspace agents.
 * Validates scope against the page's signed AuthorityBundle WITHOUT needing any decryption key,
 * retaining encrypted Chronolog operation envelopes in `mcp_store` while hosted MCP is idle.
 */
export async function handleEnvelopeSync(t: Tendril, req: Request): Promise<Response> {
  const body = await readJson(req, 1024 * 1024);
  const incoming = Array.isArray(body.envelopes) ? body.envelopes : [];
  const known = new Set<string>(Array.isArray(body.knownIds) ? body.knownIds.filter((x: unknown): x is string => typeof x === 'string') : []);
  if (incoming.length > 256) throw new HttpError(400, 'too_many_envelopes', 'Sync at most 256 envelopes per call.');

  const bundle = await readAuthorityBundle(t);
  if (!bundle) throw new HttpError(409, 'application_uninitialized', 'Application authority is not initialized yet.');
  const appId = selectedApplication(t).id;

  let stored = 0;
  for (const item of incoming) {
    if (typeof item !== 'string' || item.length > 128 * 1024) throw new HttpError(400, 'invalid_envelope');
    const raw = unbase64url(item);
    const decoded = decodeRecord<any>(raw);
    const payload = decoded?.payload;
    if (!payload || payload.applicationId !== appId || typeof payload.proposalId !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.proposalId)) {
      throw new HttpError(400, 'invalid_envelope_scope');
    }
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const exists = t.db.one('SELECT 1 AS x FROM mcp_store WHERE k=?', ENVELOPE_PREFIX + payload.proposalId);
    if (!exists) {
      t.db.run('INSERT OR IGNORE INTO mcp_store(k, v) VALUES(?, ?)', ENVELOPE_PREFIX + payload.proposalId, copy.buffer);
      stored++;
    }
    known.add(payload.proposalId);
  }
  if (stored > 0) notifyMcpSyncWatchers(t);

  const missing: Array<{ proposalId: string; envelopeBase64: string }> = [];
  for (const row of listEnvelopeRows(t)) {
    const id = row.k.slice(ENVELOPE_PREFIX.length);
    if (!known.has(id)) {
      missing.push({ proposalId: id, envelopeBase64: base64url(row.v) });
      if (missing.length >= 256) break;
    }
  }
  return json({ stored, envelopes: missing });
}

/**
 * Open an ephemeral in-memory Chronolog session for one authenticated `/mcp` request using
 * keys unwrapped strictly in RAM from the OAuth Bearer token. Closes & discards all plaintext
 * material in `finally`.
 */
async function withHostedSession<T>(
  t: Tendril,
  row: McpConnectionRow,
  wrapPublicKey: string,
  wrapPrivateKey: Uint8Array,
  work: (ctx: {
    session: any;
    domainBundle: string | null;
    isSql: boolean;
    roster: ReturnType<typeof pageAgents>;
  }) => Promise<T>,
): Promise<T> {
  const applicationId = selectedApplication(t).id;
  const bundle = await readAuthorityBundle(t);
  if (!bundle) throw new HttpError(409, 'application_uninitialized', 'Open the page in your browser first to initialize Chronolog authority.');

  const aad = `${t.tid}:${applicationId}:${row.grant_id}`;
  const material = await unsealHostedKeys(wrapPrivateKey, wrapPublicKey, asBytes(row.wrapped_keys), aad);
  if (material.signingPublicKey !== row.public_key) {
    throw new HttpError(403, 'mcp_signer_mismatch', 'Unwrapped signing key does not match this hosted MCP connection.');
  }
  const signer = await importSigningIdentity({ publicKey: material.signingPublicKey, privateKey: normalizeEd25519Pkcs8Hex(material.signingSeedHex) });
  const epochKeys = new Map<number, Uint8Array>();
  for (const [epochStr, keyHex] of Object.entries(material.epochKeys)) {
    const epoch = Number(epochStr);
    if (Number.isSafeInteger(epoch) && epoch >= 0) epochKeys.set(epoch, parseHex(keyHex));
  }

  // Both authority and session device run strictly in RAM (`MemoryBytesStore`) so ZERO keys,
  // ZERO plaintext `journal.requests`, and ZERO unencrypted SQLite state ever touch DO SQLite.
  // Only encrypted Chronolog envelopes (`envelope/<proposalId>`) are persisted in `mcp_store`.
  const authorityStore = new MemoryBytesStore();
  const authority = await createAuthorityProvider({
    store: authorityStore as any,
    bundle,
    applicationId,
    epochKeys,
  });

  // Pre-collect retained encrypted envelopes from `mcp_store` so any `operation-set/<appId>`
  // read (regardless of Chronolog's internal storageId key prefix) hydrates directly from them.
  const hydratedEnvelopes: any[] = [];
  const hydratedSeen = new Set<string>();
  for (const envRow of listEnvelopeRows(t)) {
    try {
      const envelope = decodeRecord<any>(envRow.v);
      const id = envelope?.payload?.proposalId;
      if (typeof id === 'string' && !hydratedSeen.has(id) && envelope?.payload?.applicationId === applicationId) {
        hydratedEnvelopes.push(envelope);
        hydratedSeen.add(id);
      }
    } catch { /* ignore malformed */ }
  }
  const journalSuffix = `operation-set/${applicationId}`;
  // This hosted identity's own request records (operationId → proposal) let an exact retry reuse its original
  // signed intent. They are sealed under the identity's wrapped seed and kept only while their envelope is retained.
  const requestsKey = `${REQUESTS_PREFIX}${row.grant_id}`, requestsContext = `${t.tid}:${applicationId}:${row.grant_id}:${row.public_key}`;
  let hydratedRequests: unknown[] = [];
  const sealedRequests = t.db.one<{ v: ArrayBuffer | Uint8Array }>('SELECT v FROM mcp_store WHERE k=?', requestsKey);
  if (sealedRequests) {
    const opened = await unsealHostedRequests(material.signingSeedHex, requestsContext, asBytes(sealedRequests.v));
    if (opened) {
      try {
        const records = decodeRecord<unknown[]>(opened);
        if (Array.isArray(records)) hydratedRequests = records.filter(item => hydratedSeen.has((item as { proposalId?: string })?.proposalId ?? ''));
      } catch { /* A malformed record is ignored; retries then mint fresh intents. */ }
    }
  }
  const hydratedJournalBytes = hydratedEnvelopes.length > 0
    ? encodeRecord({ format: 'authored-operation-set-v1', applicationId, envelopes: hydratedEnvelopes, requests: hydratedRequests, retentions: [], finality: [] })
    : null;

  const store = new MemoryBytesStore(key => (hydratedJournalBytes && (key === journalSuffix || key.endsWith('/' + journalSuffix)) ? hydratedJournalBytes : null));
  const device = await openApplicationDevice({
    store: store as any,
    managedSigner: signer,
    create: true,
  });

  const config = t.db.get<{ executionProfile?: string; executionManifestDigest?: string } | null>('application_configuration', null);
  const sqlDigest = await doltliteExecutionManifestDigest().catch(() => null);
  const isSql = Boolean(
    config?.executionProfile?.startsWith('sql') ||
    (sqlDigest && bundle.descriptor.payload.executionManifestDigest === sqlDigest),
  );

  // Load optional epoch-key-encrypted SQL checkpoint in RAM so large SQL apps skip replaying
  // the already-materialized prefix while keeping zero plaintext SQLite on disk.
  const checkpointKey = SQL_CHECKPOINT_PREFIX + applicationId;
  const checkpointThreshold = Math.max(1, Number(t.db.get<number>('mcp_sql_checkpoint_threshold', DEFAULT_SQL_CHECKPOINT_THRESHOLD)));
  let initialSqlBytes: Uint8Array | null = null;
  let loadedCheckpointCount = 0;
  if (isSql) {
    const ckptRow = t.db.one<{ v: ArrayBuffer | Uint8Array }>('SELECT v FROM mcp_store WHERE k=?', checkpointKey);
    if (ckptRow) {
      const opened = await unsealSqlCheckpoint(epochKeys, applicationId, asBytes(ckptRow.v));
      if (opened) {
        initialSqlBytes = opened.sqliteBytes;
        loadedCheckpointCount = opened.envelopeCount;
      }
    }
  }

  let latestEnvelopeCount = hydratedEnvelopes.length;
  const currentEpoch = bundle.memberships.at(-1)?.payload.epoch ?? 0;
  const currentEpochKey = epochKeys.get(currentEpoch) ?? null;

  const session = await createApplicationSession({
    device,
    definition: builtinDefinition(),
    authority,
    ...(isSql ? {
      createMaterializer: async ({ rootPrincipal }: { rootPrincipal: string }) => createEphemeralSqlMaterializer(rootPrincipal, {
        initialBytes: initialSqlBytes,
        onCloseBytes: async bytes => {
          if (!currentEpochKey || bytes.byteLength > MAX_SQL_CHECKPOINT_BYTES) return;
          if (latestEnvelopeCount < checkpointThreshold || latestEnvelopeCount <= loadedCheckpointCount) return;
          const sealed = await sealSqlCheckpoint(currentEpochKey, applicationId, currentEpoch, latestEnvelopeCount, bytes);
          const copy = new Uint8Array(sealed.byteLength);
          copy.set(sealed);
          t.db.run('INSERT INTO mcp_store(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', checkpointKey, copy.buffer);
        },
      }),
    } : {}),
  } as any);

  try {
    const domainBundle = await loadPublishedDomainBundle(t);
    return await work({ session, domainBundle, isSql, roster: pageAgents(t) });
  } finally {
    // Export newly authored encrypted envelopes into shared `envelope/` retention (zero plaintext requests).
    let addedEnvelopes = 0;
    try {
      for (const [k, rawJournal] of store.entries()) {
        if (k !== journalSuffix && !k.endsWith('/' + journalSuffix)) continue;
        const journal = decodeRecord<any>(rawJournal);
        const envelopes = Array.isArray(journal?.envelopes) ? journal.envelopes : [];
        const requests = Array.isArray(journal?.requests) ? journal.requests : [];
        if (requests.length > hydratedRequests.length) {
          const sealed = await sealHostedRequests(material.signingSeedHex, requestsContext, encodeRecord(requests));
          const copy = new Uint8Array(sealed.byteLength); copy.set(sealed);
          t.db.run('INSERT INTO mcp_store(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', requestsKey, copy.buffer);
        }
        if (envelopes.length > latestEnvelopeCount) latestEnvelopeCount = envelopes.length;
        for (const envelope of envelopes) {
          const id = envelope?.payload?.proposalId;
          if (typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)) {
            if (!hydratedSeen.has(id)) {
              const bytes = encodeRecord(envelope);
              const copy = new Uint8Array(bytes.byteLength);
              copy.set(bytes);
              t.db.run('INSERT OR IGNORE INTO mcp_store(k, v) VALUES(?, ?)', ENVELOPE_PREFIX + id, copy.buffer);
              hydratedSeen.add(id);
              addedEnvelopes++;
            }
          }
        }
      }
    } catch { /* Journal export best-effort */ }
    if (addedEnvelopes > 0) notifyMcpSyncWatchers(t);
    try { await session.close(); } catch { /* ignore */ }
    epochKeys.clear();
  }
}

/** DO-side handler for authenticated `/mcp` and `/v1/apps/:appId/*` calls. */
export async function mcpRequest(t: Tendril, req: Request): Promise<Response> {
  const payload = await readJson<{
    principal: Omit<McpPrincipal, 'wrapPrivateKey'> & { wrapPrivateKeyBase64: string | null };
    applicationId: string;
    method: string;
    params: Record<string, unknown>;
  }>(req, REQUEST_LIMIT + 4096);

  const principal: McpPrincipal = {
    ...payload.principal,
    wrapPrivateKey: payload.principal.wrapPrivateKeyBase64 ? unbase64url(payload.principal.wrapPrivateKeyBase64) : null,
  };
  const { applicationId, method, params } = payload;

  if (t.db.get('disabled', false) || t.db.get<string | null>('owner_account', null) !== principal.account ||
      selectedApplication(t).id !== applicationId || principal.expires <= Date.now()) {
    throw new HttpError(404, 'application_not_connected');
  }
  const conn = t.db.one<McpConnectionRow>('SELECT * FROM mcp_connections WHERE grant_id=?', principal.grant);
  if (!conn) throw new HttpError(404, 'application_not_connected', 'This page is not connected to this OAuth grant.');
  const caps = readStoredCapabilities(conn);

  const oauth = await mcpOAuth(t.env);
  const checkGrant = async (scope: string) => {
    requireScope(principal, scope);
    const grant = oauth && await activeGrant(t.env, oauth, principal.grant, principal.account);
    if (!grant?.scope.split(' ').includes(scope) || grant.client_id !== principal.client) {
      throw new HttpError(403, 'authorization_revoked');
    }
  };

  if (method === 'agents_list') {
    await checkGrant('applications:read');
    const roster = pageAgents(t);
    return json({ value: { applicationId, pageId: t.tid, self: `mcp:${conn.grant_id}`, selfHandle: conn.handle, ...roster } });
  }

  if (method === 'describe_application') {
    await checkGrant('applications:read');
    const domainBundle = await loadPublishedDomainBundle(t);
    const domain = domainBundle ? await describeDomainBundle(domainBundle) : null;
    const configTools = t.db.get<{ tools?: { queries?: any[]; commands?: any[] } } | null>('application_configuration', null)?.tools;
    const rawQueries = domain?.queries ?? configTools?.queries ?? [];
    const rawCommands = domain?.commands ?? configTools?.commands ?? [];
    const queries = caps.read ? rawQueries.filter(q => !caps.queries || caps.queries.includes(q.name)) : [];
    const commands = caps.write ? rawCommands.filter(c => !caps.commands || caps.commands.includes(c.name)) : [];
    const roster = pageAgents(t);
    return json({
      value: {
        applicationId,
        pageId: t.tid,
        label: conn.label,
        hostedParticipant: {
          agentId: `mcp:${conn.grant_id}`,
          handle: conn.handle,
          bio: conn.bio,
          publicKey: conn.public_key,
          isPrimary: roster.primary_agent_id === `mcp:${conn.grant_id}`,
          keyCustody: 'oauth-token-wrapped',
        },
        roster,
        hasDomainBundle: Boolean(domainBundle),
        queries,
        commands,
        builtinTools: ['agents_list', 'agent_message', 'agent_feed', 'read_application_events', 'inspect_application_operation'],
      },
    });
  }

  if (!principal.wrapPrivateKey) {
    throw new HttpError(401, 'wrap_key_required', 'Re-authorize this OAuth client so its Bearer token carries the key-unwrapping secret.');
  }

  return t.serializeMcp(async () => {
    if (method === 'read_application_events') {
      await checkGrant('applications:read');
      if (!caps.read) throw new HttpError(403, 'read_not_permitted');
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session }) => {
        const topics = Array.isArray(params.topics) ? params.topics.map(v => string(v, 128)) : undefined;
        const limit = params.limit === undefined ? 50 : Math.min(256, Math.max(1, Number(params.limit)));
        const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
        const view = await session.readView();
        try {
          const result = await view.readEvents({ ...(topics?.length ? { topics } : {}), limit, ...(cursor ? { cursor } : {}) });
          return json({ value: { revision: view.revision, value: result } });
        } finally {
          await view.release();
        }
      });
    }

    if (method === 'inspect_application_operation') {
      await checkGrant('applications:read');
      const operationId = string(params.operationId, 512);
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session }) => {
        const op = await session.operations.get(operationId);
        return json({ value: { operationId, operation: op ? await op.inspect() : null } });
      });
    }

    if (method === 'query_application' || method === 'agent_feed') {
      await checkGrant('applications:read');
      if (!caps.read) throw new HttpError(403, 'read_not_permitted');
      const queryName = method === 'agent_feed' ? 'agentFeed' : string(params.query, 128);
      if (method === 'query_application' && caps.queries && !caps.queries.includes(queryName)) {
        throw new HttpError(403, 'operation_not_approved');
      }
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session, domainBundle, isSql }) => {
        const view = await session.readView();
        try {
          const allEvents = await readAllEventsFromView(view);
          if (method === 'agent_feed') {
            const events = allEvents.filter(ev => ['agent/message', 'agent/receipt'].includes(ev.topic));
            return json({ value: { revision: view.revision, value: deriveAgentFeed(events) } });
          }
          const runSql = (sql: string, sqlParams: unknown[] = []) => {
            const res = view.query(sql, sqlParams);
            return {
              columns: res.columns,
              rows: res.rows.map((row: unknown[]) => row.map(v =>
                typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v,
              )),
            };
          };
          if (!domainBundle) {
            if (queryName === 'sql' && isSql && isPlainObject(params.input) && typeof params.input.sql === 'string') {
              const res = runSql(params.input.sql, Array.isArray(params.input.params) ? params.input.params : []);
              return json({ value: { revision: view.revision, value: res } });
            }
            throw new HttpError(409, 'domain_bundle_missing', 'Publish a signed domain.js bundle with your page to run named queries in hosted MCP.');
          }
          const bridge: SandboxReadBridge = {
            readEvents(opts) {
              const topics = Array.isArray(opts?.topics) ? opts.topics : null;
              const limit = Math.min(256, Math.max(1, Number(opts?.limit ?? 128)));
              const offset = opts?.cursor ? Number(opts.cursor) : 0;
              const filtered = topics ? allEvents.filter(ev => topics.includes(ev.topic)) : allEvents;
              const slice = filtered.slice(offset, offset + limit);
              const nextOffset = offset + slice.length;
              return { events: slice, cursor: String(nextOffset), hasMore: nextOffset < filtered.length };
            },
            ...(isSql ? { query: (sql, sqlParams) => runSql(sql, sqlParams) } : {}),
          };
          await declaredInput(domainBundle, 'queries', queryName, params.input ?? null);
          const value = await runDomainQuery(domainBundle, queryName, params.input ?? null, bridge);
          return json({ value: { revision: view.revision, value } });
        } finally {
          await view.release();
        }
      });
    }

    if (method === 'call_application_command' || method === 'agent_message') {
      await checkGrant('applications:write');
      await requireWritesOpen(t.env);
      if (!caps.write) throw new HttpError(403, 'write_not_permitted');
      const operationId = string(params.operationId, 512);
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session, domainBundle, roster }) => {
        let steps: SandboxProgramStep[];
        if (method === 'agent_message') {
          const channel = params.channel === 'agents' ? 'agents' : 'chat';
          const textVal = string(params.text, 8000);
          const toInput = Array.isArray(params.to) ? params.to : [];
          const toHex = (raw: string): string => {
            if (/^[a-f0-9]{64}$/iu.test(raw)) return raw.toLowerCase();
            const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
            const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
            const bin = atob(padded);
            if (bin.length !== 32) throw new HttpError(400, 'invalid_agent_key', 'Agent public key is not a valid 32-byte Ed25519 key.');
            let out = '';
            for (let i = 0; i < 32; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
            return out;
          };
          const resolvedTo = toInput.map((target: unknown) => {
            if (target === '*') return '*';
            const raw = string(target, 128);
            if (/^[a-f0-9]{64}$/iu.test(raw)) return raw.toLowerCase();
            if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/u.test(raw)) return toHex(raw);
            const handle = raw.replace(/^@+/, '').toLowerCase();
            const hit = roster.agents.find(a => a.handle === handle);
            if (!hit) throw new HttpError(404, 'unknown_agent_handle', `No agent @${handle} on this page.`);
            return toHex(hit.public_key);
          });
          steps = [{
            kind: 'emit',
            topic: 'agent/message',
            payload: {
              channel,
              to: resolvedTo,
              text: textVal,
              ...(params.data !== undefined ? { data: params.data } : {}),
              ...(Array.isArray(params.attachments) ? { attachments: params.attachments } : {}),
              ...(isPlainObject(params.inReplyTo) ? { inReplyTo: params.inReplyTo } : {}),
              hopCount: typeof params.hopCount === 'number' ? params.hopCount : 0,
              expectReply: params.expectReply !== false,
              ...(params.replyToUser === true ? { replyToUser: true } : {}),
            },
          }];
        } else {
          const commandName = string(params.command, 128);
          if (caps.commands && !caps.commands.includes(commandName)) {
            throw new HttpError(403, 'operation_not_approved');
          }
          if (!domainBundle) {
            throw new HttpError(409, 'domain_bundle_missing', 'Publish a signed domain.js bundle with your page to run named commands in hosted MCP.');
          }
          await declaredInput(domainBundle, 'commands', commandName, params.input);
          steps = await runDomainCommand(domainBundle, commandName, params.input);
        }
        const op = await session.submit({ program: buildChronologProgram(steps), operationId });
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('MATERIALIZE_TIMEOUT')), 10_000);
        let materialized;
        try {
          materialized = await op.materialized({ signal: ac.signal });
        } finally {
          clearTimeout(timer);
        }
        const inspected = await op.inspect();
        return json({
          value: {
            operationId,
            proposalId: op.id,
            author: conn.public_key,
            handle: conn.handle,
            stored: inspected.stored,
            materialized,
            excluded: inspected.excluded ?? false,
          },
        });
      });
    }

    throw new HttpError(404, 'method_not_found');
  });
}

function deriveAgentFeed(events: any[]) {
  const messages: any[] = [];
  const activity: any[] = [];
  const receipts: Record<string, any[]> = {};
  for (const ev of events) {
    const atMs = typeof ev.authorTimestampMs === 'string' && /^\d+$/.test(ev.authorTimestampMs) ? Number(ev.authorTimestampMs) : null;
    if (ev.topic === 'agent/message') {
      const entry = {
        author: ev.author,
        operationId: ev.operationId,
        proposalId: ev.proposalId,
        atMs,
        ...ev.payload,
      };
      if (ev.payload?.channel === 'agents') activity.push(entry);
      else messages.push(entry);
    } else if (ev.topic === 'agent/receipt') {
      const key = `${ev.payload?.messageAuthor}:${ev.payload?.messageOperationId}`;
      (receipts[key] ??= []).push({
        author: ev.author,
        operationId: ev.operationId,
        atMs,
        runId: ev.payload?.runId,
        state: ev.payload?.state ?? 'seen',
      });
    }
  }
  return { messages, activity, receipts };
}
