/**
 * Opt-in hosted Chronolog v2 MCP participant inside the Tendril Durable Object.
 *
 * - Zero plaintext keys and zero plaintext application data at rest:
 *   * `mcp_connections.wrapped_keys` holds X25519-sealed `{ signingSeedHex, signingPublicKey, epochKeys }`.
 *   * `mcp_store` holds encrypted Chronolog v2 operation envelopes (`envelope/<digest>`) and
 *     seed-sealed private CAS chunks (`priv-cas/<hash>`) only.
 * - On an authenticated `/mcp` call, the OAuth Bearer token delivers `wrapPrivateKey` in RAM ->
 *   unseals keys in RAM -> opens an ephemeral in-memory Chronolog v2 `ApplicationSession`
 *   with static `quickjs-ng` + `sqlite-cas.wasm` -> executes reducers directly from `$reducers`
 *   (no separate `domain.js` bundle!) -> exports only encrypted envelopes & sealed CAS chunks
 *   back to `mcp_store` -> discards all plaintext material in `finally`.
 */
import quickJsWasm from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import sqliteCasWasm from '@chronolog/peer-session/sqlite-cas.wasm';
import {
  bytesToHex, createApplicationSession, decodeEncryptedEnvelope, decodeRecord,
  encryptedEnvelopeDigest, importSigningIdentity, openApplicationDevice,
  type FinalityCheckpoint, type SessionCasNode,
} from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { activeGrant } from './accounts/oauth-data';
import { allows, type PagePrincipal } from './access';
import { addActivity } from './activity';
import { notifyRosterChanged, pageAgents, reconcilePrimaryAgent, validAgentBio, validAgentHandle } from './agent-grants';
import { selectedApplication } from './application';
import {
  listCheckpointRows, listPublicCasRows, listPublicOpRows, readStoredGenesisBytes,
  reconcileHostEffects, readControlState,
} from './authority';
import { HttpError, isPlainObject, json, readJson } from './http';
import { base64url } from './accounts/oauth-support';
import {
  hexToBytes as parseHex, normalizeEd25519Pkcs8Hex, sealHostedRequests, unbase64url,
  unsealHostedKeys, unsealHostedRequests,
} from './mcp-crypto';
import { mcpOAuth, REQUEST_LIMIT, requireScope, string, type McpPrincipal } from './mcp-shared';
import { notifyMcpSyncWatchers } from './publication-watch';
import { requireWritesOpen } from './service-state';
import { notifySetupChanged } from './setup-watch';
import type { Tendril } from './tendril';
import { canConsumeMcpCall, getAccountEntitlements, quotaError, recordAccountUsage } from './billing/entitlements';

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
const PRIV_CAS_PREFIX = 'priv-cas/';
const HOSTED_REQUESTS_PREFIX = 'hosted-requests/';

function validateSchemaInput(schema: any, value: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf) {
      if (validateSchemaInput(option, value) === null) return null;
    }
    return 'Value does not match any allowed schema option';
  }
  if (schema.type === 'null') return value === null || value === undefined ? null : 'Expected null';
  if (schema.type === 'string') return typeof value === 'string' ? null : 'Expected string';
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : 'Expected boolean';
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : 'Expected number';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) ? null : 'Expected integer';
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return 'Expected array';
    if (schema.items) {
      for (const item of value) {
        const err = validateSchemaInput(schema.items, item);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Expected object';
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(obj, reqKey) || obj[reqKey] === undefined) return `Missing required field "${reqKey}"`;
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(obj, k) && obj[k] !== undefined) {
          const err = validateSchemaInput(propSchema, obj[k]);
          if (err) return `Field "${k}": ${err}`;
        }
      }
    }
    return null;
  }
  return null;
}

async function computeRequestFingerprint(kind: string, name: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, name, input ?? null]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return bytesToHex(hash);
}

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

function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function listEnvelopeRows(t: Tendril): Array<{ k: string; v: Uint8Array }> {
  return t.db.all<{ k: string; v: ArrayBuffer | Uint8Array }>(
    'SELECT k, v FROM mcp_store WHERE k >= ? AND k < ? ORDER BY k',
    ENVELOPE_PREFIX,
    prefixUpperBound(ENVELOPE_PREFIX),
  ).map(row => ({ k: row.k, v: asBytes(row.v) }));
}

