import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { importReviewPackages } from '../review/packages.mjs';
import { nativeMeasurement } from './observer-native.mjs';
import { MeasurementError, need, same, at, loadObserverConfig, recordFile, processMeasurement, publicationAddress, relayTransportMeasurement } from './observer-data.mjs';
import { hash, now, checks } from './evidence.mjs';
import { mcpDiscovery, domainDiscovery } from './discovery.mjs';

function token(text, value) {
  return text.split(/[^A-Za-z0-9_.:-]+/u).includes(value);
}
function browserRows(browser, marker, identity) {
  return browser.rows.filter((text, index) => text.includes(marker) && (token(text, identity) || browser.rowIds?.[index] === identity));
}
function operationRows(native, config, operationId, author, marker) {
  const q = config.query;
  let rows;
  if (q.operationId === null) {
    const events = need(native.events, 'coherent-command-events');
    same(events.length, 1, 'operation-event-count');
    same(events[0].attemptId, native.operation.attempt.id, 'event-signed-attempt');
    same(events[0].operationId, operationId, 'event-operation'); same(events[0].author, author, 'event-author');
    const id = q.eventIdEncoding === 'author-operation-json' ? JSON.stringify([events[0].author, events[0].operationId])
      : q.eventIdEncoding === 'author-operation-colon' ? `${events[0].author}:${events[0].operationId}`
      : need(at(events[0], need(q.eventId, 'event-row-key')), 'event-row-id');
    rows = native.rows.filter(row => at(row, need(q.rowId, 'query-row-key')) === id);
  } else rows = native.rows.filter(row => at(row, q.operationId ?? '/operationId') === operationId && at(row, q.author ?? '/author') === author);
  same(rows.length, 1, 'operation-application-count');
  same(at(rows[0], q.marker ?? '/text'), marker, 'native-marker');
  return rows;
}
function accepted(snapshot) {
  const op = need(snapshot.operation, 'native-operation-proof');
  same(op.state.status, 'applied', 'command-applied'); same(op.state.outcome, 'accepted', 'command-accepted');
  same(op.signatureVerified, true, 'command-signature'); return op;
}
async function field(page, spec, metric) {
  need(spec?.selector, metric);
  const node = page.locator(spec.selector);
  if (await node.count() !== 1) throw new MeasurementError(metric);
  return spec.read === 'value' ? node.inputValue() : spec.read === 'attribute'
    ? node.getAttribute(need(spec.attribute, metric + '-attribute')) : node.innerText();
}
export async function browserIdentity(owner, config) {
  const page = need(owner?.page, 'owner-browser');
  const address = publicationAddress(page.url(), config.handle.page_url);
  const runtime = await page.evaluate(() => {
    const i = window.tendril?.identity;
    return i ? { page: i.page, publication: i.publication, version: i.version, documentPath: i.documentPath } : null;
  });
  need(runtime, 'browser-runtime-identity');
  same(runtime.page, config.handle.id, 'browser-runtime-page');
  if (address.version !== null) {
    same(address.version, runtime.version, 'browser-url-runtime-version');
    same(address.documentPath, runtime.documentPath, 'browser-url-runtime-document');
  }
  return { runtime, address, url: page.url(), at: now(), actionIndex: owner.actions?.length ?? 0 };
}
export function verifyBrowserPublication(browser, receipt) {
  same(browser.runtime.version, receipt.version, 'browser-selected-version');
  // Runtime publication IDs are host version strings, not Chronolog digests.
  same(browser.runtime.publication, String(receipt.version), 'browser-publication-version-id');
  const path = need(browser.runtime.documentPath, 'browser-document-path');
  if (!receipt.publication.payload.files.some(file => file.path === path && file.type === 'text/html')) throw new MeasurementError('browser-unsigned-document', 'failed');
}
export async function verifyPublicationLineage(current, claimed, receipts, sdk, authority) {
  const byId = new Map(receipts.map(receipt => [receipt.publication.id, receipt]));
  byId.set(claimed.publication.id, claimed);
  const lineage = [], seen = new Set();
  for (let receipt = current; lineage.length < 256;) {
    const publication = receipt.publication;
    if (seen.has(publication.id)) throw new MeasurementError('publication-parent-cycle', 'failed');
    seen.add(publication.id);
    await sdk.verifyPublicationManifest(publication, authority);
    lineage.push({ publicationId: publication.id, version: receipt.version, revision: publication.payload.revision });
    if (publication.id === claimed.publication.id) return lineage;
    if (publication.payload.previous === null) throw new MeasurementError('publication-not-descendant-of-claim', 'failed');
    const previous = need(byId.get(publication.payload.previous), 'publication-parent-receipt-unobserved');
    same(publication.payload.revision, previous.publication.payload.revision + 1, 'publication-cas-revision');
    same(receipt.version, previous.version + 1, 'publication-host-version-lineage');
    receipt = previous;
  }
  throw new MeasurementError('publication-lineage-bound');
}
export async function browserMeasurement(owner, config) {
  const identity = await browserIdentity(owner, config), page = owner.page;
  const spec = need(config.browser, 'browser-selectors');
  const deviceId = need(await field(page, spec.device, 'browser-device-selector'), 'browser-device-id');
  if (!/^[a-f0-9]{64}$/.test(deviceId)) throw new MeasurementError('browser-device-format', 'failed');
  const rows = await page.locator(need(spec.rows, 'browser-rows-selector')).allInnerTexts();
  const rowIds = spec.rowIdentityAttribute ? await page.locator(spec.rows).evaluateAll((nodes, { attribute, selector }) =>
    nodes.map(node => (selector ? node.querySelector(selector) : node)?.getAttribute(attribute) ?? null),
  { attribute: spec.rowIdentityAttribute, selector: spec.rowIdentitySelector ?? null }) : null;
  return { ...identity, deviceId, rows,
    rowIds, status: spec.status ? await field(page, spec.status, 'browser-status-selector') : null };
}

