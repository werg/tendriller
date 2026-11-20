import { connectApplicationWorker } from '@chronolog/peer-session/browser';
import { startSqlFixtureWorker } from './browser-sql-startup.mjs';

const el = id => document.getElementById(id);
const status = text => { el('status').textContent = text; };
let session, editRevision = 0, currentAnswer = '', nextTask = 0, busy = false, painting = false, pending = false;
const rendered = new Map();
const owner = new AbortController();
let draftKey, latestSubmission = 0;
let operationStage = 'idle', operationStarted = 0, operationStages = [];
const operationProgress = stage => { operationStage = stage; if (operationStages.length < 8) operationStages.push({ stage, elapsedMs: performance.now() - operationStarted }); };
const errorStatus = error => status(`Could not complete the request: ${error.message}`);

async function submit(command, input) {
  const submitted = ++latestSubmission;
  operationStarted = performance.now(); operationStages = []; operationProgress('command-request');
  const operation = await session.command(command, input, { operationId: crypto.randomUUID() });
  operationProgress('applied-wait');
  const outcome = await operation.applied({ signal: AbortSignal.timeout(15_000) });
  operationProgress('applied-result');
  if (outcome.outcome === 'accepted') {
    status('Applied here. Waiting for another device to retain the change.');
    void operation.shared({ signal: owner.signal }).then(() => {
      if (submitted === latestSubmission) status('Shared with another device.');
    }, () => { /* Applied work remains visible while no retained copy is observed. */ });
  } else {
    status('Change rejected. Review the current record and try again.');
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

async function renderTasks() {
  const { value: rows } = await session.query('board', null);
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
    item.label.textContent = `${title} · ${done ? 'Done' : claimant ? claimant === session.deviceId ? 'Claimed by you' : 'Claimed by a teammate' : 'Open'}`;
    item.button.textContent = claimant === session.deviceId ? 'Complete task' : 'Claim task';
    item.button.disabled = Boolean(done || claimant && claimant !== session.deviceId);
    item.button.onclick = () => void act(() => submit(claimant ? 'finish' : 'claim', id));
  }
}

async function renderAnswer() {
  const { value: rows } = await session.query('answer', null);
  const [body, revision] = rows[0] ?? ['', 0];
  currentAnswer = body;
  el('current').textContent = body ? `Current answer: ${body}` : 'No answer submitted yet.';
  el('current').dataset.revision = String(revision);
}

async function refresh(isIntake) {
  pending = true;
  if (painting) return;
  painting = true;
  try {
    while (pending && !owner.signal.aborted) {
      pending = false;
      await (isIntake ? renderAnswer() : renderTasks());
    }
  } finally { painting = false; }
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

// Test deployments supply enrollment from outside the signed code graph.
// The Worker owns commands, signing, the relay and the pinned record backend; SQL owns a distinct OPFS VFS.
let preparation;
window.prepareAcceptanceSession = options => preparation ??= (async () => {
  const { remote, channel, ...preparedOptions } = options;
  const worker = new Worker(new URL('./browser-sql-worker.mjs', import.meta.url), { type: 'module' });
  const stages = [], activity = [];
  worker.addEventListener('message', ({ data }) => {
    if (data?.type === 'activity-progress' && ['query-start', 'query-done', 'command-start', 'command-done'].includes(data.stage)
      && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 && activity.length < 32)
      activity.push({ stage: data.stage, elapsedMs: data.elapsedMs });
  });
  window.inspectAcceptanceState = async ({ worker: inspectWorker = false } = {}) => {
    const workerState = inspectWorker ? await new Promise(resolve => {
      const finish = value => { clearTimeout(timer); worker.removeEventListener('message', listen); resolve(value); };
      const listen = ({ data }) => { if (data?.type === 'inspected-state') finish(data.state); };
      const timer = setTimeout(() => finish(null), 1_000);
      worker.addEventListener('message', listen); worker.postMessage({ type: 'inspect-state' });
    }) : null;
    const state = session?.status, text = el('status').textContent;
    return { workerState, activity: activity.slice(), stages: stages.slice(), phase: state?.phase ?? null, database: state?.database ?? null,
      connectedPeers: state?.connectedPeers ?? null, sequence: session?.revision?.point.sequence ?? null,
      closed: session?.signal.aborted ?? null,
      role: state?.role ?? null, operationStage, operationStages: operationStages.slice(),
      display: text === 'Saving…' ? 'saving' : text.startsWith('Applied here') ? 'applied'
        : text.startsWith('Shared with') ? 'shared' : text === 'Ready' ? 'ready'
          : text.startsWith('Could not complete') ? 'failed' : 'other' };
  };
  await startSqlFixtureWorker(worker, { type: 'open', base: window.tendril.identity.base,
    applicationId: window.__TENDRIL__.application.id, ...preparedOptions },
  value => { if (stages.length < 8) stages.push(value); })
    .catch(error => { throw new Error(`${error.message}; startup stages: ${JSON.stringify(stages)}`, { cause: error }); });
  session = await connectApplicationWorker(worker, { timeoutMs: 20_000 });
  window.reconnectAcceptanceSession = (channel, remote) => new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(timer); worker.removeEventListener('message', listen); callback(value); };
    const listen = ({ data }) => {
      if (data.type === 'reconnected') finish(resolve);
      if (data.type === 'failure') finish(reject, new Error(data.message));
    };
    const timer = setTimeout(() => finish(reject, new Error('Browser SQL reconnect timed out')), 25_000);
    worker.addEventListener('message', listen);
    worker.postMessage({ type: 'reconnect', channel, remote });
  });
  window.closeAcceptanceSession = async () => {
    owner.abort();
    await session.close();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1500);
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'closed') { clearTimeout(timer); resolve(); }
      });
      worker.postMessage({ type: 'release-engine' });
    });
    worker.terminate();
  };
})();

window.openAcceptanceSession = async options => {
  await window.prepareAcceptanceSession(options);
  if (options.remote) await window.reconnectAcceptanceSession(options.channel, options.remote);
  const isIntake = Boolean(options.respondent);
  el('task-form').hidden = isIntake;
  el('intake').hidden = !isIntake;
  el('answer-form').hidden = !isIntake || session.deviceId !== options.respondent;
  document.querySelector('h1').textContent = isIntake ? 'Private intake' : 'Shared checklist';
  if (!isIntake) {
    draftKey = `checklist-draft:${session.deviceId}`;
    el('title').value = localStorage.getItem(draftKey) || '';
    if (el('title').value) el('task-draft').textContent = 'Restored draft from this device. It has not been submitted.';
  }
  await refresh(isIntake);
  if (isIntake) selectCurrentAnswer();
  status('Ready');
  void (async () => {
    for await (const change of session.changes({ signal: owner.signal })) {
      if (change) await refresh(isIntake);
      if (change?.kind === 'recovery') {
        latestSubmission++;
        status('History recovered. Review changes that had not been shared.');
      }
    }
  })().catch(error => { if (!owner.signal.aborted) errorStatus(error); });

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
