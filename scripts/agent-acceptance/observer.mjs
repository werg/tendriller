import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { importReviewPackages } from '../review/packages.mjs';
import { nativeMeasurement, verifiedAuthority, requireAuthoredProofSDK } from './observer-native.mjs';
import { MeasurementError, need, same, at, loadObserverConfig, recordFile, processMeasurement, publicationAddress, relayTransportMeasurement } from './observer-data.mjs';
import { hash, now, checks } from './evidence.mjs';
import { mcpDiscovery, domainDiscovery } from './discovery.mjs';

function policyEvidence(authority, sdk) {
  if (!authority) return null;
  const policy = authority.descriptor.finalityPolicy;
  return { kind: policy.kind, record: Buffer.from(sdk.encodeRecord(policy)).toString('hex') };
}
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
    same(events[0].proposalId, native.operation.state.proposalId, 'event-signed-proposal');
    same(events[0].operationId, operationId, 'event-operation'); same(events[0].author, author, 'event-author');
    const id = q.eventIdEncoding === 'author-operation-json' ? JSON.stringify([events[0].author, events[0].operationId])
      : q.eventIdEncoding === 'author-operation-colon' ? `${events[0].author}:${events[0].operationId}`
      : need(at(events[0], need(q.eventId, 'event-row-key')), 'event-row-id');
    rows = native.rows.filter(row => at(row, need(q.rowId, 'query-row-key')) === id);
  } else rows = native.rows.filter(row => at(row, q.operationId ?? '/operationId') === operationId && at(row, q.author ?? '/author') === author);
  same(rows.length, 1, 'operation-materialized-row-count');
  same(at(rows[0], q.marker ?? '/text'), marker, 'native-marker');
  return rows;
}
function accepted(snapshot) {
  const op = need(snapshot.operation, 'native-operation-proof');
  same(op.state.stored, true, 'command-stored');
  same(op.state.materialized?.outcome, 'accepted', 'command-materialized-accepted');
  same(op.state.materialized?.proposalId, op.state.proposalId, 'materialized-proposal');
  same(op.state.excluded, false, 'command-excluded');
  if (JSON.stringify(op.state.materialized?.revision) !== JSON.stringify(snapshot.revision)) throw new MeasurementError('coherent-operation-query-revision');
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

/** Observe the already installed browser backend. This neither installs a backend
 * nor opens another signer/store. SQL is a read of the existing domain view. */
export async function browserLocalMeasurement(owner, config, options = {}) {
  const browser = await browserMeasurement(owner, config), query = need(config.query, 'query-config');
  const local = await owner.page.evaluate(async ({ applicationId, sql, parameters, operationId, topic }) => {
    const application = window.tendril?.application;
    if (!application?.available) return { missing: 'installed-browser-backend' };
    const backend = application.backend;
    if (backend.applicationId !== applicationId) return { mismatch: 'browser-backend-application' };
    if (!sql) return { missing: 'browser-domain-read-sql' };
    const view = await backend.readView();
    try {
      const result = await view.query(sql, parameters);
      const value = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]])));
      const events = []; let cursor;
      for (let page = 0; ; page++) {
        if (page >= 64) return { missing: 'browser-event-scan-bound' };
        const batch = await view.readEvents({ limit: 128, ...(cursor ? { cursor } : {}), ...(topic ? { topics: [topic] } : {}) });
        if (JSON.stringify(batch.revision) !== JSON.stringify(view.revision)) return { mismatch: 'browser-event-revision' };
        events.push(...batch.events);
        if (!batch.hasMore) break;
        if (!batch.cursor || batch.cursor === cursor) return { mismatch: 'browser-event-cursor' };
        cursor = batch.cursor;
      }
      const operation = operationId ? await backend.operations.get(operationId) : null;
      return { applicationId: view.applicationId, deviceId: backend.identity.publicKey, revision: view.revision, rows: value, events,
        operation: operation ? { state: await operation.inspect() } : null };
    } finally { await view.release(); }
  }, { applicationId: config.applicationId, sql: query.sql, parameters: query.parameters ?? [], operationId: options.operationId, topic: query.eventTopic });
  if (local.missing) throw new MeasurementError(local.missing);
  if (local.mismatch) throw new MeasurementError(local.mismatch, 'failed');
  same(local.applicationId, config.applicationId, 'browser-local-application');
  same(local.deviceId, browser.deviceId, 'browser-local-signer');
  need(local.revision?.digest, 'browser-local-materialized-revision');
  if (options.operationId) {
    const state = need(local.operation?.state, 'browser-local-operation');
    same(state.applicationId, config.applicationId, 'browser-operation-application');
    same(state.stored, true, 'browser-operation-stored');
    same(state.excluded, false, 'browser-operation-excluded');
    same(state.materialized?.proposalId, state.proposalId, 'browser-materialized-proposal');
    same(state.materialized?.outcome, 'accepted', 'browser-operation-materialized');
    if (options.operationId !== state.proposalId) same(state.operationId, options.operationId, 'browser-operation-id');
    same(state.author, need(options.author, 'browser-expected-author'), 'browser-operation-author');
    if (JSON.stringify(state.materialized.revision) !== JSON.stringify(local.revision)) throw new MeasurementError('browser-coherent-operation-query');
    const rows = operationRows({ ...local, events: local.events.filter(event => event.proposalId === state.proposalId && event.operationId === state.operationId && event.author === state.author) },
      config, state.operationId, state.author, need(options.marker, 'browser-marker'));
    const identity = config.query.operationId === null ? String(at(rows[0], config.query.rowId)) : state.operationId;
    same(browserRows(browser, options.marker, identity).length, 1, 'browser-local-rendered-row');
  }
  return { browser, local, evidenceScope: 'Browser local storage/materialized observations and coherent domain read; no independent raw signed-envelope or finality-proof verification' };
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
    const binding = { origin: config.origin, applicationId: config.applicationId, deviceId: config.native?.deviceId ?? null, pageId: config.handle.id, pageUrl: config.handle.page_url,
      descriptor: config.descriptor ? hash(JSON.stringify(config.descriptor)) : null, project: config.project };
    if (this.state.binding) same(JSON.stringify(binding), JSON.stringify(this.state.binding), 'observer-identity-changed');
    else { this.state.binding = binding; this.save(); }
    return config;
  }
  async host(config) {
    const { core, session: sdk } = await this.packages(config.project);
    requireAuthoredProofSDK(sdk);
    const host = core.createAgentClient({ service: config.origin, token: config.credential.token }, {
      fetch: (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(12000), ...[options.signal].filter(Boolean)]) })
    }).page(config.handle.id, { applicationId: config.applicationId });
    const metadata = await host.peers.application();
    same(metadata.selection?.id, config.applicationId, 'authority-application');
    const publicationAuthority = need(metadata.publicationAuthority, 'independent-publication-authority');
    same(publicationAuthority.applicationId, config.applicationId, 'publisher-application');
    let authority;
    if (metadata.authority && config.descriptor) {
      const bundle = sdk.decodeRecord(core.authorityRecordBytes(metadata.authority));
      authority = await verifiedAuthority(bundle, config.descriptor, sdk);
    }
    const info = await host.info();
    same(info.id, config.handle.id, 'host-page-id');
    same(info.application?.id, config.applicationId, 'host-application-id');
    same(info.page_url, config.handle.page_url, 'host-authoritative-page-url');
    return { host, sdk, authority, publicationAuthority, info };
  }
  async publication(config, { host, sdk, publicationAuthority }) {
    const receipt = need(await host.peers.publication(), 'selected-publication');
    await sdk.verifyPublicationManifest(receipt.publication, publicationAuthority);
    same(receipt.publication.payload.applicationId, config.applicationId, 'publication-application');
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
    if (!config.native) throw new MeasurementError('optional-native-observer-not-configured');
    const native = await this.native(config, options), browser = await this.browser(config);
    same(native.applicationId, config.applicationId, 'native-application');
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
    if (!config.native) throw new MeasurementError('optional-native-observer-not-configured');
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
      action: options.action, expectedProofHash: saved?.native?.operation?.proofHash, expectedProposalId: saved?.native?.operation?.state?.proposalId });
    if (options.action === 'submit-lost') {
      same(native.waiterInterrupted, true, 'waiter-not-interrupted');
      this.checkpoint(check + '-lost', { native, marker });
      throw new MeasurementError('saved-wait-interrupted-retry-same-operation');
    }
    const op = accepted(native), header = op.state;
    const materialized = operationRows(native, config, header.operationId, author, need(marker, 'marker'));
    const browser = await this.browser(config);
    // Require the operation and marker in one normal rendered row, not a draft/status message.
    const browserToken = config.query.operationId === null ? String(at(materialized[0], config.query.rowId)) : header.operationId;
    same(browserRows(browser, marker, browserToken).length, 1, 'browser-operation-row');
    if (check === 'browser-to-agent') same(header.author, browser.deviceId, 'browser-command-signer');
    const evidence = { operationId: header.operationId, clientOperationId: opId, proposalId: header.proposalId, facts: { stored: header.stored, materialized: header.materialized, retained: header.retained, finalized: header.finalized, excluded: header.excluded }, query: { applicationId: native.applicationId, name: config.query.name, revision: native.revision, value: materialized },
      marker, nativeObserved: true, browserObserved: true, native, browser };
    if (check === 'lost-command-response') {
      need(saved, 'lost-wait-checkpoint');
      same(op.proofHash, saved.native.operation.proofHash, 'retry-signed-bytes');
      same(header.operationId, saved.native.operation.state.operationId, 'retry-operation-id');
      same(header.proposalId, saved.native.operation.state.proposalId, 'retry-proposal-id');
      same(header.authorTimestampMs, saved.native.operation.state.authorTimestampMs, 'retry-author-timestamp');
      Object.assign(evidence, { responseLost: true, retryOperationId: header.operationId, proofScope: 'signed-encrypted-envelope', proofHash: op.proofHash, retryProofHash: saved.native.operation.proofHash, retryProposalId: saved.native.operation.state.proposalId, materializedCount: materialized.length });
    }
    return evidence;
  }
  async browserReload(config, options) {
    const current = await browserLocalMeasurement(this.owner, config, options);
    await this.browser(config); // Signed publication pin is independent of data evidence.
    if (options.phase === 'before') {
      this.checkpoint('browser-reload-before', current);
      throw new MeasurementError('browser-reload-after-checkpoint');
    }
    const before = need(this.state.checkpoints['browser-reload-before'], 'browser-reload-before-checkpoint');
    same(current.browser.deviceId, before.browser.deviceId, 'reload-browser-device');
    same(current.browser.runtime.publication, before.browser.runtime.publication, 'reload-publication');
    same(current.local.operation.state.proposalId, before.local.operation.state.proposalId, 'reload-proposal');
    same(current.local.operation.state.authorTimestampMs, before.local.operation.state.authorTimestampMs, 'reload-author-time');
    if (!(this.owner.actions ?? []).slice(before.browser.actionIndex).some(action => ['reload', 'reopen'].includes(action.action))) throw new MeasurementError('browser-reload-not-observed');
    return { beforeDeviceId: before.browser.deviceId, afterDeviceId: current.browser.deviceId, localDurable: true,
      proposalId: current.local.operation.state.proposalId, before, after: current, nativeRequired: false };
  }
  async retained(config, check, options) {
    if (!config.native) throw new MeasurementError('optional-native-observer-not-configured');
    const opId = need(options.operationId, 'retention-operation-id'), marker = need(options.marker, 'retention-marker');
    const author = need(options.author, 'retention-author'), command = need(options.command, 'retention-command');
    const snapshot = await this.snapshot(config, { operationId: opId, author, command });
    const op = accepted(snapshot.native);
    const rows = operationRows(snapshot.native, config, op.state.operationId, author, marker);
    const browserToken = config.query.operationId === null ? String(at(rows[0], config.query.rowId)) : op.state.operationId;
    same(browserRows(snapshot.browser, marker, browserToken).length, 1, 'retention-browser-row');
    const process = processMeasurement(config.native.project, config.native.process);
    const store = realpathSync(resolve(config.native.project, need(config.native.deviceStore, 'device-store'))), stat = statSync(store);
    const current = { ...snapshot, process, store: { path: store, device: stat.dev, inode: stat.ino }, marker, operationId: op.state.operationId };
    same(resolve(config.native.project, process.storage), store, 'native-process-store-binding');
    if (options.phase === 'before') { this.checkpoint(check + '-before', current); throw new MeasurementError(check + '-after-checkpoint'); }
    const before = need(this.state.checkpoints[check + '-before'], check + '-before-checkpoint');
    same(before.operationId, current.operationId, 'retention-operation-changed'); same(before.marker, marker, 'retention-marker-changed');
    same(before.native.operation.proofHash, op.proofHash, 'retention-signed-envelope-changed');
    same(before.browser.deviceId, snapshot.browser.deviceId, 'reload-browser-device');
    same(before.browser.runtime.publication, snapshot.browser.runtime.publication, 'reload-publication');
    if (check === 'native-reopen') {
      if (before.process.pid === process.pid && before.process.birth === process.birth) throw new MeasurementError('native-process-not-reopened');
      same(before.native.deviceId, snapshot.native.deviceId, 'reopened-device');
      same(JSON.stringify(before.store), JSON.stringify(current.store), 'reopened-store-replaced');
    } else if (!(this.owner.actions ?? []).slice(before.browser.actionIndex).some(action => ['reload', 'reopen'].includes(action.action))) {
      throw new MeasurementError('browser-reload-not-observed');
    }
    return { beforeDeviceId: before.native.deviceId, afterDeviceId: snapshot.native.deviceId, localDurable: true, before, after: current };
  }
  async publicationRetry(config, options) {
    const { host, sdk, publicationAuthority } = await this.host(config);
    const intent = recordFile(config.project, need(config.publication?.intent, 'saved-publication-file')).value;
    await sdk.verifyPublicationManifest(intent, publicationAuthority);
    same(intent.payload.applicationId, config.applicationId, 'retry-publication-application');
    same(intent.payload.operationId, config.publication.operationId, 'retry-publication-operation');
    const publicationHash = hash(sdk.encodeRecord(intent)), key = 'lost-publication-response-before';
    if (options.action === 'drop') {
      this.checkpoint(key, { publicationHash, operationId: intent.payload.operationId, publicationId: intent.id });
    }
    const before = need(this.state.checkpoints[key], 'publication-drop-checkpoint');
    same(before.publicationHash, publicationHash, 'changed-publication-intent');
    const assets = recordFile(config.project, need(config.publication.assets, 'publication-assets-file')).value;
    if (!Array.isArray(assets)) throw new MeasurementError('publication-assets-array', 'failed');
    const receipt = await host.peers.publish(intent, assets);
    same(receipt.publication.id, intent.id, 'publication-retry-receipt');
    const receiptHash = hash(sdk.encodeRecord(receipt));
    if (options.action === 'drop') {
      this.checkpoint('lost-publication-response-dropped', { receiptHash });
      throw new MeasurementError('publication-ack-discarded-retry-same-intent');
    }
    const dropped = need(this.state.checkpoints['lost-publication-response-dropped'], 'publication-dropped-ack-witness');
    same(receiptHash, dropped.receiptHash, 'publication-original-receipt');
    const selected = await this.publication(config, { host, sdk, publicationAuthority });
    same(selected.publication.id, intent.id, 'publication-current-head');
    return { operationId: intent.payload.operationId, retryOperationId: intent.payload.operationId, publicationHash, retryPublicationHash: before.publicationHash,
      responseLost: true, receiptCount: 1, receiptId: receiptHash, retryReceiptId: dropped.receiptHash, publicationId: intent.id,
      fault: 'Evaluator discarded a real publish acknowledgement; this is not a network partition test' };
  }
  async measure(config, check, options) {
    if (['browser-to-agent', 'agent-to-browser', 'lost-command-response'].includes(check)) return this.roundTrip(config, check, options);
    if (check === 'browser-reload') return this.browserReload(config, options);
    if (check === 'native-reopen') return this.retained(config, check, options);
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
        const ancestors = (config.publication.ancestors ?? []).map(ref => recordFile(config.project, ref).value);
        const lineage = await verifyPublicationLineage(receipt, boundary.after, [...Object.values(this.state.publications), ...ancestors], context.sdk, context.publicationAuthority);
        return { signatureVerified: true, publicationId: receipt.publication.id, operationId: receipt.publication.payload.operationId,
          receipt, browser, claimBoundary: boundary, signedCasLineage: lineage, finalityPolicy: policyEvidence(authority, context.sdk) };
      }
      if (check === 'authority') {
        need(authority, 'pinned-data-authority');
        return { descriptorVerified: true, applicationId: authority.descriptor.applicationId, finalityPolicy: policyEvidence(authority, context.sdk) };
      }
      return { unclaimed: info.owner_account_id === null, signatureVerified: true, publicationId: receipt.publication.id,
        operationId: receipt.publication.payload.operationId, receipt, publicationAuthority: context.publicationAuthority };
    }
    if (check === 'connected') {
      const snapshot = await this.snapshot(config), process = processMeasurement(config.native.project, config.native.process);
      const { authority } = await this.host(config);
      need(authority, 'pinned-data-authority');
      same(need(authority.grant(snapshot.browser.deviceId), 'browser-grant').writer, true, 'browser-writer-grant');
      if (!this.state.checkpoints['native-process']) this.checkpoint('native-process', { process });
      if (!(snapshot.native.status?.connectedPeers > 0)) throw new MeasurementError('native-connected-peer-metric');
      const transportEvidence = relayTransportMeasurement(recordFile(config.project,
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
        const snapshot = await browserLocalMeasurement(this.owner, config);
        await this.browser(config);
        const process = config.native ? processMeasurement(config.project, config.native.process) : null;
        this.checkpoint(check + '-before', { snapshot, process });
        throw new MeasurementError('browser-disconnected-authoring-observation');
      }
      const before = need(this.state.checkpoints[check + '-before'], 'peer-before-checkpoint');
      const current = await browserLocalMeasurement(this.owner, config, options);
      await this.browser(config);
      same(current.browser.deviceId, before.snapshot.browser.deviceId, 'peer-outage-browser-device');
      if (options.phase === 'offline') {
        const browserOffline = await this.owner.page.evaluate(() => navigator.onLine === false);
        const nativeAbsent = before.process && !this.processAlive(before.process);
        if (!browserOffline && !nativeAbsent) throw new MeasurementError('browser-offline-or-optional-peer-exit-not-observed');
        const state = need(current.local.operation?.state, 'offline-stored-operation');
        same(state.author, current.browser.deviceId, 'offline-browser-author');
        if (before.snapshot.local.events.some(event => event.proposalId === state.proposalId)) throw new MeasurementError('offline-operation-preexists', 'failed');
        if (!current.local.events.some(event => event.proposalId === state.proposalId)) throw new MeasurementError('offline-materialized-event');
        this.checkpoint(check + '-offline', { current, browserOffline, nativeAbsent: Boolean(nativeAbsent) });
        throw new MeasurementError('browser-offline-persistence-observation');
      }
      const offline = need(this.state.checkpoints[check + '-offline'], 'peer-offline-checkpoint');
      same(current.local.operation?.state.proposalId, offline.current.local.operation.state.proposalId, 'offline-proposal-replaced');
      same(current.local.operation?.state.authorTimestampMs, offline.current.local.operation.state.authorTimestampMs, 'offline-intent-retimestamped');
      return { localDurable: true, materialized: current.local.operation.state.materialized, proposalId: current.local.operation.state.proposalId,
        browserNetworkOffline: offline.browserOffline, optionalNativeAbsent: offline.nativeAbsent, nativeRequired: false,
        before, offline, after: current, convergence: 'Not established by this check; independent participant round trips are separate evidence' };
    }
    if (check === 'missing-setup') {
      const report = recordFile(config.project, need(config.missingSetup?.report, 'separate-missing-setup-report')).value;
      same(report.protocol, 'tendriller-agent-acceptance-v2', 'missing-setup-report-protocol');
      same(report.origin, config.origin, 'missing-setup-origin'); same(report.outcome, 'blocked', 'missing-setup-outcome');
      same(report.failure?.prerequisiteCode, need(config.missingSetup.expectedCode, 'missing-setup-expected-code'), 'missing-setup-code');
      const current = JSON.parse(readFileSync(join(this.runDirectory, 'report.json'), 'utf8'));
      if (report.startedAt === current.startedAt) throw new MeasurementError('missing-setup-is-baseline', 'failed');
      return { separateAttempt: report.startedAt, prerequisiteCode: report.failure.prerequisiteCode, nextAction: need(report.failure.nextAction, 'missing-setup-next-action') };
    }
    if (check === 'cleanup') {
      need(this.state.checkpoints['preclaim-publication'], 'run-owned-preclaim-checkpoint');
      const process = config.native ? need(this.state.checkpoints['native-process']?.process, 'owned-process-checkpoint') : null;
      if (process && this.processAlive(process)) throw new MeasurementError('owned-native-process-still-running');
      const response = await fetch(config.handle.api, { headers: { Authorization: 'Bearer ' + config.credential.token }, redirect: 'error', signal: AbortSignal.timeout(12000) });
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
    const result = { protocol: 'tendriller-agent-observation-v2', check, observedAt: now(), status: 'blocked', evidence: {} };
    if (this.busy) return { ...result, evidence: { missing: ['observer-busy'] } };
    this.busy = true;
    try {
      const config = this.config();
      result.evidence = await this.measure(config, check, options); result.status = 'passed';
    } catch (error) {
      const invalidProof = /^(?:AUTHORITY|OPERATION|PUBLICATION)_.*(?:INVALID|MISMATCH|FORBIDDEN)$/u.test(error.code ?? '');
      result.status = error instanceof MeasurementError ? error.status : invalidProof ? 'failed' : 'blocked';
      result.evidence = { [result.status === 'blocked' ? 'missing' : 'mismatches']: [error instanceof MeasurementError ? error.metric : invalidProof ? error.code : 'observer-source-unavailable'] };
    } finally { this.busy = false; }
    result.observedAt = now(); return result;
  }
}
