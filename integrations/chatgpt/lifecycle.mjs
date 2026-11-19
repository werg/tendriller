import { createHash } from 'node:crypto';
import { consumerOwner } from './consumer.mjs';

const ID = /^[a-f0-9]{64}$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export class LifecycleError extends Error {
  constructor(code, message = code, details) { super(message); this.name = 'LifecycleError'; this.code = code; if (details) this.details = details; }
}
const fail = (code, message, details) => { throw new LifecycleError(code, message, details); };
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail('LIFECYCLE_INPUT_INVALID', `Invalid ${label}`);
  return value;
}
function owner(principal) {
  const issuer = principal?.issuer ?? '', subject = text(principal?.id, 'authenticated account identity', 512);
  const { agentBindingId, clientId } = consumerOwner({ ...principal, issuer: issuer || 'legacy:unscoped' });
  return canonical([issuer, subject, ...(agentBindingId ? [{ agentBindingId }] : clientId ? [{ clientId }] : [])]);
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('LIFECYCLE_INPUT_INVALID', 'Unknown lifecycle input field');
}
function https(value, label) {
  let url; try { url = new URL(value); } catch { fail('LIFECYCLE_CONFIGURATION_INVALID', `Invalid ${label}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('LIFECYCLE_CONFIGURATION_INVALID', `${label} requires HTTPS without credentials, query or fragment`);
  return url;
}
function path(value) {
  text(value, 'authored path', 512);
  if (value.normalize('NFC') !== value || value.startsWith('/') || /[\\]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'node_modules')
    || /^(?:_tendril|_publications)(?:\/|$)/u.test(value)) fail('LIFECYCLE_PATH_INVALID');
  return value;
}
function graph(input, maxBytes) {
  const entry = path(input.entry ?? 'index.html');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 128) fail('LIFECYCLE_GRAPH_INVALID');
  let totalBytes = 0; const paths = new Set(), assets = new Map();
  const files = input.files.map(file => {
    fields(file, ['path', 'type', 'bytesBase64']);
    const name = path(file.path);
    if (paths.has(name)) fail('LIFECYCLE_GRAPH_INVALID', 'Duplicate authored path');
    paths.add(name);
    text(file.type, 'media type', 128);
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/iu.test(file.type)) fail('LIFECYCLE_GRAPH_INVALID', 'Invalid media type');
    if (typeof file.bytesBase64 !== 'string' || file.bytesBase64.length > Math.ceil(maxBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.bytesBase64)) fail('LIFECYCLE_ASSET_INVALID');
    const bytes = Buffer.from(file.bytesBase64, 'base64');
    if (bytes.toString('base64') !== file.bytesBase64) fail('LIFECYCLE_ASSET_INVALID');
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) fail('LIFECYCLE_GRAPH_TOO_LARGE');
    const digest = hash(bytes);
    assets.set(digest, { hash: digest, bytes: file.bytesBase64 });
    return { path: name, type: file.type, size: bytes.length, hash: digest };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some(file => file.path === entry && file.type === 'text/html')) fail('LIFECYCLE_ENTRY_INVALID', 'The complete graph needs an authored text/html entry');
  return { entry, files, assets: [...assets.values()], totalBytes };
}
function publicReview(record) {
  return { reviewId: record.id, reviewDigest: record.digest, applicationId: record.applicationId,
    operationId: record.operationId, ...(record.clientOperationId ? { clientOperationId: record.clientOperationId } : {}), status: record.status, totalBytes: record.totalBytes,
    unsigned: true, signingRequest: { operationId: record.operationId, entry: record.entry, files: record.files },
    expected: record.expected,
    handoff: { method: 'existing-publisher-device', action: 'Review the complete graph and sign with the application\'s enrolled publisher using signReviewedRelease. Return that exact SignedPublication; the bridge has no signer.' } };
}
function assertSignedMatches(record, signed) {
  if (!signed || !ID.test(signed.id) || typeof signed.signature !== 'string' || !signed.payload) fail('LIFECYCLE_SIGNATURE_REQUIRED');
  const expected = { ...record.expected, operationId: record.operationId, entry: record.entry, files: record.files };
  for (const [key, value] of Object.entries(expected)) {
    if (canonical(signed.payload[key]) !== canonical(value)) fail('LIFECYCLE_REVIEW_MISMATCH', `The signed publication differs from reviewed ${key}`);
  }
}
async function currentPublication(host, authority, peer) {
  const head = await host.peers.publication();
  if (head === null) return null;
  let item = head, expectedId;
  const seen = new Set();
  for (let count = 0; count < 256; count++) {
    if (!item?.publication || expectedId !== undefined && item.publication.id !== expectedId
      || item.version !== item.publication.payload.revision + 1 || seen.has(item.publication.id)) fail('LIFECYCLE_PUBLICATION_CHAIN_INVALID');
    seen.add(item.publication.id);
    await peer.verifyPublicationManifest(item.publication, authority);
    if (item.publication.payload.previous === null) {
      if (item.publication.payload.revision !== 0) fail('LIFECYCLE_PUBLICATION_CHAIN_INVALID');
      return { ...head, ancestryIds: [...seen] };
    }
    expectedId = item.publication.payload.previous;
    const previous = await host.peers.publication(expectedId);
    if (previous?.publication?.payload?.revision !== item.publication.payload.revision - 1) fail('LIFECYCLE_PUBLICATION_CHAIN_INVALID');
    item = previous;
  }
  fail('LIFECYCLE_PUBLICATION_CHAIN_LIMIT');
}

/** Durable review/receipt metadata only; no bridge-owned publisher signer. */
export function createLifecycleService({ store, creation, applications = [], authorizePublication,
  maxBytes = 8 * 1024 * 1024, loadCore = () => import('@tendriller/core'),
  loadPeer = () => import('@chronolog/peer-session'), clock = Date.now } = {}) {
  if (typeof store?.read !== 'function' || typeof store?.transaction !== 'function' || typeof store?.readBlob !== 'function'
    || !Array.isArray(applications) || applications.length > 128
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) fail('LIFECYCLE_CONFIGURATION_INVALID');
  if (authorizePublication !== undefined && typeof authorizePublication !== 'function') fail('LIFECYCLE_CONFIGURATION_INVALID');
  const configured = new Map();
  for (const input of applications) {
    if (!ID.test(input.id) || configured.has(input.id) || input.handle?.application?.id !== input.id
      || input.pinnedDescriptor?.payload?.applicationId !== input.id) fail('LIFECYCLE_CONFIGURATION_INVALID');
    https(input.handle.api, 'configured page API'); text(input.handle.token, 'configured page credential', 4096);
    configured.set(input.id, { ...input, handle: structuredClone(input.handle), pinnedDescriptor: structuredClone(input.pinnedDescriptor) });
  }
  let creationOrigin;
  if (creation) {
    const url = https(creation.origin, 'creation origin');
    if (url.origin !== creation.origin || typeof creation.ownerEmailForPrincipal !== 'function') fail('LIFECYCLE_CONFIGURATION_INVALID');
    creationOrigin = url.origin;
  }
  const limitedFetch = fetcher => (url, options = {}) => fetcher(url, { ...options, redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]) });
  const records = state => { state.chatgptLifecycle ??= { creations: {}, reviews: {} }; return state.chatgptLifecycle; };
  const assetKey = (id, digest) => `${id}:${digest}`;
  async function retainedAssets(record) {
    // Upgrade an earlier private journal atomically when its review is used.
    // The same aggregate budget applies; no metadata-only update copies assets.
    if (record.assets.some(asset => typeof asset.bytes === 'string')) {
      record = await store.transaction((state, blobs) => {
        const saved = records(state).reviews[record.id];
        saved.assets = saved.assets.map(asset => {
          if (asset.blobKey) return asset;
          const bytes = Buffer.from(asset.bytes, 'base64');
          if (hash(bytes) !== asset.hash) fail('LIFECYCLE_ASSET_INVALID');
          const blobKey = assetKey(saved.id, asset.hash); blobs.put(blobKey, bytes);
          return { hash: asset.hash, blobKey };
        });
        return saved;
      });
    }
    return Promise.all(record.assets.map(async asset => {
      const bytes = await store.readBlob(asset.blobKey);
      if (!bytes || hash(bytes) !== asset.hash) fail('LIFECYCLE_ASSET_UNAVAILABLE', 'Restore the encrypted reviewed asset before signing or publication');
      return { hash: asset.hash, bytes: bytes.toString('base64') };
    }));
  }
  async function application(id) {
    const configuredApp = configured.get(id);
    if (!configuredApp) fail('LIFECYCLE_APPLICATION_UNAVAILABLE');
    const [core, peer] = await Promise.all([loadCore(), loadPeer()]);
    const host = core.createClient(configuredApp.handle, { applicationId: id,
      fetch: limitedFetch(configuredApp.fetch ?? globalThis.fetch) });
    const info = await host.info();
    if (info.application?.id !== id) fail('LIFECYCLE_APPLICATION_SCOPE_MISMATCH');
    if (!info.owner_account_id) fail('LIFECYCLE_OWNER_CLAIM_REQUIRED', 'The human owner must claim this page before preparing a release');
    if (configuredApp.ownerAccountId !== undefined && info.owner_account_id !== configuredApp.ownerAccountId) fail('LIFECYCLE_OWNER_SCOPE_MISMATCH');
    const authority = await peer.verifyAuthorityBundle(await host.peers.application(), configuredApp.pinnedDescriptor);
    if (authority.descriptor.applicationId !== id) fail('LIFECYCLE_APPLICATION_SCOPE_MISMATCH');
    return { host, peer, authority };
  }
  return Object.freeze({
    capabilities: Object.freeze({ create: Boolean(creation), prepare: configured.size > 0, publish: typeof authorizePublication === 'function' }),
    async createTendril(principal, input) {
      const account = owner(principal); fields(input, ['requestId', 'name']);
      if (!creation) fail('LIFECYCLE_CREATION_UNAVAILABLE');
      text(input.requestId, 'creation request ID'); text(input.name, 'page name', 200);
      const email = await creation.ownerEmailForPrincipal(principal);
      if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail('LIFECYCLE_VERIFIED_OWNER_REQUIRED');
      const key = hash(canonical([account, input.requestId])), digest = hash(canonical({ name: input.name, email }));
      const existing = await store.transaction(state => {
        const creations = records(state).creations, previous = creations[key];
        if (previous) {
          if (previous.digest !== digest) fail('LIFECYCLE_CREATION_CONFLICT');
          if (previous.status === 'not_sent') { previous.status = 'creating'; return null; }
          return previous;
        }
        if (Object.keys(creations).length >= 128) fail('LIFECYCLE_JOURNAL_FULL');
        creations[key] = { account, digest, requestId: input.requestId, status: 'creating', createdAt: clock() };
        return null;
      });
      if (existing?.status === 'created') return existing.result;
      if (existing) fail('LIFECYCLE_CREATION_UNCERTAIN', 'Inspect the host/account state before creating another page; the first response may have been lost', { requestId: input.requestId });
      let attempted = false;
      try {
        const core = await loadCore();
        const fetch = limitedFetch(creation.fetch ?? globalThis.fetch);
        core.requireService(await core.describeService(creationOrigin, { fetch }));
        // Tendriller creation uses a verified owner email and expressly rejects
        // Authorization headers. Account authorization belongs to this service.
        attempted = true;
        const handle = await core.createPage(creationOrigin, { name: input.name, owner: email, lifetime: 'ad_hoc' }, { fetch });
        if (https(handle.api, 'created page API').origin !== creationOrigin || !ID.test(handle.application?.id)) fail('LIFECYCLE_CREATED_HANDLE_INVALID');
        https(handle.page_url, 'owner claim URL');
        const result = { requestId: input.requestId, pageId: handle.id, applicationId: handle.application.id,
          claimUrl: handle.page_url, status: 'owner_claim_required', expiresAt: handle.expires_at ?? null,
          nextStep: 'The human owner opens claimUrl and signs in. Creating a page does not claim it, enroll a bridge or publish application code.' };
        await store.transaction(state => { Object.assign(records(state).creations[key], { status: 'created', handle, result }); });
        return result;
      } catch (error) {
        if (!attempted) {
          await store.transaction(state => { records(state).creations[key].status = 'not_sent'; });
          throw new LifecycleError('LIFECYCLE_CREATION_PRECHECK_FAILED', 'The service precheck failed before page creation was sent; retry the same request after restoring access',
            { requestId: input.requestId, causeCode: error.code ?? error.name });
        }
        await store.transaction(state => { records(state).creations[key].status = 'uncertain'; });
        throw new LifecycleError('LIFECYCLE_CREATION_UNCERTAIN', 'Creation did not produce a safely retained handle; inspect the host before another create',
          { requestId: input.requestId, causeCode: error.code ?? error.name });
      }
    },
    async preparePageRelease(principal, input) {
      const account = owner(principal); fields(input, ['applicationId', 'operationId', 'entry', 'files']);
      if (!configured.has(input.applicationId)) fail('LIFECYCLE_APPLICATION_UNAVAILABLE');
      text(input.operationId, 'publication operation ID');
      const packed = graph(input, maxBytes), id = `review_${hash(canonical([account, input.applicationId, input.operationId]))}`;
      const inputDigest = hash(canonical({ applicationId: input.applicationId, operationId: input.operationId, entry: packed.entry, files: packed.files }));
      const existing = (await store.read()).chatgptLifecycle?.reviews?.[id];
      if (existing) {
        if (existing.account !== account || existing.inputDigest !== inputDigest) fail('LIFECYCLE_REVIEW_CONFLICT');
        return publicReview(existing);
      }
      const { host, peer, authority } = await application(input.applicationId), selected = await currentPublication(host, authority, peer);
      const expected = { applicationId: input.applicationId, historyId: authority.descriptor.historyId,
        profile: authority.descriptor.profile, controlRevision: authority.control.payload.revision,
        definitionDigest: authority.descriptor.definitionDigest, executionManifestDigest: authority.descriptor.executionManifestDigest,
        previous: selected?.publication.id ?? null, revision: selected ? selected.publication.payload.revision + 1 : 0 };
      const { assets, ...packedMetadata } = packed;
      const scoped = principal.agentBinding?.id ?? principal.agentBindingId ?? principal.clientId;
      const record = { id, account, applicationId: input.applicationId,
        operationId: scoped ? `publication_v2_${hash(canonical([account, input.applicationId, input.operationId]))}` : input.operationId,
        ...(scoped ? { clientOperationId: input.operationId } : {}), inputDigest,
        ...packedMetadata, assets: assets.map(asset => ({ hash: asset.hash, blobKey: assetKey(id, asset.hash) })),
        expected, status: 'awaiting_publisher_signature', createdAt: clock() };
      record.digest = hash(canonical({ format: 'tendriller-page-review-v1', ...expected,
        operationId: record.operationId, entry: record.entry, files: record.files }));
      return store.transaction((state, blobs) => {
        const reviews = records(state).reviews, previous = reviews[id];
        if (previous) {
          if (previous.inputDigest !== inputDigest || previous.digest !== record.digest) fail('LIFECYCLE_REVIEW_CONFLICT');
          return publicReview(previous);
        }
        if (Object.keys(reviews).length >= 256) fail('LIFECYCLE_JOURNAL_FULL');
        for (const asset of assets) blobs.put(assetKey(id, asset.hash), Buffer.from(asset.bytes, 'base64'));
        reviews[id] = record; return publicReview(record);
      });
    },
    async getReviewBundle(principal, input) {
      const account = owner(principal); fields(input, ['reviewId']);
      const record = (await store.read()).chatgptLifecycle?.reviews?.[input.reviewId];
      if (!record || record.account !== account) fail('LIFECYCLE_REVIEW_UNAVAILABLE');
      // Trusted publisher export / owner review only. Do not turn this into an
      // automatically invoked remote tool that echoes complete authored bytes.
      return { ...publicReview(record), assets: await retainedAssets(record),
        ...(record.signedPublication ? { signedPublication: structuredClone(record.signedPublication) } : {}) };
    },
    async publishPageRelease(principal, input) {
      const account = owner(principal); fields(input, ['reviewId', 'reviewDigest', 'signedPublication']);
      const record = (await store.read()).chatgptLifecycle?.reviews?.[input.reviewId];
      if (!record || record.account !== account) fail('LIFECYCLE_REVIEW_UNAVAILABLE');
      if (input.reviewDigest !== record.digest) fail('LIFECYCLE_REVIEW_MISMATCH');
      if (!authorizePublication) fail('LIFECYCLE_PUBLICATION_APPROVAL_REQUIRED', 'This deployment requires owner approval of the reviewed digest before publication');
      const signed = structuredClone(input.signedPublication); assertSignedMatches(record, signed);
      const { host, peer, authority } = await application(record.applicationId);
      await peer.verifyPublicationManifest(signed, authority);
      const selected = await currentPublication(host, authority, peer);
      const alreadyPublished = selected?.ancestryIds.includes(signed.id) === true;
      if (!alreadyPublished) await peer.authorizePublication(signed, authority, selected?.publication ?? null);
      if (await authorizePublication(principal, { ...publicReview(record), signedPublicationId: signed.id, publisher: signed.payload.author }) !== true) {
        fail('LIFECYCLE_PUBLICATION_APPROVAL_REQUIRED', 'The owner has not approved this exact review and publisher signature');
      }
      const previous = await store.transaction(state => {
        const saved = records(state).reviews[record.id];
        if (saved.signedPublication && canonical(saved.signedPublication) !== canonical(signed)) fail('LIFECYCLE_SIGNATURE_CONFLICT');
        if (saved.status === 'published') return saved.receipt;
        Object.assign(saved, { signedPublication: signed, status: 'publishing' }); return null;
      });
      if (previous) return previous;
      try {
        // An exact retry can name an earlier retained publication after later
        // releases. Verify its membership in selected ancestry, then recover the
        // original receipt instead of treating it as a new stale predecessor.
        const receipt = alreadyPublished ? await host.peers.publication(signed.id) : await host.peers.publish(signed, await retainedAssets(record));
        if (receipt?.publication?.id !== signed.id || canonical(receipt.publication) !== canonical(signed)
          || receipt.version !== signed.payload.revision + 1) fail('LIFECYCLE_PUBLICATION_RECEIPT_INVALID');
        await peer.verifyPublicationManifest(receipt.publication, authority);
        await store.transaction(state => { Object.assign(records(state).reviews[record.id], { status: 'published', receipt }); });
        return receipt;
      } catch (error) {
        await store.transaction(state => { records(state).reviews[record.id].status = 'uncertain'; });
        throw new LifecycleError('LIFECYCLE_PUBLICATION_UNCERTAIN', 'Inspect or retry the exact saved publication; do not sign a new release for a lost reply',
          { reviewId: record.id, operationId: record.operationId, publicationId: signed.id, causeCode: error.code ?? error.name });
      }
    },
  });
}

/** Run on the user's existing publisher device; never exposed as a remote tool. */
export async function signReviewedRelease(review, { session, control }) {
  if (!review?.unsigned || session?.applicationId !== review.applicationId || typeof control?.preparePublication !== 'function') fail('LIFECYCLE_SIGNING_SESSION_INVALID');
  if (review.operationId !== review.signingRequest?.operationId || review.applicationId !== review.expected?.applicationId
    || review.reviewDigest !== hash(canonical({ format: 'tendriller-page-review-v1', ...review.expected,
      operationId: review.operationId, entry: review.signingRequest.entry, files: review.signingRequest.files }))) fail('LIFECYCLE_REVIEW_MISMATCH');
  if (!Array.isArray(review.assets) || !review.assets.length || review.assets.length > 128) fail('LIFECYCLE_REVIEW_ASSETS_REQUIRED', 'Export and review the actual authored bytes before signing');
  const assets = new Map();
  for (const asset of review.assets) {
    if (!asset || !ID.test(asset.hash) || assets.has(asset.hash)) fail('LIFECYCLE_ASSET_INVALID');
    assets.set(asset.hash, asset.bytes);
  }
  const actual = graph({ entry: review.signingRequest.entry, files: review.signingRequest.files.map(file => ({
    path: file.path, type: file.type, bytesBase64: assets.get(file.hash),
  })) }, 8 * 1024 * 1024);
  if (canonical(actual.files) !== canonical(review.signingRequest.files) || actual.assets.length !== assets.size) fail('LIFECYCLE_REVIEW_MISMATCH', 'The exported authored bytes differ from the reviewed manifest');
  const authority = await control.application();
  const grant = authority.controls.at(-1)?.payload.grants.find(value => value.publicKey === session.deviceId);
  if (grant?.publisher !== true) fail('LIFECYCLE_PUBLISHER_GRANT_REQUIRED');
  const current = await control.publication();
  // A lost response after publication can be reconciled from the verified
  // selected signed manifest without producing a replacement signature.
  if (current?.publication?.payload.operationId === review.operationId && current.publication.payload.author === session.deviceId) {
    assertSignedMatches({ expected: review.expected, operationId: review.operationId,
      entry: review.signingRequest.entry, files: review.signingRequest.files }, current.publication);
    return current.publication;
  }
  if (authority.descriptor.payload.applicationId !== review.expected.applicationId
    || authority.controls.at(-1).payload.revision !== review.expected.controlRevision
    || (current?.publication.id ?? null) !== review.expected.previous) fail('LIFECYCLE_SIGNING_CONTEXT_CHANGED', 'Review a new operation against the current publication/control context');
  const signed = await control.preparePublication(review.signingRequest);
  assertSignedMatches({ expected: review.expected, operationId: review.operationId,
    entry: review.signingRequest.entry, files: review.signingRequest.files }, signed);
  return signed;
}
