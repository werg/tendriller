import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { importReviewPackages } from '../review/packages.mjs';
import { at, need, same, MeasurementError } from './observer-data.mjs';
import { hash } from './evidence.mjs';

export function requireAuthoredProofSDK(sdk) {
  if (['verifyAuthorityBundle', 'verifyRecord', 'writerAuthorizedAt', 'recordDigest', 'encodeRecord', 'decodeRecord'].some(name => typeof sdk?.[name] !== 'function'))
    throw new MeasurementError('authored-public-proof-sdk-unavailable');
}

/** Verify and index public authority records without opening a device/store or keys.
 * verifyAuthorityBundle returns void; it does not return an AuthorityProvider. */
export async function verifiedAuthority(bundle, descriptor, sdk) {
  requireAuthoredProofSDK(sdk);
  // Canonical public record transport preserves bigint policy activation floors.
  // A decoded signed descriptor is also a current public value, not an old profile.
  const pinned = descriptor?.record === undefined ? descriptor : sdk.decodeRecord(sdk.hexToBytes(descriptor.record));
  await sdk.verifyAuthorityBundle(bundle, pinned);
  const entries = await Promise.all(bundle.memberships.map(async signed => [await sdk.recordDigest(signed), signed.payload]));
  const memberships = new Map(entries), current = entries.at(-1);
  return { descriptor: bundle.descriptor.payload, currentMembershipId: current[0], currentMembership: current[1],
    bundle: () => bundle, membership: id => memberships.get(id) ?? null,
    grant: (author, id = current[0]) => memberships.get(id)?.members.find(member => member.publicKey === author) ?? null };
}

/** Public signed encrypted envelope proof, not a decrypted core/command proof.
 * The stable proposal digest is signed by the author. No provider label is proof. */
export async function verifySignedOperation(envelope, authority, sdk) {
  const value = need(envelope?.payload, 'operation-envelope');
  same(value.applicationId, authority.descriptor.applicationId, 'operation-authority-application');
  same(value.executionManifestDigest, authority.descriptor.executionManifestDigest, 'operation-execution-manifest');
  if (!/^[a-f0-9]{64}$/.test(value.proposalId ?? '') || typeof value.authorTimestampMs !== 'bigint' ||
      value.authorTimestampMs < 0n || value.authorTimestampMs > (1n << 63n) - 1n) throw new MeasurementError('operation-envelope-scope', 'failed');
  await sdk.verifyRecord('operation-envelope', envelope, value.author);
  same(sdk.writerAuthorizedAt(authority, value.author, value.membershipId, value.authorTimestampMs), true, 'operation-historical-writer');
  const membership = need(authority.membership(value.membershipId), 'operation-membership');
  same(authority.grant(value.author, value.membershipId)?.writer, true, 'operation-writer-grant');
  if (typeof value.encrypted?.epoch !== 'bigint' || value.encrypted.epoch < 0n || value.encrypted.epoch > BigInt(Number.MAX_SAFE_INTEGER) ||
      !authority.bundle().memberships.some(item => item.payload.epoch === Number(value.encrypted.epoch)) ||
      value.authorTimestampMs <= membership.authorTimeAfterMs) throw new MeasurementError('operation-epoch-or-time', 'failed');
}

async function authorityBundle(session) {
  if (typeof session.readAuthority === 'function') return session.readAuthority();
  // ApplicationSession exposes authority; some application wrappers name it authorityProvider.
  const provider = session.authorityProvider ?? session.authority;
  if (typeof provider?.bundle !== 'function') throw new MeasurementError('public-authority-evidence-unsupported');
  return provider.bundle();
}

