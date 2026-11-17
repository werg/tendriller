import { AsyncLocalStorage } from 'node:async_hooks';
import {
  RELEASE_LIMITS, createReleaseRegistry, peerDigest, decodePeerValue, validateReleasePolicyRequest, verifyReleaseAsset,
  type PeerStore, type ReleaseRegistry, type ReleaseState, type ReleaseAsset, type ReleaseApplicationBinding,
  type SignedReleaseManifest, type SignedReleaseActivation, type SignedReleaseActivationRequest,
} from '@chronolog/peer-generation/control';
import { RELEASE_SOCKET_PROTOCOL } from '../../contract/releases.mjs';
import type { ReleaseBootstrap, HostedReleasePolicyRequest } from '../../contract/releases.mjs';
import { currentPrincipal, pageAccessAllowed, accountActive, type Principal } from './access';
import { selectedApplication } from './application';
import { assertStoredContent, fileKey, storeContent } from './content';
import { HttpError, json, readBody, readJson } from './http';
import { sha256Hex } from './ids';
import { changeLifetime, hasResidentStorage } from './lifetime';
import { ensurePeerControlIdentity, loadPeerControlIdentity } from './peer-control-identity';
import { peerApplicationBinding } from './peer-generations';
import runtimeRelease from './runtime-release.json';
import type { Tendril } from './tendril';

const INITIALIZED = 'peer_release_initialized', ACCOUNTS = 'peer_release_accounts';
const DIGEST = /^[0-9a-f]{64}$/, MAX_PENDING = 8, VALUE_LIMIT = 16 * 1024 * 1024;
export const RELEASE_ROUTE = /^peers\/releases(?:\/(?:policy|socket|activations|manifests(?:\/[0-9a-f]{64})?|content\/[0-9a-f]{64}))?$/;
interface AccountBinding { publicKey: string; accountId: string }
interface CommitContext {
  readonly principal: Principal;
  readonly ownerOnly: boolean;
  guard?: () => void;
  check?: () => Promise<void>;
  committed?: (key: string) => void;
}
interface HostState { admitted: number; store: PeerStore; registry?: Promise<ReleaseRegistry> }
const contexts = new AsyncLocalStorage<CommitContext>();
const hosts = new WeakMap<Tendril, HostState>();

function prefix(t: Tendril): string {
  const application = selectedApplication(t);
  if (application.kind !== 'peer') throw new HttpError(409, 'application_backend', 'Chronolog releases belong to a peer page');
  if (!DIGEST.test(application.id)) throw new HttpError(400, 'peer_application_identity');
  return `chronolog-release/${application.id}`;
}
function account(t: Tendril, principal: Principal, ownerOnly = false): string | null {
  prefix(t);
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!owner || !current || current.kind === 'producer') throw new HttpError(403, 'forbidden');
  const id = current.kind === 'agent' ? owner : current.accountId;
  if (ownerOnly && id !== owner) throw new HttpError(403, 'forbidden', 'Only the page owner can configure release publishers');
  return id;
}
async function freshAccess(t: Tendril, principal: Principal, ownerOnly = false): Promise<void> {
  const id = account(t, principal, ownerOnly);
  if (!await pageAccessAllowed(t) || id !== null && !await accountActive(t, id)) throw new HttpError(403, 'forbidden');
  account(t, principal, ownerOnly);
}
function publisherAccount(t: Tendril, principal: Principal, publicKey: string): void {
  const id = account(t, principal);
  if (!id || !t.db.get<AccountBinding[]>(ACCOUNTS, []).some(binding => binding.publicKey === publicKey && binding.accountId === id))
    throw new HttpError(403, 'release_publisher_account', 'The publication key is not bound to this authenticated account');
}
function admittedAccounts(t: Tendril, bindings: readonly AccountBinding[]): void {
  const owner = t.db.get<string | null>('owner_account', null);
  for (const binding of bindings) if (binding.accountId !== owner && !t.db.one(
    'SELECT 1 FROM guest_accounts WHERE account_id=? AND approved=1 LIMIT 1', binding.accountId))
    throw new HttpError(403, 'release_account_unavailable', 'Release publishers require current page account access');
  const known = new Map(t.db.get<AccountBinding[]>(ACCOUNTS, []).map(binding => [binding.publicKey, binding.accountId]));
  for (const binding of bindings) {
    if (known.has(binding.publicKey) && known.get(binding.publicKey) !== binding.accountId)
      throw new HttpError(409, 'release_publisher_account_immutable', 'A publication key cannot be reassigned to another account');
    known.set(binding.publicKey, binding.accountId);
  }
  if (known.size > 1024) throw new HttpError(413, 'release_account_limit');
}
async function activeAccounts(t: Tendril, bindings: readonly AccountBinding[]): Promise<void> {
  for (const binding of bindings) if (!await accountActive(t, binding.accountId)) throw new HttpError(403, 'release_account_unavailable');
  admittedAccounts(t, bindings);
}