function listSealedPrivCasRows(t: Tendril, grantId: string): Array<{ hash: string; sealed: Uint8Array }> {
  const prefix = `${PRIV_CAS_PREFIX}${grantId}/`;
  return t.db.all<{ k: string; v: ArrayBuffer | Uint8Array }>(
    'SELECT k, v FROM mcp_store WHERE k >= ? AND k < ? ORDER BY k',
    prefix,
    prefixUpperBound(prefix),
  ).map(row => ({ hash: row.k.slice(prefix.length), sealed: asBytes(row.v) }));
}

function mcpStoreBytes(t: Tendril): number {
  return t.db.one<{ n: number }>('SELECT COALESCE(SUM(LENGTH(v)), 0) AS n FROM mcp_store')?.n ?? 0;
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

    const existing = pageAgents(t).agents.find(item => item.handle.toLowerCase() === handle && item.id !== `mcp:${grantId}`);
    if (existing) throw new HttpError(409, 'agent_handle_in_use', `@${handle} is already used by another agent on this page.`);

    const alreadyConnectedPage = Boolean(t.db.one('SELECT 1 AS x FROM mcp_connections LIMIT 1'));
    if (!alreadyConnectedPage) {
      const ent = await getAccountEntitlements(t.env, accountId, t.now());
      if (ent.quotas.mcpPages !== null) {
        const countRow = await t.env.ACCOUNTS.prepare(`SELECT COUNT(DISTINCT page_id) AS n FROM mcp_connections
          WHERE account_id = ? AND page_id != ?`).bind(accountId, t.tid).first<{ n: number }>();
        const usedPages = countRow?.n ?? 0;
        if (usedPages >= ent.quotas.mcpPages) {
          throw quotaError({
            env: t.env,
            quota: 'mcp_pages',
            plan: ent.plan,
            used: usedPages,
            limit: ent.quotas.mcpPages,
            resetsAt: null,
            message: `Your ${ent.plan} plan supports hosted MCP on up to ${ent.quotas.mcpPages} ${ent.quotas.mcpPages === 1 ? 'page' : 'pages'}. Disconnect another page, upgrade, or run tendril agent run locally.`,
            localAlternative: 'Run `npm run agent` locally to connect unlimited pages without hosted MCP page limits.',
          });
        }
      }
    }

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
      const privPrefix = `${PRIV_CAS_PREFIX}${grantId}/`;
      t.db.run('DELETE FROM mcp_store WHERE k >= ? AND k < ?', privPrefix, prefixUpperBound(privPrefix));
      t.db.run('DELETE FROM mcp_store WHERE k = ?', `${HOSTED_REQUESTS_PREFIX}${grantId}`);
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
 * Validates `chainId` against the stored v2 genesis WITHOUT needing any decryption key,
 * retaining encrypted `EncryptedOperationEnvelope` records keyed by `encryptedEnvelopeDigest`
 * so rewrapped envelopes reconcile cleanly too.
 */
export async function handleEnvelopeSync(t: Tendril, req: Request): Promise<Response> {
  const body = await readJson(req, 2 * 1024 * 1024);
  const incoming = Array.isArray(body.envelopes) ? body.envelopes : [];
  const known = new Set<string>(Array.isArray(body.knownIds) ? body.knownIds.filter((x: unknown): x is string => typeof x === 'string') : []);
  if (incoming.length > 256) throw new HttpError(400, 'too_many_envelopes', 'Sync at most 256 envelopes per call.');

  const genesisBytes = readStoredGenesisBytes(t);
  if (!genesisBytes) throw new HttpError(409, 'application_uninitialized', 'Application genesis is not initialized yet.');
  const chainId = selectedApplication(t).id;

  const ownerAccount = t.db.get<string | null>('owner_account', null);
  const ent = ownerAccount ? await getAccountEntitlements(t.env, ownerAccount, t.now()) : null;
  const storeCap = ent?.quotas.mcpStoreBytes ?? null;
  let currentStoreBytes = storeCap !== null ? mcpStoreBytes(t) : 0;

  let stored = 0;
  for (const item of incoming) {
    if (typeof item !== 'string' || item.length > 256 * 1024) throw new HttpError(400, 'invalid_envelope');
    const raw = unbase64url(item);
    let envelope;
    try { envelope = decodeEncryptedEnvelope(raw); }
    catch { throw new HttpError(400, 'invalid_envelope'); }
    if (bytesToHex(envelope.chainId) !== chainId) throw new HttpError(400, 'invalid_envelope_scope');
    const digest = bytesToHex(encryptedEnvelopeDigest(raw));
    const key = ENVELOPE_PREFIX + digest;
    const exists = t.db.one('SELECT 1 AS x FROM mcp_store WHERE k=?', key);
    if (!exists) {
      if (storeCap !== null && currentStoreBytes + raw.byteLength > storeCap) {
        throw quotaError({
          env: t.env,
          status: 413,
          quota: 'mcp_store',
          plan: ent?.plan ?? 'free',
          used: currentStoreBytes,
          limit: storeCap,
          resetsAt: null,
          message: `Hosted MCP encrypted sync storage limit reached for this page (${Math.round(storeCap / (1024 * 1024))} MB on ${ent?.plan ?? 'free'}).`,
          localAlternative: 'Your local browser and native Chronolog storage are unaffected; run `npm run agent` locally or upgrade for larger hosted MCP retention.',
        });
      }
      const copy = new Uint8Array(raw.byteLength);
      copy.set(raw);
      t.db.run('INSERT OR IGNORE INTO mcp_store(k, v) VALUES(?, ?)', key, copy.buffer);
      currentStoreBytes += copy.byteLength;
      stored++;
    }
    known.add(digest);
  }
  if (stored > 0) notifyMcpSyncWatchers(t);

  const missing: Array<{ digest: string; envelopeBase64: string }> = [];
  for (const row of listEnvelopeRows(t)) {
    const digest = row.k.slice(ENVELOPE_PREFIX.length);
    if (!known.has(digest)) {
      missing.push({ digest, envelopeBase64: base64url(row.v) });
      if (missing.length >= 256) break;
    }
  }
  return json({ stored, envelopes: missing });
}

/**
 * Open an ephemeral in-memory Chronolog v2 `ApplicationSession` for one authenticated `/mcp`
 * call using keys unwrapped strictly in RAM from the OAuth Bearer token.
 * Runs static `quickjs-ng` + `sqlite-cas.wasm` with ZERO plaintext at rest.
 */
async function withHostedSession<T>(
  t: Tendril,
  row: McpConnectionRow,
  wrapPublicKey: string,
  wrapPrivateKey: Uint8Array,
  work: (ctx: {
    session: Awaited<ReturnType<typeof createApplicationSession>>;
    roster: ReturnType<typeof pageAgents>;
    requests: Record<string, { fingerprint: string; proposalId: string }>;
    markRequestsDirty: () => void;
  }) => Promise<T>,
): Promise<T> {
  const applicationId = selectedApplication(t).id;
  const genesisBytes = readStoredGenesisBytes(t);
  if (!genesisBytes) {
    throw new HttpError(409, 'application_uninitialized', 'Initialize Chronolog v2 genesis first.');
  }

  const aad = `${t.tid}:${applicationId}:${row.grant_id}`;
  const material = await unsealHostedKeys(wrapPrivateKey, wrapPublicKey, asBytes(row.wrapped_keys), aad);
  if (material.signingPublicKey !== row.public_key) {
    throw new HttpError(403, 'mcp_signer_mismatch', 'Unwrapped signing key does not match this hosted MCP connection.');
  }
  const signer = await importSigningIdentity({
    publicKey: material.signingPublicKey,
    privateKey: normalizeEd25519Pkcs8Hex(material.signingSeedHex),
  });
  const epochKeys = new Map<number, Uint8Array>();
  for (const [epochStr, keyHex] of Object.entries(material.epochKeys)) {
    const epoch = Number(epochStr);
    if (Number.isSafeInteger(epoch) && epoch >= 0) epochKeys.set(epoch, parseHex(keyHex));
  }

  const memStore = new MemoryBytesStore();
  const device = await openApplicationDevice({
    store: memStore,
    managedSigner: signer,
    create: true,
  });

  const publicCas: SessionCasNode[] = listPublicCasRows(t).map(r => ({ hash: r.hash, bytes: r.bytes, partition: 'public' }));
  const casContext = `${t.tid}:${applicationId}:${row.grant_id}:${row.public_key}:cas`;
  const privCas: SessionCasNode[] = [];
  const hydratedPrivHashes = new Set<string>();
  for (const item of listSealedPrivCasRows(t, row.grant_id)) {
    const opened = await unsealHostedRequests(material.signingSeedHex, `${casContext}:${item.hash}`, item.sealed);
    if (opened) {
      privCas.push({ hash: item.hash, bytes: opened, partition: 'private' });
      hydratedPrivHashes.add(item.hash);
    }
  }

  const publicOps = listPublicOpRows(t).map(r => r.raw);
  const existingPublicOpIds = new Set(listPublicOpRows(t).map(r => r.op_id));
  const envelopeRows = listEnvelopeRows(t);
  const hydratedEnvelopeDigests = new Set(envelopeRows.map(r => r.k.slice(ENVELOPE_PREFIX.length)));
  const checkpoints = listCheckpointRows(t).map(r => decodeRecord<FinalityCheckpoint>(r.raw));

  const session = await createApplicationSession({
    device,
    genesis: genesisBytes,
    casNodes: [...publicCas, ...privCas],
    epochKeys,
    wasmModule: quickJsWasm,
    sqliteWasmModule: sqliteCasWasm,
  });

  const requestsKey = `${HOSTED_REQUESTS_PREFIX}${row.grant_id}`;
  const requestsContext = `${t.tid}:${applicationId}:${row.grant_id}:${row.public_key}:requests`;
  let requests: Record<string, { fingerprint: string; proposalId: string }> = {};
  let requestsDirty = false;
  const savedReqRow = t.db.one<{ v: ArrayBuffer | Uint8Array }>('SELECT v FROM mcp_store WHERE k=?', requestsKey);
  if (savedReqRow) {
    const opened = await unsealHostedRequests(material.signingSeedHex, requestsContext, asBytes(savedReqRow.v));
    if (opened) {
      try { requests = JSON.parse(new TextDecoder().decode(opened)); } catch { requests = {}; }
    }
  }

  try {
    if (publicOps.length > 0 || envelopeRows.length > 0 || checkpoints.length > 0) {
      await session.mergeFacts({
        publicOps,
        encryptedEnvelopes: envelopeRows.map(r => r.v),
        casNodes: [...publicCas, ...privCas],
        retentions: [],
        checkpoints,
      });
    }
    return await work({ session, roster: pageAgents(t), requests, markRequestsDirty: () => { requestsDirty = true; } });
  } finally {
    let addedEnvelopes = 0;
    try {
      if (requestsDirty) {
        const sealedReq = await sealHostedRequests(material.signingSeedHex, requestsContext, new TextEncoder().encode(JSON.stringify(requests)));
        const copy = new Uint8Array(sealedReq.byteLength);
        copy.set(sealedReq);
        t.db.run('INSERT OR REPLACE INTO mcp_store(k, v) VALUES(?, ?)', requestsKey, copy.buffer);
      }
      const exported = await session.exportFacts();
      for (const rawEnv of exported.encryptedEnvelopes) {
        const digest = bytesToHex(encryptedEnvelopeDigest(rawEnv));
        if (!hydratedEnvelopeDigests.has(digest)) {
          const copy = new Uint8Array(rawEnv.byteLength);
          copy.set(rawEnv);
          t.db.run('INSERT OR IGNORE INTO mcp_store(k, v) VALUES(?, ?)', ENVELOPE_PREFIX + digest, copy.buffer);
          hydratedEnvelopeDigests.add(digest);
          addedEnvelopes++;
        }
      }
      for (const node of exported.casNodes) {
        if (node.partition === 'private' && !hydratedPrivHashes.has(node.hash)) {
          const sealed = await sealHostedRequests(material.signingSeedHex, `${casContext}:${node.hash}`, node.bytes);
          const copy = new Uint8Array(sealed.byteLength);
          copy.set(sealed);
          t.db.run('INSERT OR IGNORE INTO mcp_store(k, v) VALUES(?, ?)', `${PRIV_CAS_PREFIX}${row.grant_id}/${node.hash}`, copy.buffer);
          hydratedPrivHashes.add(node.hash);
        }
      }
      // Persist any new public control ops (if hosted MCP authored one, e.g. with admin rights).
      if (exported.publicOps.length > existingPublicOpIds.size) {
        const state = await readControlState(t);
        if (state) reconcileHostEffects(t, state);
      }
    } catch { /* Best-effort encrypted export */ }
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

  const ent = await getAccountEntitlements(t.env, principal.account, t.now());
  const mcpCheck = canConsumeMcpCall(ent);
  if (!mcpCheck.allowed) {
    const cap = ent.quotas.mcpCallsPerMonth ?? 0;
    const isPaygCapped = ent.paygEnabled && !ent.overage.withinSpendCap;
    throw quotaError({
      env: t.env,
      status: 429,
      quota: 'mcp_calls',
      plan: ent.plan,
      used: ent.usage.mcpCalls,
      limit: cap,
      resetsAt: ent.usage.resetsAt,
      message: isPaygCapped
        ? `Monthly pay-as-you-go spend cap reached on ${ent.plan}. Raise or disable your spend cap in billing settings, or use a local agent.`
        : `Monthly hosted MCP call allowance reached (${ent.usage.mcpCalls}/${cap} on ${ent.plan}).`,
      localAlternative: 'Run `npm run agent` locally for unlimited zero-host-quota access, or self-host on your own Cloudflare account.',
    });
  }

  if (method === 'agents_list') {
    await checkGrant('applications:read');
    t.ctx.waitUntil(recordAccountUsage(t.env, principal.account, { mcpCalls: 1 }, t.now()));
    const roster = pageAgents(t);
    return json({ value: { applicationId, pageId: t.tid, self: `mcp:${conn.grant_id}`, selfHandle: conn.handle, ...roster } });
  }

  if (method === 'describe_application') {
    await checkGrant('applications:read');
    t.ctx.waitUntil(recordAccountUsage(t.env, principal.account, { mcpCalls: 1 }, t.now()));
    let described: { queries: readonly any[]; commands: readonly any[] } | null = null;
    if (principal.wrapPrivateKey && readStoredGenesisBytes(t)) {
      described = await t.serializeMcp(() =>
        withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session }) => session.describe()),
      ).catch(() => null);
    }
    const configTools = t.db.get<{ tools?: { queries?: any[]; commands?: any[] } } | null>('application_configuration', null)?.tools;
    const rawQueries = described?.queries ?? configTools?.queries ?? [];
    const rawCommands = described?.commands ?? configTools?.commands ?? [];
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
    const meterCall = () => { t.ctx.waitUntil(recordAccountUsage(t.env, principal.account, { mcpCalls: 1 }, t.now())); };

    if (method === 'read_application_events') {
      await checkGrant('applications:read');
      if (!caps.read) throw new HttpError(403, 'read_not_permitted');
      meterCall();
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
      meterCall();
      const operationId = string(params.operationId, 512);
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session }) => {
        const op = await session.operations.get(operationId);
        return json({ value: { operationId, operation: op ? op.inspect() : null } });
      });
    }

    if (method === 'query_application' || method === 'agent_feed') {
      await checkGrant('applications:read');
      if (!caps.read) throw new HttpError(403, 'read_not_permitted');
      meterCall();
      const queryName = method === 'agent_feed' ? 'agentFeed' : string(params.query, 128);
      if (method === 'query_application' && caps.queries && !caps.queries.includes(queryName)) {
        throw new HttpError(403, 'operation_not_approved');
      }
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session }) => {
        if (method === 'agent_feed') {
          const view = await session.readView();
          try {
            const batch = await view.readEvents({ topics: ['agent/message', 'agent/receipt'], limit: 256 });
            return json({ value: { revision: view.revision, value: deriveAgentFeed([...batch.events]) } });
          } finally {
            await view.release();
          }
        }
        try {
          let result;
          try {
            result = await session.query(queryName, (params.input ?? null) as any);
          } catch (firstErr) {
            const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
            if (!firstMsg.startsWith('APPLICATION_QUERY_UNKNOWN') || queryName.includes(':')) throw firstErr;
            const topics = Object.keys((session.topic('$reducers') as any)?.topics ?? {})
              .filter(name => !name.startsWith('$') && !name.startsWith('agent/'));
            if (topics.length !== 1) throw firstErr;
            result = await session.query(`${topics[0]}:${queryName}`, (params.input ?? null) as any);
          }
          return json({ value: { revision: result.revision, value: result.value } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith('APPLICATION_QUERY_UNKNOWN')) throw new HttpError(404, 'query_not_found', `Unknown query "${queryName}".`);
          throw new HttpError(400, 'invalid_input', msg);
        }
      });
    }

    if (method === 'call_application_command' || method === 'agent_message') {
      await checkGrant('applications:write');
      await requireWritesOpen(t.env);
      if (!caps.write) throw new HttpError(403, 'write_not_permitted');
      if (ent.quotas.mcpStoreBytes !== null && mcpStoreBytes(t) >= ent.quotas.mcpStoreBytes) {
        throw quotaError({
          env: t.env,
          status: 413,
          quota: 'mcp_store',
          plan: ent.plan,
          used: mcpStoreBytes(t),
          limit: ent.quotas.mcpStoreBytes,
          resetsAt: null,
          message: `Hosted MCP encrypted sync storage limit reached for this page (${Math.round(ent.quotas.mcpStoreBytes / (1024 * 1024))} MB on ${ent.plan}).`,
          localAlternative: 'Your local browser and native Chronolog storage are unaffected; run `npm run agent` locally or upgrade for larger hosted MCP retention.',
        });
      }
      meterCall();
      const operationId = string(params.operationId, 512);
      return withHostedSession(t, conn, principal.wrapPublicKey, principal.wrapPrivateKey!, async ({ session, roster, requests, markRequestsDirty }) => {
        const fingerprint = await computeRequestFingerprint(
          method,
          method === 'call_application_command' ? string(params.command, 128) : 'agent_message',
          method === 'call_application_command' ? (params.input ?? null) : {
            channel: params.channel === 'agents' ? 'agents' : 'chat',
            text: params.text ?? null,
            to: params.to ?? [],
          },
        );
        const existingReq = requests[operationId];
        if (existingReq) {
          if (existingReq.fingerprint !== fingerprint) {
            throw new HttpError(409, 'operation_id_conflict', 'operationId was already used for a different request.');
          }
          const prior = session.operations.get(existingReq.proposalId);
          if (prior) {
            const inspected = prior.inspect();
            const materialized = inspected.materialized ?? await prior.materialized();
            return json({
              value: {
                operationId,
                proposalId: prior.id,
                author: conn.public_key,
                handle: conn.handle,
                stored: inspected.stored,
                materialized,
                excluded: inspected.excluded ?? false,
              },
            });
          }
        }
        let op;
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
          op = await session.submit({
            updates: [{
              topic: 'agent/message',
              input: {
                channel,
                to: resolvedTo,
                text: textVal,
                ...(params.data !== undefined ? { data: params.data as any } : {}),
                ...(Array.isArray(params.attachments) ? { attachments: params.attachments as any } : {}),
                ...(isPlainObject(params.inReplyTo) ? { inReplyTo: params.inReplyTo as any } : {}),
                hopCount: typeof params.hopCount === 'number' ? params.hopCount : 0,
                expectReply: params.expectReply !== false,
                ...(params.replyToUser === true ? { replyToUser: true } : {}),
              },
            }],
            operationId,
          });
        } else {
          const commandName = string(params.command, 128);
          if (caps.commands && !caps.commands.includes(commandName)) {
            throw new HttpError(403, 'operation_not_approved');
          }
          const described = await session.describe().catch(() => null);
          const cmdSpec = described?.commands.find(c => c.name === commandName);
          if (described && described.commands.length > 0 && !cmdSpec) {
            throw new HttpError(404, 'command_not_found', `Unknown command "${commandName}".`);
          }
          if (cmdSpec?.input) {
            const schemaErr = validateSchemaInput(cmdSpec.input, params.input ?? null);
            if (schemaErr) throw new HttpError(400, 'invalid_input', schemaErr);
          }
          try {
            try {
              op = await session.command(commandName, (params.input ?? null) as any, { operationId });
            } catch (firstErr) {
              const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
              if (!firstMsg.startsWith('APPLICATION_COMMAND_UNKNOWN') || commandName.includes(':')) throw firstErr;
              const topics = Object.keys((session.topic('$reducers') as any)?.topics ?? {})
                .filter(name => !name.startsWith('$') && !name.startsWith('agent/'));
              if (topics.length !== 1) throw firstErr;
              op = await session.command(`${topics[0]}:${commandName}`, (params.input ?? null) as any, { operationId });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith('APPLICATION_COMMAND_UNKNOWN')) throw new HttpError(404, 'command_not_found', `Unknown command "${commandName}".`);
            throw new HttpError(400, 'invalid_input', msg);
          }
        }

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('MATERIALIZE_TIMEOUT')), 10_000);
        let materialized;
        try {
          materialized = await op.materialized({ signal: ac.signal });
        } finally {
          clearTimeout(timer);
        }
        requests[operationId] = { fingerprint, proposalId: op.id };
        markRequestsDirty();
        const inspected = op.inspect();
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
