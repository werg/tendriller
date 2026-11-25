import { appendFileSync, writeFileSync, readFileSync, realpathSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const checks = ['discovery', 'preclaim-publication', 'authority', 'connected', 'browser-to-agent', 'agent-to-browser',
  'browser-reload', 'native-reopen', 'lost-command-response', 'lost-publication-response', 'unavailable-peer', 'missing-setup', 'publication', 'cleanup'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const now = () => new Date().toISOString();
export function innocentPrompt(origin, mode) {
  return mode === 'mcp'
    ? 'Build me a small shared checklist page I can use in my browser, and connect it to this chat. I want to add items, mark them complete, see the same list from your session, and keep my work when I reload. Give me the working page and explain how to return to it. Ask me for any identity or sign-in you actually need.'
    : `Build me a shared checklist using ${origin}. I want to add items and mark them complete in my browser, see the same list from your agent session, and keep my work when I reload. Give me the working page and explain how to return to it. Ask me for any identity or sign-in you actually need.`;
}
export function privateDirectory(path) {
  path = resolve(path);
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  for (let p = realpathSync(ancestor); ; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) throw Error('Evidence and projects must be outside source checkouts');
    if (p === dirname(p)) break;
  }
  if (existsSync(path)) throw Error('Use a new private run directory');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
export class Evidence {
  constructor(directory, metadata) {
    this.directory = directory;
    this.data = { protocol: 'tendriller-agent-acceptance-v2', startedAt: now(), ...metadata, outcome: 'blocked',
      host: 'native-codex', chatgptWeb: { status: 'not-tested', reason: 'Native Codex is a separate host' },
      checks: Object.fromEntries(checks.map(name => [name, { status: 'not-tested' }])), interventions: [], observations: [],
      limits: ['Public report contains references and hashes; private evidence needs separate review.', 'No supported wake of an existing ChatGPT conversation is established.', 'A blocked optional native cryptographic observer is not a browser Save or local-read failure. Stored, materialized, retained and finalized are independent facts.'] };
    this.save();
  }
  private(name, value) {
    appendFileSync(join(this.directory, name + '.jsonl'), JSON.stringify({ at: now(), ...value }) + '\n', { mode: 0o600 });
  }
  // One controller owns this instance. Readers get an atomic snapshot; callers
  // must use observe IPC rather than instantiate a competing writer or merge files.
  save() {
    const temporary = join(this.directory, '.report-' + randomUUID());
    writeFileSync(temporary, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(this.directory, 'report.json'));
  }
  intervention(kind, text) {
    if (!['identity', 'sign-in', 'review', 'visible-error', 'user-outcome', 'maintainer-advice'].includes(kind)) throw Error('Unknown intervention category');
    this.private('interventions', { kind, text });
    this.data.interventions.push({ kind, at: now(), sha256: hash(text) });
    if (kind === 'maintainer-advice') this.data.assisted = true;
    this.save();
  }
  /** External adapters are trusted observers, not model messages. Raw evidence stays private. */
  observation(value, source) {
    if (value.protocol !== 'tendriller-agent-observation-v2' || !checks.includes(value.check) ||
        !['passed', 'failed', 'blocked', 'not-tested'].includes(value.status) ||
        !value.evidence || typeof value.evidence !== 'object' || !Number.isFinite(Date.parse(value.observedAt))) throw Error('Invalid adapter observation');
    if (value.check === 'preclaim-publication' && value.status === 'passed' &&
      !(value.evidence.unclaimed === true && value.evidence.signatureVerified === true && value.evidence.publicationId && value.evidence.operationId)) throw Error('Preclaim needs verified signed publication, operation and unclaimed observation');
    const e = value.evidence;
    if (value.check === 'lost-command-response' && value.status === 'passed' &&
      !(e.operationId && e.operationId === e.retryOperationId && /^[a-f0-9]{64}$/.test(e.proposalId ?? '') && e.proposalId === e.retryProposalId &&
        /^[a-f0-9]{64}$/.test(e.proofHash ?? '') && e.proofHash === e.retryProofHash && e.proofScope === 'signed-encrypted-envelope' &&
        e.responseLost === true && e.materializedCount === 1)) throw Error('Lost command response needs the original proposal and exact saved signed envelope, not a new timestamp/submission');
    if (value.check === 'lost-publication-response' && value.status === 'passed' &&
      !(e.operationId && e.operationId === e.retryOperationId && /^[a-f0-9]{64}$/.test(e.publicationHash ?? '') &&
        e.publicationHash === e.retryPublicationHash && e.responseLost === true && e.receiptCount === 1 &&
        e.receiptId && e.receiptId === e.retryReceiptId)) throw Error('Publication retry must return the original signed intent and receipt');
    if (['browser-reload', 'native-reopen'].includes(value.check) && value.status === 'passed' &&
      !(e.beforeDeviceId && e.beforeDeviceId === e.afterDeviceId && e.localDurable === true)) throw Error('Reopen must retain the same device and locally stored data; local durability is not peer retention');
    if (['browser-to-agent', 'agent-to-browser', 'lost-command-response'].includes(value.check) && value.status === 'passed' &&
      !(e.operationId && /^[a-f0-9]{64}$/.test(e.proposalId ?? '') && e.facts?.stored === true && e.facts.excluded === false &&
        e.facts.materialized?.outcome === 'accepted' && e.facts.materialized.proposalId === e.proposalId &&
        Array.isArray(e.facts.retained) && typeof e.facts.finalized === 'boolean' &&
        e.query?.applicationId && e.query.revision?.digest && Array.isArray(e.query.value) &&
        JSON.stringify(e.query.revision) === JSON.stringify(e.facts.materialized.revision) &&
        e.marker && e.browserObserved === true && e.nativeObserved === true && e.native?.operation?.signatureVerified === true))
      throw Error('Round trip needs stored/materialized facts, coherent query, signed-envelope evidence and independent participant observations; retention and finality remain separate');
    if (value.check === 'unavailable-peer' && value.status === 'passed' &&
      !(e.localDurable === true && e.proposalId && e.materialized?.outcome === 'accepted' &&
        (e.browserNetworkOffline === true || e.optionalNativeAbsent === true))) throw Error('Unavailable peer needs an actual outage and a new locally stored/materialized browser operation');
    if (value.check === 'connected' && value.status === 'passed' &&
      !(e.applicationId && e.nativeDeviceId && e.browserDeviceId && e.nativeDeviceId !== e.browserDeviceId &&
        e.transport && e.nativeProcess?.pid && e.nativeProcess?.startedAt && e.nativeProcess?.resume && e.nativeProcess?.storage))
      throw Error('Connection needs independent devices, transport and native process/resume details');
    if (value.check === 'cleanup' && value.status === 'passed' &&
      !(e.ownedApplicationsReconciled === true && e.nativeProcessesStopped === true && e.persistentReviewerServicesUntouched === true))
      throw Error('Cleanup needs owned-app reconciliation and process accounting');
    const entry = { ...value, source };
    this.private('observations', entry);
    this.data.observations.push({ check: value.check, at: value.observedAt, source, sha256: hash(JSON.stringify(entry)) });
    this.data.checks[value.check] = { status: value.status, observedAt: value.observedAt, source };
    if (value.status === 'passed' && value.check === 'browser-to-agent' && !this.data.firstSharedAt) this.data.firstSharedAt = value.observedAt;
    this.save();
  }
  finish() {
    const browserChecks = ['discovery', 'preclaim-publication', 'authority', 'browser-reload', 'lost-publication-response', 'unavailable-peer', 'missing-setup', 'publication', 'cleanup'];
    const browserValues = browserChecks.map(name => this.data.checks[name].status);
    this.data.browserLocalAcceptance = { checks: browserChecks, outcome: this.data.assisted ? 'assisted' : browserValues.includes('failed') ? 'failed' : !this.data.deadlineReached && browserValues.every(status => status === 'passed') ? 'complete' : 'blocked',
      scope: 'Local browser authoring/durability and signed publication only. Peer convergence and independent operation crypto evidence remain separate full acceptance requirements; no native process is required for browser Save.' };
    const values = Object.values(this.data.checks).map(c => c.status);
    this.data.outcome = this.data.assisted ? 'assisted' : values.includes('failed') ? 'failed' : !this.data.deadlineReached && values.every(s => s === 'passed') ? 'complete' : 'blocked';
    this.data.firstUnresolvedCheck = Object.entries(this.data.checks).find(([, check]) => check.status !== 'passed')?.[0] ?? null;
    this.data.elapsedMs = Date.now() - Date.parse(this.data.startedAt);
    this.data.endedAt = now(); this.save();
  }
}
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

/** External-host attestation, deliberately separate from a native Codex run. */
export function externalReport(directory, envelope) {
  let origin;
  try { origin = new URL(envelope.origin); } catch { throw Error('External report needs an exact HTTPS origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== envelope.origin || !['domain', 'mcp'].includes(envelope.mode))
    throw Error('External report needs an exact HTTPS origin and discovery mode');
  if (envelope.protocol !== 'tendriller-external-host-v1' || !['chatgpt-web', 'other'].includes(envelope.host) ||
    !envelope.environment || typeof envelope.environment !== 'object' || !Array.isArray(envelope.observations) ||
    !Array.isArray(envelope.interventions) || typeof envelope.initialPrompt !== 'string' || !envelope.sessionEvidence)
    throw Error('External host requires environment, initial prompt, interventions, observations and actual session evidence');
  const evidence = new Evidence(directory, { host: envelope.host, mode: envelope.mode, origin: envelope.origin,
    externalAttestation: true, environmentSha256: hash(JSON.stringify(envelope.environment)) });
  evidence.private('external-session', { environment: envelope.environment, initialPrompt: envelope.initialPrompt, sessionEvidence: envelope.sessionEvidence });
  if (envelope.initialPrompt !== innocentPrompt(envelope.origin, envelope.mode)) evidence.intervention('maintainer-advice', 'External initial prompt differs from the maintained innocent prompt; reviewer must assess supplied context.');
  evidence.data.chatgptWeb = { status: envelope.host === 'chatgpt-web' ? 'external-attested' : 'not-tested',
    reason: 'External observer attestation; native Codex does not verify this host' };
  for (const intervention of envelope.interventions) evidence.intervention(intervention.kind, intervention.text);
  for (const observation of envelope.observations) evidence.observation(observation, 'external-host-attestation');
  evidence.finish(); return evidence;
}
