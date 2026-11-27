import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importReviewPackages } from '../review/packages.mjs';
import { at, need, same, MeasurementError } from './observer-data.mjs';
import { hash } from './evidence.mjs';

export function requireAuthoredProofSDK(sdk) {
  if (['decodeLogGenesis', 'genesisLogId', 'decodeEncryptedEnvelope', 'encryptedEnvelopeDigest',
    'decodeSignedOperation', 'verifySignedOperation', 'verifyRecord', 'recordDigest', 'encodeRecord', 'decodeRecord',
    'bytesToHex', 'hexToBytes'].some(name => typeof sdk?.[name] !== 'function')) {
    throw new MeasurementError('authored-public-proof-sdk-unavailable');
  }
}

function toBytes(value, sdk) {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === 'object' && typeof value.record === 'string') return sdk.hexToBytes(value.record);
  throw new MeasurementError('genesis-record-format', 'failed');
}

/** Verify a Chronolog v2 LogGenesis without opening a device/store or holding keys. */
export async function verifiedAuthority(genesisRecord, pinned, sdk, permissionsOverride = null) {
  requireAuthoredProofSDK(sdk);
  const raw = toBytes(genesisRecord, sdk);
  const genesis = sdk.decodeLogGenesis(raw);
  const logId = sdk.bytesToHex(sdk.genesisLogId(raw));
  if (pinned !== undefined && pinned !== null) {
    const pinnedBytes = toBytes(pinned, sdk);
    const pinnedChainId = sdk.bytesToHex(sdk.genesisLogId(pinnedBytes));
    same(logId, pinnedChainId, 'pinned-genesis-mismatch');
  }
  const permissions = permissionsOverride ?? genesis.initialTopics.$permissions ?? { members: [] };
  const finality = genesis.initialTopics.$finality ?? { schedule: [{ effectiveAfterMs: -1, policy: { kind: 'none' } }] };
  return {
    logId,
    applicationId: logId,
    genesis,
    genesisBytes: raw,
    permissions,
    finality,
    grant: author => (permissions.members ?? []).find(member => member.publicKey === author) ?? null,
  };
}

/**
 * Verify a Chronolog v2 signed encrypted outer envelope against verified genesis/permissions.
 * Does not decrypt the inner core; binds logId, opId, author, epoch, and writer grant.
 */
export async function verifySignedOperation(rawEnvelope, authority, sdk) {
  const raw = toBytes(rawEnvelope, sdk);
  const env = sdk.decodeEncryptedEnvelope(raw);
  same(env.version, 1, 'operation-envelope-version');
  same(sdk.bytesToHex(env.logId), authority.logId, 'operation-authority-application');
  const opId = sdk.bytesToHex(env.opId);
  const author = sdk.bytesToHex(env.author);
  if (!/^[a-f0-9]{64}$/.test(opId) || !/^[a-f0-9]{64}$/.test(author) || !Number.isSafeInteger(env.epoch) || env.epoch < 0) {
    throw new MeasurementError('operation-envelope-scope', 'failed');
  }
  const grant = authority.grant(author);
  same(grant?.writer, true, 'operation-writer-grant');
  const digest = sdk.bytesToHex(sdk.encryptedEnvelopeDigest(raw));
  return { opId, author, epoch: env.epoch, digest, raw };
}

async function sessionGenesisBytes(session) {
  if (session.genesisBytes instanceof Uint8Array) return session.genesisBytes;
  if (typeof session.readGenesis === 'function') return session.readGenesis();
  throw new MeasurementError('public-authority-evidence-unsupported');
}

