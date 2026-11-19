// Node-only enrollment retry/review policy. Signed authority remains decisive.
import { createHash } from 'node:crypto';
import { peerDigest, verifyAuthorityBundle } from '@chronolog/peer-session';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Error(code); };

export function createEnrollmentManager({ host, descriptor, read, save, prepare }) {
  const savedName = publicKey => `enroll-${publicKey}.json`;
  const replacementName = (publicKey, record) => `enroll-replacement-${publicKey}-${digest(record)}.json`;
  const reviewName = reviewDigest => `enroll-review-${reviewDigest}.json`;
  const key = value => { if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail('ENROLLMENT_PUBLIC_KEY_INVALID'); return value; };
  async function authority() {
    const bundle = await host.peers.application();
    return { bundle, verified: await verifyAuthorityBundle(bundle, descriptor) };
  }
  async function committed(record, current) {
    const found = current.bundle.generations.find(value => value.payload.transition.payload.transitionId === record.request.payload.transitionId);
    if (found && await peerDigest(found.payload.transition) !== await peerDigest(record.request)) fail('ENROLLMENT_TRANSITION_ID_REUSED');
    return Boolean(found);
  }
  async function reviewRecord(publicKey, reviewDigest) {
    if (!/^[a-f0-9]{64}$/u.test(reviewDigest ?? '')) fail('ENROLLMENT_REVIEW_DIGEST_INVALID');
    const review = await read(reviewName(reviewDigest));
    if (digest(review) !== reviewDigest || review.publicKey !== publicKey ||
        review.applicationId !== descriptor.payload.applicationId || review.version !== 1) fail('ENROLLMENT_REVIEW_CHANGED');
    return review;
  }
  async function retained(publicKey) {
    let record = await read(savedName(publicKey), true);
    if (!record) return null;
    for (let count = 0; count < 32; count++) {
      const replacement = await read(replacementName(publicKey, record), true);
      if (!replacement) return record;
      const review = await reviewRecord(publicKey, replacement.reviewDigest);
      if (review.previousDigest !== digest(record)) fail('ENROLLMENT_REPLACEMENT_CHANGED');
      record = { request: review.request, control: review.control };
    }
    fail('ENROLLMENT_REPLACEMENT_LIMIT');
  }
  async function account() {
    const info = await host.info();
    if (typeof info.owner_account_id !== 'string' || !info.owner_account_id) fail('ENROLLMENT_OWNER_ACCOUNT_REQUIRED');
    return info.owner_account_id;
  }
  async function send(publicKey, record) {
    if (!await committed(record, await authority()) && boundOwner(publicKey, record) !== await account())
      fail('ENROLLMENT_OWNER_CHANGED');
    // Committed transitions replay their exact original request and cannot
    // restore prior authority. Uncommitted requests need the current owner.
    await host.peers.selectGeneration(record.request, { control: record.control });
    const current = await authority();
    if (!await committed(record, current)) fail('ENROLLMENT_TRANSITION_NOT_OBSERVED');
    const grant = current.verified.grant(publicKey);
    const active = grant?.reader === true && grant?.writer === true;
    return { enrolled: active ? publicKey : null, transitionCommitted: true,
      transitionId: record.request.payload.transitionId, currentGeneration: current.verified.current?.id ?? null,
      currentGrant: grant, next: active ? 'Run npm run peer, then connect this existing device.'
        : 'The original transition committed, but current rights differ. Inspect current grants; an old retry does not restore revoked rights.' };
  }
  function boundOwner(publicKey, record) {
    return record.control?.accounts?.find(grant => grant.publicKey === publicKey)?.accountId;
  }
  function obsolete(publicKey, record, current, ownerAccountId) {
    return record.request.payload.expectedGeneration !== (current.verified.current?.id ?? null) ||
      boundOwner(publicKey, record) !== ownerAccountId;
  }
  async function requireReplacement(publicKey, record, current, ownerAccountId) {
    if (!record) fail('ENROLLMENT_ORIGINAL_REQUEST_REQUIRED');
    if (await committed(record, current)) fail('ENROLLMENT_ALREADY_COMMITTED_RETRY_ORIGINAL');
    if (!obsolete(publicKey, record, current, ownerAccountId)) fail('ENROLLMENT_ORIGINAL_REQUEST_STILL_CURRENT');
    if (current.verified.grant(publicKey)) fail('ENROLLMENT_CURRENT_GRANT_REQUIRES_REVIEW');
  }
  const manager = {
    async enroll(value) {
      const publicKey = key(value), current = await authority();
      let record = await retained(publicKey);
      if (record) {
        if (await committed(record, current)) return send(publicKey, record);
        if (obsolete(publicKey, record, current, await account())) return { enrolled: null, reviewRequired: true,
          publicKey, originalTransitionId: record.request.payload.transitionId,
          expectedGeneration: record.request.payload.expectedGeneration, currentGeneration: current.verified.current?.id ?? null,
          next: `Review a replacement with npm run enroll:review -- ${publicKey}. No new transition was submitted.` };
      } else {
        if (current.verified.grant(publicKey)) fail('ENROLLMENT_CURRENT_GRANT_REQUIRES_REVIEW');
        record = await prepare({ publicKey, ownerAccountId: await account(), ...current });
        await save(savedName(publicKey), record);
      }
      return send(publicKey, record);
    },
    async review(value) {
      const publicKey = key(value), current = await authority(), previous = await retained(publicKey);
      const ownerAccountId = await account();
      await requireReplacement(publicKey, previous, current, ownerAccountId);
      const record = await prepare({ publicKey, ownerAccountId, ...current });
      const review = { version: 1, applicationId: descriptor.payload.applicationId, publicKey, ownerAccountId,
        previousDigest: digest(previous), previousTransitionId: previous.request.payload.transitionId,
        request: record.request, control: record.control };
      const reviewDigest = digest(review);
      await save(reviewName(reviewDigest), review);
      return { reviewRequired: true, reviewDigest, review,
        next: `Review every displayed grant, account and selected prefix. To approve this exact replacement: npm run enroll:approve -- ${publicKey} ${reviewDigest}` };
    },
    async approve(value, reviewDigest) {
      const publicKey = key(value), review = await reviewRecord(publicKey, reviewDigest);
      const previous = await retained(publicKey), replacement = { request: review.request, control: review.control };
      if (previous && digest(previous) === digest(replacement)) return manager.enroll(publicKey);
      const current = await authority();
      const ownerAccountId = await account();
      await requireReplacement(publicKey, previous, current, ownerAccountId);
      if (review.previousDigest !== digest(previous)) fail('ENROLLMENT_REVIEW_SUPERSEDED');
      if (review.ownerAccountId !== ownerAccountId) fail('ENROLLMENT_OWNER_CHANGED');
      if (obsolete(publicKey, replacement, current, ownerAccountId)) fail('ENROLLMENT_REVIEW_STALE');
      // The reviewed replacement link is durable before its first send. A
      // crash resumes this exact proposal; the superseded record is untouched.
      await save(replacementName(publicKey, previous), { reviewDigest });
      return send(publicKey, replacement);
    },
  };
  return manager;
}