/** Maintained evaluator; configuration describes existing app outputs, never new app code. */
export class StarterObserver {
  constructor({ configPath, runDirectory, project, origin, owner, native = nativeMeasurement, packages = importReviewPackages }) {
    Object.assign(this, { configPath, runDirectory, project, origin, owner, native, packages });
    this.directory = join(runDirectory, 'observer'); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.statePath = join(this.directory, 'state.json');
    this.state = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : { checkpoints: {} };
  }
  save() {
    const path = this.statePath + '.' + randomUUID();
    writeFileSync(path, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' }); renameSync(path, this.statePath);
  }
  checkpoint(name, value) {
    if (this.state.checkpoints[name]) throw new MeasurementError('checkpoint-already-exists', 'failed');
    this.state.checkpoints[name] = { ...structuredClone(value), observedAt: now() }; this.save(); return this.state.checkpoints[name];
  }
  config() {
    const config = loadObserverConfig(this.configPath, this);
    const binding = { origin: config.origin, applicationId: config.applicationId, historyId: config.historyId,
      deviceId: config.native.deviceId, pageId: config.handle.id, pageUrl: config.handle.page_url,
      descriptor: hash(JSON.stringify(config.descriptor)), project: config.native.project };
    if (this.state.binding) same(JSON.stringify(binding), JSON.stringify(this.state.binding), 'observer-identity-changed');
    else { this.state.binding = binding; this.save(); }
    return config;
  }
  async host(config) {
    const { core, session: sdk } = await this.packages(config.native.project);
    const host = core.createAgentClient({ service: config.origin, token: config.handle.token },
      { fetch: (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) }) })
      .page(config.handle.id, { applicationId: config.applicationId });
    const bundle = await host.peers.application();
    const authority = await sdk.verifyAuthorityBundle(bundle, config.descriptor);
    same(authority.descriptor.applicationId, config.applicationId, 'authority-application');
    same(authority.descriptor.historyId, config.historyId, 'authority-history');
    const info = await host.info();
    same(info.id, config.handle.id, 'host-page-id');
    same(info.application?.id, config.applicationId, 'host-application-id');
    same(info.page_url, config.handle.page_url, 'host-authoritative-page-url');
    return { host, sdk, authority, info };
  }
  async publication(config, { host, sdk, authority }) {
    const receipt = need(await host.peers.publication(), 'selected-publication');
    await sdk.verifyPublicationManifest(receipt.publication, authority);
    same(receipt.publication.payload.applicationId, config.applicationId, 'publication-application');
    same(receipt.publication.payload.historyId, config.historyId, 'publication-history');
    same(receipt.publication.payload.operationId, need(config.publication?.operationId, 'publication-operation-id'), 'publication-operation');
    this.state.publications ??= {};
    const previous = this.state.publications[String(receipt.version)];
    if (previous) same(previous.publication.id, receipt.publication.id, 'publication-version-rebound');
    this.state.publications[String(receipt.version)] = structuredClone(receipt); this.save();
    return receipt;
  }
  async browser(config) {
    const browser = await browserMeasurement(this.owner, config);
    let receipt = this.state.publications?.[String(browser.runtime.version)];
    if (!receipt) {
      const context = await this.host(config);
      receipt = await this.publication(config, context);
    }
    verifyBrowserPublication(browser, receipt);
    return { ...browser, verifiedPublication: { id: receipt.publication.id, version: receipt.version, documentPath: browser.runtime.documentPath } };
  }
  async snapshot(config, options = {}) {
    const native = await this.native(config, options), browser = await this.browser(config);
    same(native.applicationId, config.applicationId, 'native-application'); same(native.historyId, config.historyId, 'native-history');
    same(native.deviceId, config.native.deviceId, 'native-device');
    if (browser.deviceId === native.deviceId) throw new MeasurementError('browser-reused-native-signer', 'failed');
    if (this.state.browserDevice) same(browser.deviceId, this.state.browserDevice, 'browser-device-replaced');
    else { this.state.browserDevice = browser.deviceId; this.save(); }
    return { native, browser };
  }
  plan(config, check, options) {
    const plan = need(config.commands?.[check], 'command-config-' + check);
    need(plan.name, 'command-name'); need(plan.operationId, 'client-operation-id'); need(plan.marker, 'test-marker');
    if (!Object.hasOwn(plan, 'input')) throw new MeasurementError('command-input');
    const intent = { command: plan.name, input: plan.input, operationId: plan.operationId };
    const key = check + '-intent', digest = hash(JSON.stringify(intent));
    if (this.state.checkpoints[key]) same(digest, this.state.checkpoints[key].sha256, 'changed-command-intent');
    else if (['submit', 'submit-lost'].includes(options.action)) this.checkpoint(key, { sha256: digest, intent });
    return plan;
  }
  async roundTrip(config, check, options) {
    let plan, opId = options.operationId, author, command, marker = options.marker;
    if (check === 'agent-to-browser' || check === 'lost-command-response') {
      plan = this.plan(config, check, options); command = plan.name; marker = plan.marker; opId = plan.operationId; author = config.native.deviceId;
    } else {
      author = need((await this.browser(config)).deviceId, 'browser-author');
      command = need(config.commands?.['browser-to-agent']?.name, 'browser-command-name');
    }
    const saved = this.state.checkpoints[check + '-lost'];
    if (options.action === 'retry') need(saved, 'lost-wait-checkpoint');
    const native = await this.native(config, { operationId: need(opId, 'operation-id'), author, command, input: plan?.input,
      action: options.action, expectedAttemptHash: saved?.native?.operation?.attemptHash });
    if (options.action === 'submit-lost') {
      same(native.waiterInterrupted, true, 'waiter-not-interrupted');
      this.checkpoint(check + '-lost', { native, marker });
      throw new MeasurementError('saved-wait-interrupted-retry-same-operation');
    }
    const op = accepted(native), header = op.attempt.payload.header;
    const applied = operationRows(native, config, header.operationId, author, need(marker, 'marker'));
    const browser = await this.browser(config);
    // Require the operation and marker in one normal rendered row, not a draft/status message.
    const browserToken = config.query.operationId === null ? String(at(applied[0], config.query.rowId)) : header.operationId;
    same(browserRows(browser, marker, browserToken).length, 1, 'browser-operation-row');
    if (check === 'browser-to-agent') same(header.author, browser.deviceId, 'browser-command-signer');
    const evidence = { operationId: header.operationId, clientOperationId: opId, commandOutcome: 'applied', query: { name: config.query.name, revision: native.revision, rows: applied },
      marker, nativeObserved: true, browserObserved: true, native, browser };
    if (check === 'lost-command-response') {
      need(saved, 'lost-wait-checkpoint');
      same(op.attemptHash, saved.native.operation.attemptHash, 'retry-signed-bytes');
      same(header.operationId, saved.native.operation.attempt.payload.header.operationId, 'retry-operation-id');
      Object.assign(evidence, { responseLost: true, retryOperationId: header.operationId, attemptHash: op.attemptHash, retryAttemptHash: saved.native.operation.attemptHash, appliedCount: applied.length });
    }
    return evidence;
  }
  async retained(config, check, options) {
    const opId = need(options.operationId, 'retention-operation-id'), marker = need(options.marker, 'retention-marker');
    const author = need(options.author, 'retention-author'), command = need(options.command, 'retention-command');
    const snapshot = await this.snapshot(config, { operationId: opId, author, command });
    const op = accepted(snapshot.native);
    const rows = operationRows(snapshot.native, config, op.attempt.payload.header.operationId, author, marker);
    const browserToken = config.query.operationId === null ? String(at(rows[0], config.query.rowId)) : op.state.operationId;
    same(browserRows(snapshot.browser, marker, browserToken).length, 1, 'retention-browser-row');
    const process = processMeasurement(config.native.project, config.native.process);
    const store = realpathSync(resolve(config.native.project, need(config.native.deviceStore, 'device-store'))), stat = statSync(store);
    const current = { ...snapshot, process, store: { path: store, device: stat.dev, inode: stat.ino }, marker, operationId: op.state.operationId };
    same(resolve(config.native.project, process.storage), store, 'native-process-store-binding');
    if (options.phase === 'before') { this.checkpoint(check + '-before', current); throw new MeasurementError(check + '-after-checkpoint'); }
    const before = need(this.state.checkpoints[check + '-before'], check + '-before-checkpoint');
    same(before.operationId, current.operationId, 'retention-operation-changed'); same(before.marker, marker, 'retention-marker-changed');
    same(before.native.operation.attemptHash, op.attemptHash, 'retention-signed-attempt-changed');
    same(before.browser.deviceId, snapshot.browser.deviceId, 'reload-browser-device');
    same(before.browser.runtime.publication, snapshot.browser.runtime.publication, 'reload-publication');
    if (check === 'native-reopen') {
      if (before.process.pid === process.pid && before.process.birth === process.birth) throw new MeasurementError('native-process-not-reopened');
      same(before.native.deviceId, snapshot.native.deviceId, 'reopened-device');
      same(JSON.stringify(before.store), JSON.stringify(current.store), 'reopened-store-replaced');
    } else if (!(this.owner.actions ?? []).slice(before.browser.actionIndex).some(action => ['reload', 'reopen'].includes(action.action))) {
      throw new MeasurementError('browser-reload-not-observed');
    }
    return { beforeDeviceId: before.native.deviceId, afterDeviceId: snapshot.native.deviceId, retained: true, before, after: current };
  }
  async publicationRetry(config, options) {
    const { host, sdk, authority } = await this.host(config);
    const intent = recordFile(config.native.project, need(config.publication?.intent, 'saved-publication-file')).value;
    await sdk.verifyPublicationManifest(intent, authority);
    same(intent.payload.applicationId, config.applicationId, 'retry-publication-application');
    same(intent.payload.operationId, config.publication.operationId, 'retry-publication-operation');
    const attemptHash = hash(sdk.encodePeerValue(intent)), key = 'lost-publication-response-before';
    if (options.action === 'drop') {
      this.checkpoint(key, { attemptHash, operationId: intent.payload.operationId, publicationId: intent.id });
    }
    const before = need(this.state.checkpoints[key], 'publication-drop-checkpoint');
    same(before.attemptHash, attemptHash, 'changed-publication-intent');
    const assets = recordFile(config.native.project, need(config.publication.assets, 'publication-assets-file')).value;
    if (!Array.isArray(assets)) throw new MeasurementError('publication-assets-array', 'failed');
    const receipt = await host.peers.publish(intent, assets);
    same(receipt.publication.id, intent.id, 'publication-retry-receipt');
    const receiptHash = hash(sdk.encodePeerValue(receipt));
    if (options.action === 'drop') {
      this.checkpoint('lost-publication-response-dropped', { receiptHash });
      throw new MeasurementError('publication-ack-discarded-retry-same-intent');
    }
    const dropped = need(this.state.checkpoints['lost-publication-response-dropped'], 'publication-dropped-ack-witness');
    same(receiptHash, dropped.receiptHash, 'publication-original-receipt');
    const selected = await this.publication(config, { host, sdk, authority });
    same(selected.publication.id, intent.id, 'publication-current-head');
    return { operationId: intent.payload.operationId, retryOperationId: intent.payload.operationId, attemptHash, retryAttemptHash: before.attemptHash,
      responseLost: true, appliedCount: 1, receiptId: receiptHash, retryReceiptId: dropped.receiptHash, publicationId: intent.id,
      fault: 'Evaluator discarded a real publish acknowledgement; this is not a network partition test' };
  }
  async measure(config, check, options) {
    if (['browser-to-agent', 'agent-to-browser', 'lost-command-response'].includes(check)) return this.roundTrip(config, check, options);
    if (['browser-reload', 'native-reopen'].includes(check)) return this.retained(config, check, options);
    if (check === 'lost-publication-response') return this.publicationRetry(config, options);
    if (['authority', 'preclaim-publication', 'publication'].includes(check)) {
      const context = await this.host(config), { authority, info } = context;
      const receipt = await this.publication(config, context);
      if (check === 'preclaim-publication') {
        same(info.owner_account_id, null, 'already-claimed');
        this.checkpoint('preclaim-publication', { receipt, info });
      } else if (check === 'publication') {
        const before = need(this.state.checkpoints['preclaim-publication'], 'preclaim-publication-checkpoint');
        const browser = await browserIdentity(this.owner, config);
        verifyBrowserPublication(browser, receipt);
        if (options.phase === 'claim-boundary') {
          same(before.receipt.publication.id, receipt.publication.id, 'claim-boundary-publication-changed');
          const expectedOwner = need(this.owner?.access?.accountId ?? config.ownerAccountId, 'expected-owner-account');
          same(need(info.owner_account_id, 'owner-claim-not-observed'), expectedOwner, 'claimed-owner-account');
          this.checkpoint('claim-boundary', { before: before.receipt, after: receipt, beforeAt: before.observedAt,
            ownerAccountId: expectedOwner, browser, retainedSameSignedReceipt: true });
        }
        const boundary = need(this.state.checkpoints['claim-boundary'], 'claim-boundary-checkpoint-not-observed');
        same(info.owner_account_id, boundary.ownerAccountId, 'claimed-owner-changed');
        const ancestors = (config.publication.ancestors ?? []).map(ref => recordFile(config.native.project, ref).value);
        const lineage = await verifyPublicationLineage(receipt, boundary.after, [...Object.values(this.state.publications), ...ancestors], context.sdk, authority);
        return { signatureVerified: true, publicationId: receipt.publication.id, operationId: receipt.publication.payload.operationId,
          receipt, browser, claimBoundary: boundary, signedCasLineage: lineage, selectedGeneration: authority.current?.id };
      }
      const nativeGrant = need(authority.grant(config.native.deviceId), 'native-grant');
      same(nativeGrant.writer, true, 'native-writer-grant');
      return { unclaimed: info.owner_account_id === null, signatureVerified: true, publicationId: receipt.publication.id,
        operationId: receipt.publication.payload.operationId, receipt, nativeGrant, selectedGeneration: need(authority.current?.id, 'selected-generation') };
    }
    if (check === 'connected') {
      const snapshot = await this.snapshot(config), process = processMeasurement(config.native.project, config.native.process);
      const { authority } = await this.host(config);
      same(need(authority.grant(snapshot.browser.deviceId), 'browser-grant').writer, true, 'browser-writer-grant');
      if (!this.state.checkpoints['native-process']) this.checkpoint('native-process', { process });
      const peers = snapshot.native.participation?.connectedPeers;
      if (!peers?.includes(snapshot.browser.deviceId)) throw new MeasurementError('native-connected-peer-metric');
      const transportEvidence = relayTransportMeasurement(recordFile(config.native.project,
        need(config.native.transport, 'selected-transport-metric')).value,
      { process, pageId: config.handle.id, deviceId: snapshot.native.deviceId, remoteDeviceId: snapshot.browser.deviceId });
      return { applicationId: config.applicationId, nativeDeviceId: snapshot.native.deviceId, browserDeviceId: snapshot.browser.deviceId,
        transport: transportEvidence.transport, transportEvidence, nativeProcess: process, snapshot };
    }
    if (check === 'discovery') {
      const file = join(this.runDirectory, 'observable.jsonl');
      if (!existsSync(file)) throw new MeasurementError('model-discovery-trace');
      const items = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const reportPath = join(this.runDirectory, 'report.json');
      const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
      if (report.mode === 'mcp') {
        same(report.mcp?.origin, config.origin, 'mcp-discovery-configured-origin');
        const catalogs = readFileSync(join(this.runDirectory, 'catalog.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const deployment = need(report.deployment, 'mcp-discovery-deployment');
        return mcpDiscovery(items, { origin: config.origin, build: { coreRelease: deployment.sdkVersion, sourceCommit: deployment.sourceRevision,
          runtimeId: deployment.runtimeId, compositionId: deployment.compositionId }, catalog: catalogs[0]?.status });
      }
      return domainDiscovery(items, { origin: config.origin });
    }
    if (check === 'unavailable-peer') {
      if (options.phase === 'before') {
        const snapshot = await this.snapshot(config), process = processMeasurement(config.native.project, config.native.process);
        this.checkpoint(check + '-before', { snapshot, process });
        throw new MeasurementError('peer-offline-observation');
      }
      const before = need(this.state.checkpoints[check + '-before'], 'peer-before-checkpoint');
      const browser = await this.browser(config);
      same(browser.deviceId, before.snapshot.browser.deviceId, 'peer-outage-browser-device');
      if (options.phase === 'offline') {
        if (this.processAlive(before.process)) throw new MeasurementError('peer-still-running');
        if (!browser.status?.includes(need(config.browser.waitingText, 'honest-waiting-text'))) throw new MeasurementError('visible-peer-waiting-state');
        this.checkpoint(check + '-offline', { browser }); throw new MeasurementError('peer-resume-observation');
      }
      need(this.state.checkpoints[check + '-offline'], 'peer-offline-checkpoint');
      const after = await this.snapshot(config);
      same(after.native.deviceId, before.snapshot.native.deviceId, 'resumed-peer-device');
      const result = await this.roundTrip(config, 'browser-to-agent', options);
      return { before, after, resumed: true, retainedCommand: result };
    }
    if (check === 'missing-setup') {
      const report = recordFile(config.native.project, need(config.missingSetup?.report, 'separate-missing-setup-report')).value;
      same(report.protocol, 'tendriller-agent-acceptance-v1', 'missing-setup-report-protocol');
      same(report.origin, config.origin, 'missing-setup-origin'); same(report.outcome, 'blocked', 'missing-setup-outcome');
      same(report.failure?.prerequisiteCode, need(config.missingSetup.expectedCode, 'missing-setup-expected-code'), 'missing-setup-code');
      const current = JSON.parse(readFileSync(join(this.runDirectory, 'report.json'), 'utf8'));
      if (report.startedAt === current.startedAt) throw new MeasurementError('missing-setup-is-baseline', 'failed');
      return { separateAttempt: report.startedAt, prerequisiteCode: report.failure.prerequisiteCode, nextAction: need(report.failure.nextAction, 'missing-setup-next-action') };
    }
    if (check === 'cleanup') {
      need(this.state.checkpoints['preclaim-publication'], 'run-owned-preclaim-checkpoint');
      const process = need(this.state.checkpoints['native-process']?.process, 'owned-process-checkpoint');
      if (this.processAlive(process)) throw new MeasurementError('owned-native-process-still-running');
      const response = await fetch(config.handle.api, { headers: { Authorization: 'Bearer ' + config.handle.token }, redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (response.status !== 404) throw new MeasurementError('owned-application-not-confirmed-deleted');
      const body = await response.json(); same(body.error?.code ?? body.code, 'not_found', 'cleanup-host-not-found');
      return { ownedApplicationsReconciled: true, nativeProcessesStopped: true, persistentReviewerServicesUntouched: true,
        scope: 'This observer never stops processes, changes services, or deletes pages; it observes the configured run-owned app and process only' };
    }
    throw new MeasurementError('unmeasured-' + check);
  }
  processAlive(process) {
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === process.birth;
    } catch { return false; }
  }
  async observe({ check, options = {} }) {
    if (!checks.includes(check)) throw Error('Unknown acceptance check');
    const result = { protocol: 'tendriller-agent-observation-v1', check, observedAt: now(), status: 'blocked', evidence: {} };
    if (this.busy) return { ...result, evidence: { missing: ['observer-busy'] } };
    this.busy = true;
    try {
      const config = this.config();
      result.evidence = await this.measure(config, check, options); result.status = 'passed';
    } catch (error) {
      const invalidProof = /^PEER_.*(INVALID|MISMATCH|FORBIDDEN)$/u.test(error.code ?? '');
      result.status = error instanceof MeasurementError ? error.status : invalidProof ? 'failed' : 'blocked';
      result.evidence = { [result.status === 'blocked' ? 'missing' : 'mismatches']: [error instanceof MeasurementError ? error.metric : invalidProof ? error.code : 'observer-source-unavailable'] };
    } finally { this.busy = false; }
    result.observedAt = now(); return result;
  }
}
