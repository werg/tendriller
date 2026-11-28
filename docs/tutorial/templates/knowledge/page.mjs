import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createLiveView, createViewStore } from '@chronolog/peer-session/browser';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { mountDevices } from '../../shared/helpers/devices-view.mjs';
import { mountGovernanceBanner } from '../../shared/helpers/governance.mjs';
import { enableHostedMcp } from '../../shared/helpers/hosted-mcp.mjs';
import { deriveKnowledge } from './domain.mjs';
import { liveViewKey, persistedSnapshot } from '../../shared/helpers/persisted-view.mjs';

const $ = sel => document.querySelector(sel);
const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(r => {
  if (!r.ok) throw Error('Configuration unavailable');
  return r.json();
});
const profileId = browserProfileId(configuration.applicationId);
let storage, viewId;
try {
  storage = localStorage;
  viewId = sessionStorage.getItem(`${profileId}:view`) || crypto.randomUUID();
  sessionStorage.setItem(`${profileId}:view`, viewId);
} catch {
  const m = new Map();
  storage = { get length() { return m.size; }, key: i => [...m.keys()][i], getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
  viewId = crypto.randomUUID();
}
const local = createViewStore({ storage, applicationId: configuration.applicationId, profileId, viewId });
const viewKey = liveViewKey(storage, profileId, 'knowledge');
const readDraft = (k, fb) => { try { return local.readDraft(k) ?? fb; } catch { return fb; } };
const writeDraft = (k, v) => { try { local.writeDraft(v, k); } catch {} };

let session, attachment, live, devices, govBanner, hostedMcp;
let activeTag = '';
let canWrite = false;

const draft = readDraft('draft', {});
for (const id of ['mem-id', 'mem-title', 'mem-body', 'mem-tags']) {
  const el = $('#' + id);
  el.value = draft[id] ?? '';
  el.addEventListener('input', () => { draft[id] = el.value; writeDraft('draft', draft); });
}

function setWriteEnabled(enabled) {
  canWrite = enabled;
  for (const btn of document.querySelectorAll('[data-write]')) btn.disabled = !enabled;
}

function renderResults(snapshot) {
  const data = snapshot.value;
  if (!snapshot.stale) $('#view-error').hidden = true;
  $('#init-banner').hidden = data.initialized;
  $('#summary').textContent = data.initialized
    ? `${data.items.length} shown of ${data.total} memories · mode: ${data.mode} · rev ${snapshot.revision.digest.slice(0, 10)}${snapshot.stale ? ' · saved on this device, refreshing' : ''}`
    : 'Database not initialized yet — click Initialize memory database to create FTS5 + sqlite-vec tables.';

  const tagButtons = [
    (() => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pill'; b.textContent = 'All';
      b.setAttribute('aria-pressed', String(activeTag === ''));
      b.onclick = () => { activeTag = ''; void refreshSearch(); };
      return b;
    })(),
    ...data.tags.map(t => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pill'; b.textContent = `#${t.name} (${t.count})`;
      b.setAttribute('aria-pressed', String(activeTag === t.name));
      b.onclick = () => { activeTag = activeTag === t.name ? '' : t.name; void refreshSearch(); };
      return b;
    }),
  ];
  $('#tag-bar').replaceChildren(...tagButtons);

  if (!data.items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = data.initialized ? 'No matching memories yet.' : '';
    $('#results').replaceChildren(empty);
    return;
  }

  const cards = data.items.map(item => {
    const card = document.createElement('article');
    card.className = 'mem';
    const h3 = document.createElement('h3');
    h3.textContent = item.title;
    const p = document.createElement('p');
    p.textContent = item.body;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [item.id];
    if (item.tags.length) parts.push(item.tags.map(t => `#${t}`).join(' '));
    if (item.score !== null) parts.push(`score ${item.score.toFixed(4)}`);
    if (item.vectorDistance !== null) parts.push(`vec dist ${item.vectorDistance.toFixed(3)}`);
    meta.textContent = parts.join(' · ');

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.style.marginTop = '8px';
    const editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'secondary'; editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      $('#mem-id').value = item.id;
      $('#mem-title').value = item.title;
      $('#mem-body').value = item.body;
      $('#mem-tags').value = item.tags.join(', ');
      for (const id of ['mem-id', 'mem-title', 'mem-body', 'mem-tags']) draft[id] = $('#' + id).value;
      writeDraft('draft', draft);
      $('#mem-title').focus();
    };
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'secondary'; delBtn.textContent = 'Delete';
    delBtn.dataset.write = '';
    delBtn.disabled = !canWrite;
    delBtn.onclick = () => void runCommand('deleteMemory', { id: item.id });
    actions.append(editBtn, delBtn);
    card.append(h3, p, meta, actions);
    return card;
  });
  $('#results').replaceChildren(...cards);
}