function host(t: Tendril): HostState {
  let state = hosts.get(t);
  if (state) return state;
  state = { admitted: 0, store: {
    async get(key) {
      const row = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM membership_records WHERE key=?', key);
      return row ? new Uint8Array(row.value).slice() : null;
    },
    async put(key, value) {
      const namespace = prefix(t), context = contexts.getStore();
      if (!context) throw new HttpError(500, 'release_commit_context_missing');
      if (key !== `${namespace}/head` && !(key.startsWith(`${namespace}/manifest/`) && DIGEST.test(key.slice(`${namespace}/manifest/`.length))))
        throw new HttpError(403, 'release_storage_scope');
      if (value.byteLength > VALUE_LIMIT) throw new HttpError(413, 'release_storage_limit');
      const bytes = value.slice();
      await context.check?.();
      await freshAccess(t, context.principal, context.ownerOnly);
      t.transaction(() => {
        account(t, context.principal, context.ownerOnly); context.guard?.();
        if (!hasResidentStorage(t)) throw new HttpError(409, 'release_storage_unavailable');
        t.db.run('INSERT INTO membership_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, bytes.buffer);
        if (key === `${namespace}/head`) t.db.set(INITIALIZED, true);
        context.committed?.(key);
      });
    },
  } };
  hosts.set(t, state); return state;
}

async function* content(t: Tendril, asset: ReleaseAsset, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  signal?.throwIfAborted();
  const record = t.db.one<{ size: number }>('SELECT size FROM page_release_content WHERE hash=?', asset.digest);
  if (!record || record.size !== asset.bytes) throw new HttpError(409, 'release_content_missing', 'Upload exact release content before publishing');
  assertStoredContent(t, [{ hash: asset.digest, size: asset.bytes }]);
  const object = await t.env.FILES.get(fileKey(t, asset.digest));
  if (signal?.aborted) await object?.body.cancel(signal.reason).catch(() => {});
  signal?.throwIfAborted();
  if (!object || object.size !== asset.bytes) throw new HttpError(409, 'release_content_missing');
  yield* streamObject(object, signal);
}

async function* streamObject(object: R2ObjectBody, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const reader = object.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      for (let offset = 0; offset < next.value.byteLength; offset += RELEASE_LIMITS.chunkBytes)
        yield next.value.slice(offset, offset + RELEASE_LIMITS.chunkBytes);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Verify one immutable object before reopening that exact storage version for a response. */
export async function verifiedReleaseObject(t: Tendril, asset: ReleaseAsset, signal?: AbortSignal): Promise<R2ObjectBody> {
  assertStoredContent(t, [{ hash: asset.digest, size: asset.bytes }]);
  const key = fileKey(t, asset.digest), original = await t.env.FILES.get(key);
  if (!original || original.size !== asset.bytes) {
    await original?.body.cancel().catch(() => {});
    throw new HttpError(503, 'release_content_missing');
  }
  try { await verifyReleaseAsset(asset, { read: (_asset, options) => streamObject(original, options?.signal) }, { signal }); }
  catch (error) {
    await original.body.cancel().catch(() => {});
    if (signal?.aborted) throw signal.reason;
    throw new HttpError(503, 'release_content_corrupt', 'Stored release bytes failed verification');
  }
  signal?.throwIfAborted();
  const selected = await t.env.FILES.get(key, { onlyIf: { etagMatches: original.etag } });
  if (!selected || !('body' in selected) || selected.version !== original.version || selected.etag !== original.etag || selected.size !== asset.bytes) {
    if (selected && 'body' in selected) await selected.body.cancel().catch(() => {});
    throw new HttpError(503, 'release_content_changed', 'Release storage changed during verification');
  }
  if (signal?.aborted) { await selected.body.cancel(signal.reason).catch(() => {}); signal.throwIfAborted(); }
  try { assertStoredContent(t, [{ hash: asset.digest, size: asset.bytes }]); }
  catch (error) { await selected.body.cancel().catch(() => {}); throw error; }
  return selected;
}

async function registry(t: Tendril, create = false): Promise<ReleaseRegistry> {
  const state = host(t);
  if (state.registry) return state.registry;
  const initialized = t.db.get<boolean>(INITIALIZED, false);
  if (!initialized && !create) throw new HttpError(409, 'release_unconfigured', 'Configure the independent publication policy first');
  state.registry = (async () => {
    const signer = initialized ? await loadPeerControlIdentity(t) : await ensurePeerControlIdentity(t);
    if (!signer) throw new HttpError(503, 'release_control_state_missing');
    return createReleaseRegistry({ store: state.store, applicationId: selectedApplication(t).id, signer, requireExisting: initialized,
      content: { read: (asset, options = {}) => content(t, asset, options.signal) },
      application: async () => peerApplicationBinding(t),
    });
  })();
  try { return await state.registry; }
  catch (error) { state.registry = undefined; throw error; }
}

/** Serving reads durable release evidence; no application data or epoch keys enter this participant. */
export async function peerReleaseBootstrap(t: Tendril): Promise<ReleaseBootstrap | null> {
  if (!t.db.get(INITIALIZED, false)) return null;
  try {
    const service = await registry(t), state = await service.read(), active = state.activations.at(-1);
    return { state, manifest: active ? await service.manifest(active.payload.releaseId) : null };
  } catch (error) { typedError(error); }
}
export async function peerReleaseManifest(t: Tendril, id: string): Promise<SignedReleaseManifest | null> {
  return (await registry(t)).manifest(id);
}
export function peerReleaseVersion(t: Tendril): number {
  const active = t.db.get<SignedReleaseActivation | null>('peer_release_active', null);
  return active ? active.payload.revision + 1 : 0;
}
function sameApplication(a: ReleaseApplicationBinding | null, b: ReleaseApplicationBinding | null): boolean {
  return a === null || b === null ? a === b : a.historyId === b.historyId && a.definitionDigest === b.definitionDigest &&
    a.executionManifestDigest === b.executionManifestDigest && a.schemaDigest === b.schemaDigest;
}

function parsePolicy(t: Tendril, input: unknown, owner: string): { request: HostedReleasePolicyRequest; bindings: AccountBinding[]; publishers: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'expectedPolicy', 'publishers'].includes(key)))
    throw new HttpError(400, 'bad_request', 'Expected the complete release policy request');
  const request = input as HostedReleasePolicyRequest;
  if (!Array.isArray(request.publishers) || request.publishers.length > RELEASE_LIMITS.publishers) throw new HttpError(400, 'bad_request');
  const bindings = request.publishers.map(value => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['publicKey', 'accountId'].includes(key)) ||
        !DIGEST.test(value.publicKey) || value.accountId !== undefined && (typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 160))
      throw new HttpError(400, 'bad_request', 'Expected a publisher key and admitted account');
    return { publicKey: value.publicKey, accountId: value.accountId ?? owner };
  }).sort((a, b) => a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0);
  const publishers = bindings.map(binding => binding.publicKey);
  validateReleasePolicyRequest({ requestId: request.requestId, expectedPolicy: request.expectedPolicy, publishers });
  admittedAccounts(t, bindings);
  return { request, bindings, publishers };
}
function mayUpload(t: Tendril, principal: Principal): void {
  const id = account(t, principal);
  if (!id) throw new HttpError(403, 'forbidden');
  if (id === t.db.get('owner_account', '')) return;
  const publishers = t.db.get<string[]>('peer_release_publishers', []);
  if (!t.db.get<AccountBinding[]>(ACCOUNTS, []).some(binding => binding.accountId === id && publishers.includes(binding.publicKey)))
    throw new HttpError(403, 'release_publisher_account');
}
function typedError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code.startsWith('RELEASE_') || code.startsWith('PEER_')) {
    const status = /SIGNATURE|KEY_MISMATCH|PUBLISHER_DENIED/.test(code) ? 403 : /STATE_MISSING/.test(code) ? 503
      : /REQUEST_LIMIT/.test(code) ? 429 : /LIMIT|TOO_LARGE/.test(code) ? 413
      : /CONFLICT|CHANGED|REUSED|MISSING|REQUIRED/.test(code) ? 409 : 400;
    throw new HttpError(status, code.toLowerCase(), code);
  }
  throw error;
}

