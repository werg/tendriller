import { signTransitionRequest, verifyAuthorityBundle } from '@chronolog/peer-session';
import { createDevicePairingClient, validateDevicePairingChallenge } from '@tendriller/core/pairing';

// Use the already fenced native owner. This helper never opens another signing
// store and only consumes exact device proofs that the owner explicitly reviewed.
export function createReviewedPairingProcessor({ handle, host, descriptor, session, identity, store, client }) {
  let running;
  async function process(signal) {
    const transport = client ?? createDevicePairingClient({ url: handle.api + '/peers/pairing', headers: { Authorization: 'Bearer ' + handle.token } });
    const { pairings } = await transport.pending({ signal });
    if (!Array.isArray(pairings) || pairings.length > 1024) throw Error('Invalid bounded pairing queue.');
    const results = [];
    for (const status of pairings) {
      signal?.throwIfAborted();
      const c = validateDevicePairingChallenge(status.challenge);
      if (c.pairingId !== status.pairingId ||
        c.serviceOrigin !== new URL(handle.api).origin || c.pageOrigin !== new URL(handle.page_url).origin ||
        c.applicationId !== handle.application.id) throw Error('The reviewed pairing belongs to another application.');
      if (!['approved', 'committing'].includes(status.state)) {
        results.push({ pairingId: c.pairingId, state: status.state, publicKey: c.publicKey });
        continue;
      }
      const name = `pairing-${c.pairingId}.json`;
      let prepared = await store.load(name);
      if (!prepared) {
        if (status.state === 'committing') throw Error('The host retained a signed pairing but the local intent is missing. Restore the original private checkpoint before retrying.');
        if (Date.now() >= c.expiresAt) continue;
        const verified = await verifyAuthorityBundle(await host.peers.application(), descriptor);
        if (verified.current?.id !== c.expectedGeneration || verified.control.payload.revision !== c.controlRevision) continue;
        if (verified.current.payload.coordinator !== identity.publicKey || !verified.grant(identity.publicKey)?.administrator)
          throw Error('The running native owner is not the current pairing coordinator and administrator.');
        if (verified.grant(c.publicKey)) throw Error('The reviewed key already has a grant. Inspect its current rights without restoring or replacing them.');
        const current = verified.control.payload;
        const control = { epoch: current.epoch, keyDigest: current.keyDigest, recoveryFloor: current.recoveryFloor,
          grants: [...current.grants, { publicKey: c.publicKey, reader: true, writer: c.rights.writer,
            coordinator: false, recovery: false, administrator: false, publisher: false, dataRole: 'member' }],
          accounts: [{ publicKey: c.publicKey, accountId: c.accountId }] };
        const request = await signTransitionRequest({ applicationId: c.applicationId,
          profile: descriptor.payload.profile, policy: descriptor.payload.policy, transitionId: `pair-${c.pairingId}`,
          expectedGeneration: c.expectedGeneration, coordinator: identity.publicKey, requester: identity.publicKey,
          controlRevision: c.controlRevision + 1, reason: 'control-change', base: await session.recoveryPoint() }, identity);
        prepared = { request, control };
        await store.save(name, prepared);
        if (JSON.stringify(await store.load(name)) !== JSON.stringify(prepared)) throw Error('The signed pairing was not durably retained. No transition was sent.');
      }
      if (prepared.request?.payload.transitionId !== `pair-${c.pairingId}` ||
        prepared.request.payload.applicationId !== c.applicationId || prepared.request.payload.expectedGeneration !== c.expectedGeneration)
        throw Error('The saved signed pairing does not match this exact review.');
      const result = await transport.commit(c.pairingId, prepared, { signal });
      if (result.pairingId !== c.pairingId) throw Error('Pairing commit returned another request identity.');
      results.push({ pairingId: c.pairingId, state: result.state, publicKey: c.publicKey });
    }
    return results;
  }
  return options => {
    if (running) return running;
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...[options?.signal].filter(Boolean)]);
    running = process(signal).finally(() => { running = undefined; });
    return running;
  };
}

export function startReviewedPairingLoop(process, { signal, report = () => {}, intervalMs = 2000, maxIdleMs = 30_000 } = {}) {
  const stopped = new AbortController(), lifetime = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
  let delayMs = intervalMs;
  const completion = (async () => {
    while (!lifetime.aborted) {
      try {
        const results = await process({ signal: lifetime });
        for (const result of results) report({ pairing: result });
        delayMs = results.some(result => ['approved', 'committing', 'committed'].includes(result.state))
          ? intervalMs : Math.min(maxIdleMs, delayMs * 2);
      } catch (error) {
        delayMs = Math.min(maxIdleMs, delayMs * 2);
        if (!lifetime.aborted) report({ pairing: { state: 'inspection_unavailable', code: error.code || error.name } });
      }
      if (lifetime.aborted) break;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); lifetime.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delayMs);
        lifetime.addEventListener('abort', finish, { once: true });
        if (lifetime.aborted) finish();
      });
    }
  })();
  return { async close() { stopped.abort(); await completion; } };
}