async function refreshSearch() {
  if (!session) return;
  const view = await session.readView();
  try {
    const value = await deriveKnowledge(view, {
      query: $('#search-q').value,
      mode: $('#search-mode').value,
      tag: activeTag,
    });
    renderResults({ revision: view.revision, value });
  } catch (err) {
    $('#view-error').hidden = false;
    $('#view-error').textContent = err.message ?? String(err);
  } finally {
    await view.release();
  }
}

async function runCommand(name, input) {
  if (!session) return;
  $('#status').textContent = `Submitting ${name}…`;
  try {
    const op = await session.command(name, input, { operationId: crypto.randomUUID() });
    const inspected = await op.inspect();
    $('#status').textContent = `Stored ${name} (${inspected.materialized?.outcome ?? 'pending'})`;
    await refreshSearch();
  } catch (err) {
    $('#status').textContent = err.message ?? String(err);
  }
}

$('#search-q').addEventListener('input', () => void refreshSearch());
$('#search-mode').addEventListener('change', () => void refreshSearch());
$('#init-btn').addEventListener('click', () => void runCommand('initialize', null));
$('#mem-clear').addEventListener('click', () => {
  for (const id of ['mem-id', 'mem-title', 'mem-body', 'mem-tags']) { $('#' + id).value = ''; draft[id] = ''; }
  writeDraft('draft', draft);
});
$('#mem-form').addEventListener('submit', e => {
  e.preventDefault();
  const id = $('#mem-id').value.trim() || `mem-${crypto.randomUUID().slice(0, 8)}`;
  const title = $('#mem-title').value.trim();
  const body = $('#mem-body').value.trim();
  const tags = $('#mem-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!title || !body) return;
  void runCommand('upsertMemory', { id, title, body, tags });
});

// Stale-while-revalidate first paint: this device's last snapshot, before the Worker opens.
{ const saved = persistedSnapshot(viewKey, storage); if (saved) try { renderResults(saved); } catch { /* repainted by the live view */ } }

try {
  attachment = await openBrowserOwner({
    workerUrl: new URL('./worker.mjs', import.meta.url),
    profileId,
    applicationId: configuration.applicationId,
    configuration,
    requiresDedicatedWorker: true,
    context: { viewId },
    timeoutMs: 30_000,
  });
  session = attachment.session;
  govBanner = mountGovernanceBanner({ root: $('#governance-slot'), session });
  hostedMcp = enableHostedMcp({ session, label: 'Knowledge & AI Memory' });
  devices = mountDevices({ root: $('#devices'), session });
  const adm = await session.extensions.call('admission.state', []).catch(() => null);
  setWriteEnabled(adm ? adm.canWrite !== false : true);
  $('#session-status').textContent = 'Local encrypted database ready (offline-capable).';
  live = createLiveView(
    session,
    view => deriveKnowledge(view, { query: $('#search-q').value, mode: $('#search-mode').value, tag: activeTag }),
    {
      persistKey: viewKey,
      storage,
      onError(err) { $('#view-error').hidden = false; $('#view-error').textContent = err.message ?? String(err); },
    },
  );
  live.subscribe(renderResults);
} catch (err) {
  $('#session-status').textContent = `Could not open local session: ${err.message ?? String(err)}`;
}