export async function handlePeerReleases(t: Tendril, req: Request, path: string, principal: Principal): Promise<Response> {
  const ownerOnly = path === 'peers/releases/policy';
  account(t, principal, ownerOnly);
  const state = host(t);
  if (state.admitted >= MAX_PENDING) throw new HttpError(429, 'release_busy');
  state.admitted++;
  const context: CommitContext = { principal, ownerOnly };
  try { return await contexts.run(context, () => processRelease(t, req, path, principal, context)); }
  catch (error) { typedError(error); }
  finally { state.admitted--; }
}

async function processRelease(t: Tendril, req: Request, path: string, principal: Principal, context: CommitContext): Promise<Response> {
  await freshAccess(t, principal, context.ownerOnly);
  if (path === 'peers/releases/socket') return openWatch(t, req, principal);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const contentId = /^peers\/releases\/content\/([0-9a-f]{64})$/.exec(path)?.[1];
  if (contentId && method === 'PUT') {
    mayUpload(t, principal);
    const body = await readBody(req, RELEASE_LIMITS.fileBytes);
    if (await sha256Hex(body) !== contentId) throw new HttpError(422, 'release_content_digest_mismatch');
    await freshAccess(t, principal); mayUpload(t, principal);
    const result = await storeContent(t, body, 'application/octet-stream', hash => {
      mayUpload(t, principal);
      t.db.run('INSERT INTO page_release_content(hash,size,created_at) VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET created_at=excluded.created_at', hash, body.byteLength, t.now());
    }, async () => { await freshAccess(t, principal); mayUpload(t, principal); });
    await freshAccess(t, principal);
    return json({ digest: result.hash, bytes: result.size });
  }
  if (contentId && method === 'GET') {
    const record = t.db.one<{ size: number }>('SELECT size FROM page_release_content WHERE hash=?', contentId);
    if (!record) throw new HttpError(404, 'release_content_missing');
    if (!t.db.one('SELECT 1 FROM page_release_assets WHERE hash=? LIMIT 1', contentId)) mayUpload(t, principal);
    const object = await verifiedReleaseObject(t, { path: 'content.bin', digest: contentId, bytes: record.size, mediaType: 'application/octet-stream' }, req.signal);
    try { await freshAccess(t, principal); }
    catch (error) { await object.body.cancel().catch(() => {}); throw error; }
    if (req.method === 'HEAD') await object.body.cancel().catch(() => {});
    return new Response(req.method === 'HEAD' ? null : object.body, { headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), ETag: `"${contentId}"`,
      'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
    } });
  }
  if (path === 'peers/releases/policy' && method === 'PUT') {
    const owner = account(t, principal, true)!;
    const { request, bindings, publishers } = parsePolicy(t, await readJson(req, 64 * 1024), owner);
    const fingerprint = await peerDigest({ requestId: request.requestId, expectedPolicy: request.expectedPolicy, bindings });
    const fingerprintKey = `peer_release_policy/${await peerDigest(request.requestId)}`;
    const previous = t.db.get<string | null>(fingerprintKey, null);
    if (previous !== null && previous !== fingerprint) throw new HttpError(409, 'release_policy_request_reused');
    await activeAccounts(t, bindings); await changeLifetime(t, 'resident');
    context.check = () => activeAccounts(t, bindings);
    context.guard = () => admittedAccounts(t, bindings);
    context.committed = key => {
      if (key !== `${prefix(t)}/head`) return;
      const bytes = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM membership_records WHERE key=?', key)!;
      const head = decodePeerValue<{ state: ReleaseState }>(new Uint8Array(bytes.value));
      if (head.state.policies.at(-1)?.payload.requestId !== request.requestId) return;
      const known = new Map(t.db.get<AccountBinding[]>(ACCOUNTS, []).map(binding => [binding.publicKey, binding]));
      for (const binding of bindings) known.set(binding.publicKey, binding);
      t.db.set(ACCOUNTS, [...known.values()]); t.db.set(fingerprintKey, fingerprint);
      t.db.set('peer_release_publishers', publishers);
    };
    const policy = await (await registry(t, true)).configure({ requestId: request.requestId, expectedPolicy: request.expectedPolicy, publishers });
    await freshAccess(t, principal, true); return json(policy);
  }
  const service = await registry(t);
  if (path === 'peers/releases' && method === 'GET') {
    const result = await service.read(); await freshAccess(t, principal); return json(result);
  }
  const manifestId = /^peers\/releases\/manifests\/([0-9a-f]{64})$/.exec(path)?.[1];
  if (manifestId && method === 'GET') {
    const result = await service.manifest(manifestId); await freshAccess(t, principal); return json(result);
  }
  if (path === 'peers/releases/manifests' && method === 'POST') {
    const manifest = await readJson(req, RELEASE_LIMITS.manifestBytes + 1024) as SignedReleaseManifest;
    publisherAccount(t, principal, manifest?.payload?.publisher);
    const id = await peerDigest(manifest);
    context.guard = () => publisherAccount(t, principal, manifest.payload.publisher);
    context.committed = key => {
      if (key !== `${prefix(t)}/head`) return;
      assertStoredContent(t, manifest.payload.assets.map(asset => ({ hash: asset.digest, size: asset.bytes })));
      t.db.run('INSERT OR IGNORE INTO page_release_publications(release_id,runtime_id,runtime_version,runtime_features) VALUES(?,?,?,?)',
        id, runtimeRelease.id, runtimeRelease.version, JSON.stringify(runtimeRelease.features));
      for (const asset of manifest.payload.assets) t.db.run('INSERT OR IGNORE INTO page_release_assets(release_id,path,hash,size,type) VALUES(?,?,?,?,?)',
        id, asset.path, asset.digest, asset.bytes, asset.mediaType);
    };
    const result = await service.publish(manifest); await freshAccess(t, principal); context.guard(); return json(result);
  }
  if (path === 'peers/releases/activations' && method === 'POST') {
    const request = await readJson(req, 16 * 1024) as SignedReleaseActivationRequest;
    publisherAccount(t, principal, request?.payload?.publisher);
    const manifest = await service.manifest(request?.payload?.releaseId);
    if (!manifest) throw new HttpError(409, 'release_manifest_missing');
    context.guard = () => {
      publisherAccount(t, principal, request.payload.publisher);
      if (!sameApplication(peerApplicationBinding(t), manifest.payload.application))
        throw new HttpError(409, 'release_application_boundary_required');
      assertStoredContent(t, manifest.payload.assets.map(asset => ({ hash: asset.digest, size: asset.bytes })));
    };
    context.committed = key => {
      if (key !== `${prefix(t)}/head`) return;
      const bytes = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM membership_records WHERE key=?', key)!;
      const active = decodePeerValue<{ state: ReleaseState }>(new Uint8Array(bytes.value)).state.activations.at(-1)!;
      t.db.set('peer_release_active', active);
      t.afterCommit(() => notifyRelease(t, active));
    };
    const result = await service.activate(request); await freshAccess(t, principal); publisherAccount(t, principal, request.payload.publisher); return json(result);
  }
  throw new HttpError(405, 'method_not_allowed');
}