export async function sessionMeasurement(session, config, sdk, { operationId, author, expectedProofHash } = {}) {
  same(session.applicationId, config.applicationId, 'session-application');
  const deviceId = need(session.identity?.publicKey, 'session-public-key');
  same(deviceId, config.native.deviceId, 'session-native-device');
  const authority = await verifiedAuthority(await authorityBundle(session), need(config.descriptor, 'pinned-data-descriptor'), sdk);
  const query = need(config.query, 'query-config');
  const snapshot = await session.query(need(query.name, 'query-name'), query.input ?? null);
  same(snapshot.applicationId, config.applicationId, 'query-application');
  need(snapshot.revision?.digest, 'query-materialized-revision');
  const rows = need(at(snapshot, query.rows ?? '/value'), 'query-rows');
  if (!Array.isArray(rows)) throw new MeasurementError('query-row-array', 'failed');
  const result = { applicationId: session.applicationId, deviceId, revision: snapshot.revision, rows,
    status: session.status, module: config.native.modulePath };
  if (operationId) {
    const handle = need(await session.operations.get(operationId), 'stored-operation-handle');
    const state = await handle.inspect();
    same(state.applicationId, config.applicationId, 'operation-application');
    same(state.author, need(author, 'expected-operation-author'), 'operation-author');
    same(state.proposalId, handle.id, 'operation-proposal-id');
    if (operationId !== state.proposalId) same(state.operationId, operationId, 'requested-operation-id');
    // The current owner facade does NOT expose raw signed facts. Do not invent an
    // inspect response, use private source imports, or open a second signer to get them.
    if (typeof session.exportFacts !== 'function') throw new MeasurementError('signed-operation-evidence-unsupported');
    const facts = await session.exportFacts();
    const matches = facts.envelopes.filter(item => item.payload.proposalId === state.proposalId && item.payload.author === state.author &&
      item.payload.authorTimestampMs.toString() === state.authorTimestampMs);
    // Rewrapping cannot mint a proposal. Select an actual retained witness, and
    // after an uncertain reply require the original witness bytes, not a new wrap.
    const envelope = need(matches.find(item => !expectedProofHash || hash(sdk.encodeRecord(item)) === expectedProofHash), 'original-signed-operation-envelope');
    await verifySignedOperation(envelope, authority, sdk);
    same(envelope.payload.author, state.author, 'signed-operation-author');
    same(envelope.payload.authorTimestampMs.toString(), state.authorTimestampMs, 'signed-operation-time');
    for (const evidence of state.retained) {
      await sdk.verifyRecord('retention', evidence, evidence.payload.peer);
      same(evidence.payload.applicationId, config.applicationId, 'retention-application');
      same(evidence.payload.proposalId, state.proposalId, 'retention-proposal');
      same(evidence.payload.author, state.author, 'retention-author');
      const subjects = await Promise.all(facts.envelopes.map(async subject => ({ subject, digest: await sdk.recordDigest(subject) })));
      const subject = need(subjects.find(item => item.digest === evidence.payload.envelopeDigest)?.subject, 'retention-signed-envelope-subject');
      same(subject.payload.proposalId, state.proposalId, 'retention-envelope-proposal');
      same(subject.payload.author, state.author, 'retention-envelope-author');
      await verifySignedOperation(subject, authority, sdk);
      if (evidence.payload.peer === deviceId || typeof evidence.payload.storageId !== 'string' || !evidence.payload.storageId || evidence.payload.storageId.length > 128)
        throw new MeasurementError('retention-independent-peer', 'failed');
      need(authority.grant(evidence.payload.peer), 'retention-member-grant');
    }
    const bytes = sdk.encodeRecord(envelope);
    result.operation = { state, envelope: { record: Buffer.from(bytes).toString('hex') }, proofHash: hash(bytes), signatureVerified: true,
      inspectionSource: 'authorized-public-exportFacts',
      proofScope: 'Signed encrypted envelope, proposal reference and historical writer authorization; operation ID, command execution and revisable outcome are local session observations, not independent decrypted-core verification' };
    if (config.query.operationId === null) {
      const view = await session.readView(), events = [];
      try {
        same(view.applicationId, config.applicationId, 'event-view-application');
        if (JSON.stringify(view.revision) !== JSON.stringify(snapshot.revision)) throw new MeasurementError('coherent-query-event-view');
        let cursor;
        for (let page = 0; ; page++) {
          if (page >= 64) throw new MeasurementError('event-scan-bound');
          const batch = await view.readEvents({ limit: 128, ...(cursor ? { cursor } : {}), ...(config.query.eventTopic ? { topics: [config.query.eventTopic] } : {}) });
          if (JSON.stringify(batch.revision) !== JSON.stringify(view.revision)) throw new MeasurementError('coherent-event-batch', 'failed');
          events.push(...batch.events.filter(event => event.proposalId === state.proposalId && event.operationId === state.operationId && event.author === state.author));
          if (!batch.hasMore) break;
          if (!batch.cursor || batch.cursor === cursor) throw new MeasurementError('event-cursor-stalled', 'failed');
          cursor = batch.cursor;
        }
      } finally { await view.release(); }
      result.events = events;
    }
  }
  return result;
}

