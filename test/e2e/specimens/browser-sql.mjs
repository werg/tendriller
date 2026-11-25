import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { startSqlFixtureWorker } from './browser-sql-startup.mjs';
import { observeSqlFixture } from './browser-sql-view.mjs';

const el = id => document.getElementById(id);
const status = text => { el('status').textContent = text; };
let session, editRevision = 0, currentAnswer = '', nextTask = 0, busy = false, liveView;
const rendered = new Map();
const owner = new AbortController();
let draftKey, latestSubmission = 0;
const errorStatus = error => status(`Could not complete the request: ${error.message}`);

async function submit(command, input) {
  const submitted = ++latestSubmission;
  const operation = await session.command(command, input, { operationId: crypto.randomUUID() });
  // Stored first, then materialized locally (revisable); retention by another device is its own later fact.
  const outcome = await operation.materialized({ signal: AbortSignal.timeout(15_000) });
  if (outcome.outcome === 'accepted') {
    status('Applied here. Waiting for another device to retain the change.');
    void operation.retained({ signal: owner.signal }).then(() => {
      if (submitted === latestSubmission) status('Shared with another device.');
    }, () => { /* Local work remains visible while no retained copy is observed. */ });
  } else {
    status(`Change rejected${outcome.rejectionCode ? ` (${outcome.rejectionCode})` : ''}. Review the current record and try again.`);
  }
  return outcome.outcome === 'accepted';
}
async function act(work) {
  if (busy) return;
  busy = true;
  status('Saving…');
  try { await work(); }
  catch (error) { errorStatus(error); }
  finally { busy = false; }
}

function renderTasks({ value: rows }) {
  const present = new Set(rows.map(row => row[0]));
  for (const [id, item] of rendered) {
    if (present.has(id)) continue;
    item.row.remove();
    rendered.delete(id);
  }
  for (const [id, title, claimant, done] of rows) {
    let item = rendered.get(id);
    if (!item) {
      const row = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
      row.append(label, ' ', button);
      el('tasks').append(row);
      item = { row, label, button };
      rendered.set(id, item);
    }
    item.label.textContent = `${title} · ${done ? 'Done' : claimant ? claimant === session.identity.publicKey ? 'Claimed by you' : 'Claimed by a teammate' : 'Open'}`;
    item.button.textContent = claimant === session.identity.publicKey ? 'Complete task' : 'Claim task';
    item.button.disabled = Boolean(done || claimant && claimant !== session.identity.publicKey);
    item.button.onclick = () => void act(() => submit(claimant ? 'finish' : 'claim', id));
  }
}

function renderAnswer({ value: rows }) {
  const [body, revision] = rows[0] ?? ['', 0];
  currentAnswer = body;
  el('current').textContent = body ? `Current answer: ${body}` : 'No answer submitted yet.';
  el('current').dataset.revision = String(revision);
}

// This diagnostic is explicit. Opening the page/reading status never enrolls
// a device, selects its record backend or instantiates the SQL engine.
window.inspectAcceptanceBrowserCapabilities = () => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./browser-sql-worker.mjs', import.meta.url), { type: 'module' });
  const timer = setTimeout(() => finish(reject, new Error('Capability probe timed out')), 20_000);
  const finish = (callback, result) => {
    clearTimeout(timer); worker.removeEventListener('message', listen); worker.terminate(); callback(result);
  };
  const listen = ({ data }) => {
    if (data?.type === 'capabilities') finish(resolve, data.report);
    else if (data?.type === 'failure') finish(reject, new Error(data.message));
  };
  worker.addEventListener('message', listen);
  worker.addEventListener('error', event => finish(reject, new Error(event.message)), { once: true });
  worker.postMessage({ type: 'capabilities' });
});