interface ReleaseAttachment { kind: 'release'; principal: Principal }
function attachment(socket: WebSocket): ReleaseAttachment | null {
  const value = socket.deserializeAttachment() as ReleaseAttachment | null;
  return value?.kind === 'release' ? value : null;
}
export const isReleaseSocket = (socket: WebSocket): boolean => attachment(socket) !== null;
async function openWatch(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(RELEASE_SOCKET_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Release subscriptions require ${RELEASE_SOCKET_PROTOCOL}`);
  if (t.ctx.getWebSockets('releases').length >= 64) throw new HttpError(429, 'release_subscription_limit');
  await (await registry(t)).read();
  await freshAccess(t, principal);
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, ['releases']); server.serializeAttachment({ kind: 'release', principal } satisfies ReleaseAttachment);
  const active = t.db.get<SignedReleaseActivation | null>('peer_release_active', null);
  if (active) server.send(JSON.stringify(active));
  return new Response(null, { status: 101, webSocket: client });
}
async function notifyRelease(t: Tendril, activation: SignedReleaseActivation): Promise<void> {
  for (const socket of t.ctx.getWebSockets('releases')) {
    const value = attachment(socket);
    if (!value || socket.readyState !== WebSocket.READY_STATE_OPEN) continue;
    try { await freshAccess(t, value.principal); socket.send(JSON.stringify(activation)); }
    catch { try { socket.close(4003, 'Page access revoked'); } catch {} }
  }
}
