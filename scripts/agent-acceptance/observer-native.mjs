import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importReviewPackages } from '../review/packages.mjs';
import { at, need, same, MeasurementError, recordFile } from './observer-data.mjs';
import { hash } from './evidence.mjs';

/** Verify the published v1 signed-envelope wire format using the public canonical
 * codec. Applied execution remains the native session's responsibility. No private
 * key, epoch-key export, internal package import or invented SDK verifier is used.
 */
export async function verifySignedOperation(attempt, authority, sdk) {
  const domain = 'chronolog/peer-generation/attempt/v1', header = need(attempt?.payload?.header, 'attempt-header');
  same(header.profile, 'peer-generation-v1', 'attempt-profile');
  same(header.applicationId, authority.descriptor.applicationId, 'attempt-authority-application');
  same(header.definitionDigest, authority.descriptor.definitionDigest, 'attempt-definition');
  const generation = authority.generation(header.generation), control = authority.controlAt(generation.payload.controlRevision);
  same(header.controlRevision, control.payload.revision, 'attempt-control'); same(header.epoch, control.payload.epoch, 'attempt-epoch');
  same(authority.grant(header.author, header.controlRevision)?.writer, true, 'attempt-writer-grant');
  same(attempt.id, await sdk.peerDigest([domain, attempt.payload]), 'signed-attempt-digest');
  if (!/^[a-f0-9]{64}$/.test(header.author ?? '') || !/^[a-f0-9]{128}$/.test(attempt.signature ?? '')) throw new MeasurementError('attempt-signature-format', 'failed');
  const key = await crypto.subtle.importKey('raw', Buffer.from(header.author, 'hex'), 'Ed25519', false, ['verify']);
  const bytes = Buffer.concat([Buffer.from(domain + '\0'), sdk.encodePeerValue(attempt.payload)]);
  same(await crypto.subtle.verify('Ed25519', key, Buffer.from(attempt.signature, 'hex'), bytes), true, 'attempt-signature');
}

