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
    this.data = { protocol: 'tendriller-agent-acceptance-v1', startedAt: now(), ...metadata, outcome: 'blocked',
      host: 'native-codex', chatgptWeb: { status: 'not-tested', reason: 'Native Codex is a separate host' },
      checks: Object.fromEntries(checks.map(name => [name, { status: 'not-tested' }])), interventions: [], observations: [],
      limits: ['Public report contains references and hashes; private evidence needs separate review.', 'No supported wake of an existing ChatGPT conversation is established.'] };
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
    if (value.protocol !== 'tendriller-agent-observation-v1' || !checks.includes(value.check) ||
        !['passed', 'failed', 'blocked', 'not-tested'].includes(value.status) ||
        !value.evidence || typeof value.evidence !== 'object' || !Number.isFinite(Date.parse(value.observedAt))) throw Error('Invalid adapter observation');
    if (value.check === 'preclaim-publication' && value.status === 'passed' &&
      !(value.evidence.unclaimed === true && value.evidence.signatureVerified === true && value.evidence.publicationId && value.evidence.operationId)) throw Error('Preclaim needs verified signed publication, operation and unclaimed observation');
    if (['lost-command-response', 'lost-publication-response'].includes(value.check) && value.status === 'passed' &&
      !(value.evidence.operationId === value.evidence.retryOperationId && value.evidence.operationId &&
        value.evidence.attemptHash === value.evidence.retryAttemptHash && /^[a-f0-9]{64}$/.test(value.evidence.attemptHash ?? '') &&
        value.evidence.responseLost === true && value.evidence.appliedCount === 1)) throw Error('Lost-response checks require the same saved signed attempt and one application');
    if (value.check === 'lost-publication-response' && value.status === 'passed' &&
      !(value.evidence.receiptId && value.evidence.receiptId === value.evidence.retryReceiptId)) throw Error('Publication retry must return the original receipt');
    if (value.check === 'native-reopen' && value.status === 'passed' &&
      !(value.evidence.beforeDeviceId && value.evidence.beforeDeviceId === value.evidence.afterDeviceId && value.evidence.retained === true)) throw Error('Reopen must retain device and data');
    const e = value.evidence;
    if (['browser-to-agent', 'agent-to-browser'].includes(value.check) && value.status === 'passed' &&
      !(e.operationId && e.commandOutcome === 'applied' && e.query && e.marker && e.browserObserved === true && e.nativeObserved === true))
      throw Error('Round trip needs applied command, coherent query and both participant observations');
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
