import { connectApplicationWorker } from '@chronolog/peer-session/browser';

const el = id => document.getElementById(id);
const status = text => { el('status').textContent = text; };
let session, editRevision = 0, currentAnswer = '', nextTask = 0, busy = false, painting = false, pending = false;
const rendered = new Map();
const owner = new AbortController();
const errorStatus = error => status(`Could not complete the request: ${error.message}`);

async function submit(command, input) {
  const operation = await session.command(command, input, { operationId: crypto.randomUUID() });
  const outcome = await operation.applied({ signal: AbortSignal.timeout(15_000) });
  status(outcome.outcome === 'accepted' ? 'Saved' : 'Change rejected. Review the current record and try again.');
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

// Test deployments supply enrollment from outside the signed code graph.
// The Worker owns commands, signing, the relay and OPFS.
window.openAcceptanceSession = async options => {
  const worker = new Worker(new URL('./browser-sql-worker.mjs', import.meta.url), { type: 'module' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser SQL Worker did not open within 25 seconds')), 25_000);
    const finish = (callback, value) => { clearTimeout(timer); callback(value); };
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'open') finish(resolve);
      if (data.type === 'failure') finish(reject, new Error(data.message));
    });
    worker.addEventListener('error', event => finish(reject, new Error(event.message)), { once: true });
    worker.postMessage({ type: 'open', base: window.tendril.identity.base,
      applicationId: window.__TENDRIL__.application.id, ...options });
  }).catch(error => { worker.terminate(); throw error; });
  session = await connectApplicationWorker(worker, { timeoutMs: 20_000 });
  const isIntake = Boolean(options.respondent);
  el('task-form').hidden = isIntake;
  el('intake').hidden = !isIntake;
  el('answer-form').hidden = !isIntake || session.deviceId !== options.respondent;
  document.querySelector('h1').textContent = isIntake ? 'Private intake' : 'Shared checklist';
  await refresh(isIntake);
  if (isIntake) selectCurrentAnswer();
  status('Ready');
  void (async () => {
    for await (const change of session.changes({ signal: owner.signal })) {
      if (change) await refresh(isIntake);
    }
  })().catch(error => { if (!owner.signal.aborted) errorStatus(error); });
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
    if (await submit('add', { id, title })) el('title').value = '';
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