export async function sessionMeasurement(session, config, sdk, { operationId, author, command } = {}) {
  same(session.applicationId, config.applicationId, 'session-application');
  same(session.historyId, config.historyId, 'session-history');
  same(session.deviceId, config.native.deviceId, 'session-native-device');
  const authority = await sdk.verifyAuthorityBundle(await session.authority(), config.descriptor);
  const query = need(config.query, 'query-config');
  const snapshot = await session.query(need(query.name, 'query-name'), query.input ?? null);
  same(snapshot.revision?.applicationId, config.applicationId, 'query-application');
  same(snapshot.revision?.historyId, config.historyId, 'query-history');
  const rows = need(at(snapshot, query.rows ?? '/value'), 'query-rows');
  if (!Array.isArray(rows)) throw new MeasurementError('query-row-array', 'failed');
  const result = { applicationId: session.applicationId, historyId: session.historyId, deviceId: session.deviceId,
    storageId: session.storageId ?? null, revision: snapshot.revision, rows, status: session.status,
    participation: session.participation?.status ?? null, module: config.native.modulePath };
  if (operationId) {
    let inspection = await session.operations.inspect(operationId, author ? { author } : {}), inspectionSource = 'native-attachment';
    let inspectionEventSha256;
    // Terminal attachments deliberately cannot inspect another same-signer
    // adapter namespace. A real completed MCP inspection retains that adapter's
    // signed bytes; the coherent native event/read below still proves application.
    if (!inspection && config.native.mcpOperations?.[operationId]) {
      const record = recordFile(config.native.project, config.native.mcpOperations[operationId]);
      inspection = mcpOperationInspection(record.value, config, operationId, author);
      inspectionSource = 'recorded-selected-origin-mcp-inspection'; inspectionEventSha256 = record.sha256;
    }
    need(inspection, 'retained-operation');
    const attempt = inspection.attempt, state = inspection.state, header = need(attempt?.payload?.header, 'signed-attempt');
    same(header.applicationId, config.applicationId, 'attempt-application');
    same(header.author, need(author, 'expected-operation-author'), 'attempt-author');
    same(header.command, need(command, 'expected-command'), 'attempt-command');
    same(state.attemptId, attempt.id, 'operation-attempt-id');
    same(state.operationId, header.operationId, 'operation-signed-id');
    same(state.generation, header.generation, 'operation-generation');
    if (state.author !== undefined) same(state.author, header.author, 'applied-author');
    if (author !== session.deviceId || operationId.startsWith('native_') || inspectionSource !== 'native-attachment') same(header.operationId, operationId, 'requested-operation-id');
    await verifySignedOperation(attempt, authority, sdk);
    result.operation = { state, attempt, attemptHash: hash(sdk.encodePeerValue(attempt)), signatureVerified: true, inspectionSource, inspectionEventSha256,
      proofScope: 'Independent signed envelope, digest and historical grant; applied execution/read from the native session' };
    if (config.query.operationId === null) {
      const view = await session.readView(), events = [];
      try {
        // A concurrently changed view needs another measurement, not a merged read.
        if (JSON.stringify(view.revision) !== JSON.stringify(snapshot.revision)) throw new MeasurementError('coherent-query-event-view');
        let cursor;
        for (let page = 0; ; page++) {
          if (page >= 64) throw new MeasurementError('event-scan-bound');
          const batch = await view.readEvents({ limit: 128, ...(cursor ? { cursor } : {}), ...(config.query.eventTopic ? { topics: [config.query.eventTopic] } : {}) });
          events.push(...batch.events.filter(event => event.operationId === header.operationId && event.author === header.author));
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

export function mcpOperationInspection(event, config, operationId, author) {
  same(event?.type, 'mcpToolCall', 'inspection-event-type'); same(event.server, 'tendriller', 'inspection-mcp-server');
  same(event.tool, 'inspect_application_operation', 'inspection-mcp-tool');
  if (event.result?.isError) throw new MeasurementError('inspection-mcp-error', 'failed');
  same(event.arguments?.applicationId, config.applicationId, 'inspection-request-application');
  const blocks = event.result?.content?.filter(c => c.type === 'text');
  if (blocks?.length !== 1) throw new MeasurementError('inspection-mcp-content', 'failed');
  let body; try { body = JSON.parse(blocks[0].text); } catch { throw new MeasurementError('inspection-mcp-json', 'failed'); }
  same(body.operationId, event.arguments.operationId, 'inspection-client-operation');
  const reference = need(body.operationReference, 'inspection-operation-reference');
  for (const [key, value] of Object.entries({ applicationId: config.applicationId, historyId: config.historyId, deviceId: author, operationId }))
    same(reference[key], value, 'inspection-reference-' + key);
  const inspection = need(body.operation, 'inspection-signed-operation');
  same(inspection.attempt?.id, reference.attemptId, 'inspection-reference-attempt');
  same(inspection.state?.attemptId, reference.attemptId, 'inspection-state-attempt');
  return inspection;
}

/** The project's own installed tools package, resolved from the project like importReviewPackages. */
async function importWorkspaceTools(project) {
  const path = resolve(project, '.observer-imports-' + randomUUID() + '.mjs');
  writeFileSync(path, "export { openWorkspace, attachPage } from '@tendriller/tools/workspace';\n", { flag: 'wx', mode: 0o600 });
  try { return await import(pathToFileURL(path).href); }
  finally { rmSync(path, { force: true }); }
}

/** Attach only. The observer never opens a second signer or silently replaces a store. */
export async function probe(config, options) {
  const { session: sdk } = await importReviewPackages(config.native.project);
  const signal = AbortSignal.timeout(15000);
  let attached;
  if (config.native.modulePath) {
    const module = await import(pathToFileURL(config.native.modulePath).href);
    const hook = module[config.native.export ?? 'attachSession'];
    if (typeof hook !== 'function') throw new MeasurementError('native-attach-export');
    attached = await hook({ signal, profile: config.native.profile ?? 'main' });
  } else {
    const { openWorkspace, attachPage } = await importWorkspaceTools(config.native.project);
    attached = await attachPage(await openWorkspace({ root: config.native.project }), config.handle.id, { signal });
  }
  const session = need(attached?.session, 'attached-session');
  const detach = attached.detach?.bind(attached) ?? session.detach?.bind(session);
  if (!detach) throw new MeasurementError('native-detach-method');
  try {
    // Resolve/pin identities before any optional command or retry.
    await sessionMeasurement(session, config, sdk);
    let operationId = options.operationId, author = options.author, waiterInterrupted = false;
    if (options.action === 'submit' || options.action === 'submit-lost') {
      const query = await session.query(config.query.name, config.query.input ?? null);
      const operation = await session.command(options.command, options.input, { operationId, basedOn: query.revision });
      const saved = need(await operation.get(), 'saved-operation');
      if (options.action === 'submit-lost') {
        const interrupted = new AbortController(); interrupted.abort(Error('Acceptance observer discarded this applied waiter'));
        try { await operation.applied({ signal: interrupted.signal }); }
        catch { waiterInterrupted = true; }
        if (!waiterInterrupted) throw new MeasurementError('applied-response-not-lost');
      } else await operation.applied({ signal });
      // Attachments may namespace local IDs. Keep both, and inspect using the local alias.
      author = session.deviceId;
      const result = await sessionMeasurement(session, config, sdk, { ...options, operationId, author });
      same(saved.attemptId, result.operation.state.attemptId, 'saved-attempt-changed');
      return { ...result, clientOperationId: operationId, waiterInterrupted };
    }
    if (options.action === 'retry') {
      const before = await sessionMeasurement(session, config, sdk, { ...options, operationId, author });
      same(before.operation.attemptHash, options.expectedAttemptHash, 'retry-attempt-changed');
      await session.retry(operationId);
      await session.operations.wait(operationId, { signal });
    }
    return await sessionMeasurement(session, config, sdk, { ...options, operationId, author });
  } finally { await detach(); }
}

export function nativeMeasurement(config, options = {}) {
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
      const invalid = /^PEER_.*(INVALID|MISMATCH|FORBIDDEN)$/u.test(error.code ?? '');
      process.send({ ok: false, metric, status: error instanceof MeasurementError ? error.status : invalid ? 'failed' : 'blocked' }, () => process.exit(0));
    }
  });
}