/** Attach only. Never open another signer/store. A facade lacking raw signed
 * proof is an evidence boundary, not an application Save/network failure. */
export async function probe(config, options, { packages = importReviewPackages, loadModule = url => import(url) } = {}) {
  if (!config.native) throw new MeasurementError('optional-native-observer-not-configured');
  const { session: sdk } = await packages(config.native.project);
  const module = await loadModule(pathToFileURL(config.native.modulePath).href);
  const hook = module[config.native.export ?? 'attachSession'];
  if (typeof hook !== 'function') throw new MeasurementError('native-attach-export');
  const signal = AbortSignal.timeout(15000);
  const attached = await hook({ signal, profile: config.native.profile ?? 'main' });
  const session = need(attached?.session, 'attached-session');
  const detach = attached.detach?.bind(attached) ?? session.detach?.bind(session);
  if (!detach) throw new MeasurementError('native-detach-method');
  try {
    await sessionMeasurement(session, config, sdk);
    let operationId = options.operationId, author = options.author, waiterInterrupted = false;
    if (options.action === 'submit' || options.action === 'submit-lost') {
      // Check proof capability before deliberately authoring a test operation.
      if (typeof session.exportFacts !== 'function') throw new MeasurementError('signed-operation-evidence-unsupported');
      const operation = await session.command(options.command, options.input, { operationId });
      const saved = await operation.inspect();
      same(saved.stored, true, 'submission-not-stored');
      if (options.action === 'submit-lost') {
        const interrupted = new AbortController(); interrupted.abort(Error('Acceptance observer discarded this materialization waiter'));
        try { await operation.materialized({ signal: interrupted.signal }); } catch { waiterInterrupted = true; }
        if (!waiterInterrupted) throw new MeasurementError('materialized-response-not-lost');
      } else await operation.materialized({ signal });
      author = session.identity.publicKey;
      const result = await sessionMeasurement(session, config, sdk, { ...options, operationId, author });
      same(saved.proposalId, result.operation.state.proposalId, 'saved-proposal-changed');
      return { ...result, clientOperationId: operationId, waiterInterrupted };
    }
    if (options.action === 'retry') {
      const before = await sessionMeasurement(session, config, sdk, { ...options, operationId, author });
      same(before.operation.proofHash, options.expectedProofHash, 'retry-envelope-changed');
      same(before.operation.state.proposalId, options.expectedProposalId, 'retry-proposal-changed');
      const operation = await session.operations.retry(before.operation.state.proposalId);
      same(operation.id, before.operation.state.proposalId, 'retry-handle-changed');
      await operation.materialized({ signal });
    }
    return await sessionMeasurement(session, config, sdk, { ...options, operationId, author });
  } finally { await detach(); }
}

export function nativeMeasurement(config, options = {}) {
  if (!config.native) return Promise.reject(new MeasurementError('optional-native-observer-not-configured'));
  return new Promise((resolveResult, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [], { cwd: config.native.project, execArgv: [], detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true' } });
    let response;
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 22000);
    child.on('message', value => { response = value; });
    child.once('error', () => { clearTimeout(timer); reject(new MeasurementError('native-probe-launch')); });
    child.once('exit', () => {
      clearTimeout(timer);
      if (response?.ok) resolveResult(response.value);
      else reject(new MeasurementError(response?.metric ?? 'native-probe-timeout-or-exit', response?.status ?? 'blocked'));
    });
    child.send({ config, options });
  });
}

if (process.send && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('message', async ({ config, options }) => {
    try { process.send({ ok: true, value: { ...await probe(config, options),
      observerImplementationSha256: hash(readFileSync(fileURLToPath(import.meta.url))) } }, () => process.exit(0)); }
    catch (error) {
      const metric = error instanceof MeasurementError ? error.metric : /^[A-Z_]{1,100}$/.test(error.code ?? '') ? error.code : 'native-probe-unavailable';
      const invalid = /^(?:AUTHORITY|OPERATION|PUBLICATION)_.*(?:INVALID|MISMATCH|FORBIDDEN)$/u.test(error.code ?? '');
      process.send({ ok: false, metric, status: error instanceof MeasurementError ? error.status : invalid ? 'failed' : 'blocked' }, () => process.exit(0));
    }
  });
}