// Test deployments supply enrollment from outside the signed code graph. The owner Worker owns commands,
// signing, the relay and the pinned record backend; SQL owns a distinct OPFS VFS. The page attaches only
// through the public browser-owner protocol and observes the Worker's fixture progress on a channel.
class StartupWatch extends EventTarget {
  #channel; #abort = new AbortController(); #open;
  constructor(name, open) { super(); this.#open = open; this.#channel = new BroadcastChannel('sql-fixture-startup:' + name);
    this.#channel.addEventListener('message', ({ data }) => this.dispatchEvent(new MessageEvent('message', { data }))); }
  get signal() { return this.#abort.signal; }
  // Fixture readiness is judged by startSqlFixtureWorker; this starts the one public owner opening.
  postMessage() {
    this.#open(this.#abort.signal).then(
      () => this.dispatchEvent(new MessageEvent('message', { data: { type: 'open' } })),
      error => this.dispatchEvent(new MessageEvent('message', { data: { type: 'failure', message: error?.message ?? String(error) } })));
  }
  terminate() { this.#abort.abort(Error('SQL fixture opening terminated')); this.#channel.close(); }
}
const control = name => {
  const channel = new BroadcastChannel('sql-fixture-control:' + name);
  const request = (message, reply, ms, label) => new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(timer); channel.removeEventListener('message', listen); callback(value); };
    const listen = ({ data }) => {
      if (data?.type === reply) finish(resolve);
      else if (data?.type === 'failure') finish(reject, new Error(data.message));
    };
    const timer = setTimeout(() => finish(reject, new Error(label)), ms);
    channel.addEventListener('message', listen); channel.postMessage(message);
  });
  return { request, close: () => channel.close() };
};
let preparation;
window.prepareAcceptanceSession = options => preparation ??= (async () => {
  const { remote, channel, key, ...preparedOptions } = options;
  const stages = [];
  let attachment, workerControl;
  window.inspectAcceptanceState = () => {
    const state = session?.status, text = el('status').textContent;
    return { stages: stages.slice(), phase: state?.phase ?? null, database: state?.database ?? null, canAuthor: state?.canAuthor ?? null,
      viewReads: liveView?.reads ?? 0, connectedPeers: state?.connectedPeers ?? null, closed: session?.signal.aborted ?? null,
      display: text === 'Saving…' ? 'saving' : text.startsWith('Applied here') ? 'applied'
        : text.startsWith('Shared with') ? 'shared' : text === 'Ready' ? 'ready'
          : text.startsWith('Could not complete') ? 'failed' : 'other' };
  };
  // Test provisioning rides in the Worker URL fragment, which is never sent to any server.
  const fixture = { name: preparedOptions.name, base: window.tendril.identity.base, applicationId: window.__TENDRIL__.application.id,
    key: Array.from(key), respondent: preparedOptions.respondent, remote, channel };
  const workerUrl = new URL('./browser-sql-worker.mjs', import.meta.url); workerUrl.hash = encodeURIComponent(JSON.stringify(fixture));
  workerControl = control(preparedOptions.name);
  const watch = new StartupWatch(preparedOptions.name, signal => openBrowserOwner({ workerUrl, profileId: preparedOptions.name,
    applicationId: fixture.applicationId, requiresDedicatedWorker: true, signal,
    // Fixture-only: this one call spans the separately bounded metadata (25s) and SQL (30s) phases that
    // startSqlFixtureWorker enforces and terminates on; product session deadlines are unchanged.
    timeoutMs: 60_000 }).then(value => { attachment = value; }));
  await startSqlFixtureWorker(watch, { type: 'open' }, value => { if (stages.length < 8) stages.push(value); })
    .catch(error => { throw new Error(`${error.message}; startup stages: ${JSON.stringify(stages)}`, { cause: error }); });
  session = attachment.session;
  window.reconnectAcceptanceSession = (channel, remote) => workerControl.request({ type: 'reconnect', channel, remote },
    'reconnected', 25_000, 'Browser SQL reconnect timed out');
  window.initializeAcceptanceApplication = async () => {
    // An ordinary authorized DDL transaction, stored and materialized locally; it replicates like any operation.
    const operation = await session.command('initialize', null, { operationId: crypto.randomUUID() });
    const outcome = await operation.materialized({ signal: AbortSignal.timeout(15_000) });
    if (outcome.outcome !== 'accepted') throw new Error(`initialize rejected: ${outcome.rejectionCode ?? outcome.outcome}`);
    return outcome.outcome;
  };
  // An ordinary SQL permission transaction by the root; crypto enrollment alone grants no SQL rights.
  window.grantAcceptanceTaskUpdates = async publicKey => {
    const operation = await session.command('grantTaskUpdates', { publicKey }, { operationId: crypto.randomUUID() });
    const outcome = await operation.materialized({ signal: AbortSignal.timeout(15_000) });
    if (outcome.outcome !== 'accepted') throw new Error(`grantTaskUpdates rejected: ${outcome.rejectionCode ?? outcome.outcome}`);
    return outcome.outcome;
  };
  window.closeAcceptanceSession = async () => {
    owner.abort();
    await session.close();
    await workerControl.request({ type: 'release-engine' }, 'closed', 1500, 'release timed out').catch(() => {});
    workerControl.close(); watch.terminate();
  };
})();

window.openAcceptanceSession = async options => {
  await window.prepareAcceptanceSession(options);
  if (options.remote) await window.reconnectAcceptanceSession(options.channel, options.remote);
  const isIntake = Boolean(options.respondent);
  el('task-form').hidden = isIntake;
  el('intake').hidden = !isIntake;
  el('answer-form').hidden = !isIntake || session.identity.publicKey !== options.respondent;
  document.querySelector('h1').textContent = isIntake ? 'Private intake' : 'Shared checklist';
  if (!isIntake) {
    draftKey = `checklist-draft:${session.identity.publicKey}`;
    el('title').value = localStorage.getItem(draftKey) || '';
    if (el('title').value) el('task-draft').textContent = 'Restored draft from this device. It has not been submitted.';
  }
  liveView?.close();
  liveView = observeSqlFixture(session, { query: isIntake ? 'answer' : 'board', signal: owner.signal,
    onSnapshot: isIntake ? renderAnswer : renderTasks,
    onError(error) { if (!owner.signal.aborted) errorStatus(error); },
  });
  await liveView.ready;
  if (isIntake) selectCurrentAnswer();
  status('Ready');

};

el('title').oninput = () => {
  if (!draftKey) return;
  try {
    localStorage.setItem(draftKey, el('title').value);
    el('task-draft').textContent = el('title').value ? 'Draft saved on this device.' : '';
  } catch {
    el('task-draft').textContent = 'Draft could not be saved. Keep this page open.';
  }
};

function selectCurrentAnswer() {
  editRevision = Number(el('current').dataset.revision);
  el('answer').value = currentAnswer;
}
el('review').onclick = selectCurrentAnswer;
el('task-form').onsubmit = event => {
  event.preventDefault();
  const title = el('title').value.trim();
  if (!title) return;
  void act(async () => {
    const id = Date.now() * 1000 + nextTask++ % 1000;
    if (await submit('add', { id, title }) && el('title').value.trim() === title) {
      el('title').value = '';
      localStorage.removeItem(draftKey);
      el('task-draft').textContent = '';
    }
  });
};
el('answer-form').onsubmit = event => {
  event.preventDefault();
  void act(async () => {
    const body = el('answer').value;
    if (await submit('submit', { body, revision: editRevision })) {
      editRevision++;
    }
  });
};