export async function sessionMeasurement(session, config, sdk, { operationId, author, expectedProofHash } = {}) {
  same(session.applicationId, config.applicationId, 'session-application');
  const deviceId = need(session.identity?.publicKey, 'session-public-key');
  same(deviceId, config.native.deviceId, 'session-native-device');
  const perms = typeof session.permissions === 'function' ? session.permissions() : null;
  const authority = await verifiedAuthority(await sessionGenesisBytes(session), need(config.descriptor, 'pinned-data-descriptor'), sdk, perms);
  const query = need(config.query, 'query-config');
  const snapshot = await session.query(need(query.name, 'query-name'), query.input ?? null);
  same(snapshot.applicationId, config.applicationId, 'query-application');
  need(snapshot.revision?.digest, 'query-materialized-revision');
  const rows = need(at(snapshot, query.rows ?? '/value'), 'query-rows');
  if (!Array.isArray(rows)) throw new MeasurementError('query-row-array', 'failed');
  const result = {
    applicationId: session.applicationId,
    deviceId,
    revision: snapshot.revision,
    rows,
    status: session.status,
    module: config.native.modulePath,
  };
  if (operationId) {
    const handle = need(await session.operations.get(operationId), 'stored-operation-handle');
    const state = await handle.inspect();
    same(state.applicationId, config.applicationId, 'operation-application');
    same(state.author, need(author, 'expected-operation-author'), 'operation-author');
    same(state.proposalId, handle.id, 'operation-proposal-id');
    if (operationId !== state.proposalId) same(state.operationId, operationId, 'requested-operation-id');
    if (typeof session.exportFacts !== 'function') throw new MeasurementError('signed-operation-evidence-unsupported');
    const facts = await session.exportFacts();
    const envelopes = facts.encryptedEnvelopes ?? [];
    const parsed = [];
    for (const raw of envelopes) {
      try {
        const bytes = toBytes(raw, sdk);
        const env = sdk.decodeEncryptedEnvelope(bytes);
        if (sdk.bytesToHex(env.opId) === state.proposalId && sdk.bytesToHex(env.author) === state.author) {
          parsed.push({ bytes, digest: sdk.bytesToHex(sdk.encryptedEnvelopeDigest(bytes)) });
        }
      } catch {}
    }
    const chosen = need(
      parsed.find(item => !expectedProofHash || hash(item.bytes) === expectedProofHash),
      'original-signed-operation-envelope',
    );
    await verifySignedOperation(chosen.bytes, authority, sdk);
    for (const evidence of state.retained) {
      await sdk.verifyRecord('operation-retention', evidence, evidence.payload.peer);
      same(evidence.payload.applicationId, config.applicationId, 'retention-application');
      same(evidence.payload.proposalId, state.proposalId, 'retention-proposal');
      same(evidence.payload.author, state.author, 'retention-author');
      const subject = need(parsed.find(item => item.digest === evidence.payload.envelopeDigest), 'retention-signed-envelope-subject');
      await verifySignedOperation(subject.bytes, authority, sdk);
      if (evidence.payload.peer === deviceId || typeof evidence.payload.storageId !== 'string' || !evidence.payload.storageId || evidence.payload.storageId.length > 128) {
        throw new MeasurementError('retention-independent-peer', 'failed');
      }
      need(authority.grant(evidence.payload.peer), 'retention-member-grant');
    }
    result.operation = {
      state,
      envelope: { record: Buffer.from(chosen.bytes).toString('hex') },
      proofHash: hash(chosen.bytes),
      signatureVerified: true,
      inspectionSource: 'authorized-public-exportFacts',
      proofScope: 'Encrypted v2 operation envelope, proposal digest and writer grant; operation ID, reducer execution and revisable outcome are local session observations, not independent decrypted-core verification',
    };
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

async function importWorkspaceTools(project) {
  const path = resolve(project, '.observer-imports-' + randomUUID() + '.mjs');
  writeFileSync(path, "export { openWorkspace, attachPage } from '@tendriller/tools/workspace';\n", { flag: 'wx', mode: 0o600 });
  try { return await import(pathToFileURL(path).href); }
  finally { rmSync(path, { force: true }); }
}

/** Attach only. Never open another signer/store. */
export async function probe(config, options, { packages = importReviewPackages, workspaceTools = importWorkspaceTools } = {}) {
  if (!config.native) throw new MeasurementError('optional-native-observer-not-configured');
  const { session: sdk } = await packages(config.native.project);
  const { openWorkspace, attachPage } = await workspaceTools(config.native.project);
  const signal = AbortSignal.timeout(15000);
  const attached = await attachPage(await openWorkspace({ root: config.native.project }), config.handle.id, { signal });
  const session = need(attached?.session, 'attached-session');
  const detach = attached.detach?.bind(attached) ?? session.detach?.bind(session);
  if (!detach) throw new MeasurementError('native-detach-method');
  try {
    await sessionMeasurement(session, config, sdk);
    let operationId = options.operationId, author = options.author, waiterInterrupted = false;
    if (options.action === 'submit' || options.action === 'submit-lost') {
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
