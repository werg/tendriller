import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createApplicationBackend, createLiveView, createViewStore } from '@chronolog/peer-session';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { createOwnerConnection, reloadOnOwnerReplaced } from '../../shared/connection.mjs';
import { mountConnectionView } from '../../shared/connect-view.mjs';
import { mountDevices } from '../../shared/helpers/devices-view.mjs';
import { deriveCopyState } from './domain.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const [cfgRes, siteRes] = await Promise.all([
  fetch(new URL('./configuration.json', import.meta.url)),
  fetch(new URL('./site-pages.json', import.meta.url)),
]);
if (!cfgRes.ok) throw Error('Application configuration is unavailable');
if (!siteRes.ok) throw Error('Site preview bundle is unavailable');
const configuration = await cfgRes.json();
const site = await siteRes.json();
const profileId = browserProfileId(configuration.applicationId);

let storage, viewId;
try {
  storage = localStorage;
  viewId = sessionStorage.getItem(`${profileId}:view`) || crypto.randomUUID();
  sessionStorage.setItem(`${profileId}:view`, viewId);
} catch {
  const m = new Map();
  storage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  viewId = crypto.randomUUID();
}
const local = createViewStore({ storage, applicationId: configuration.applicationId, profileId, viewId });

const frame = $('#preview-frame');
const pageSelect = $('#tce-page');
const modeBtn = $('#tce-mode');
const diffBtn = $('#tce-diff-btn');
const countEl = $('#tce-count');
const noteEl = $('#tce-note');
const sendBtn = $('#tce-send');
const devicesBtn = $('#tce-devices-btn');
const statusEl = $('#tce-status');
const dotEl = $('#tce-dot');
const drawer = $('#tce-drawer');
const devicesPanel = $('#tce-devices');
const devicesBody = $('#tce-devices-body');

for (const p of site.pages) {
  const opt = document.createElement('option');
  opt.value = p.path;
  opt.textContent = p.label;
  pageSelect.append(opt);
}

let currentPath = local.readDraft('page') || '/';
if (!site.pages.some((p) => p.path === currentPath)) currentPath = '/';
pageSelect.value = currentPath;
noteEl.value = local.readDraft('note') || '';
noteEl.addEventListener('input', () => local.writeDraft(noteEl.value, 'note'));

let editing = true;
let session, attachment, live, devices;
let state = { edits: [], submitted: [], batches: [] };
let canAuthor = false;
let connectedPeers = 0;
const origRaw = new Map();
const inflightRaw = new Map();
const pendingSaves = new Set();
const saveTimers = new Map();

const fmtHtml = (raw) =>
  esc(raw.replaceAll('{host}', site.displayHost).replaceAll('{base}', site.displayOrigin))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

const setStatus = (msg) => { statusEl.textContent = msg; };

function currentEditsMap() {
  const map = new Map();
  for (const e of state.submitted ?? []) map.set(e.key, { ...e, state: 'submitted' });
  for (const e of state.edits ?? []) map.set(e.key, { ...e, state: 'pending' });
  return map;
}

function syncIframeWithState() {
  const doc = frame.contentDocument;
  if (!doc) return;
  const map = currentEditsMap();
  const active = doc.activeElement;
  for (const el of doc.querySelectorAll('[data-copy]')) {
    const key = el.getAttribute('data-copy');
    if (!key) continue;
    if (!origRaw.has(key)) origRaw.set(key, el.getAttribute('data-copy-raw') ?? el.textContent ?? '');
    if (el === active || inflightRaw.has(key)) continue; // Never clobber active typing or in-flight saves
    const orig = origRaw.get(key) ?? '';
    const rawEdited = map.get(key);
    // If a submitted edit's `before` no longer matches this publication's copy, the repo already applied/moved past it.
    const edited = rawEdited && !(rawEdited.state === 'submitted' && orig !== rawEdited.before) ? rawEdited : null;
    const raw = edited ? edited.after : orig;
    el.setAttribute('data-copy-raw', raw);
    if (edited) el.setAttribute('data-dirty', edited.state === 'submitted' ? 'submitted' : '1');
    else el.removeAttribute('data-dirty');
    el.innerHTML = el.id === 'prompt-text'
      ? esc(raw.replaceAll('{host}', site.displayHost).replaceAll('{base}', site.displayOrigin))
      : fmtHtml(raw);
  }
}

function renderDrawer() {
  const editRows = state.edits.map((e) =>
    `<div class="tce-diff-row"><div class="tce-diff-key"><span>${esc(e.key)}</span><button type="button" data-undo="${esc(e.key)}">Undo</button></div><div class="tce-diff-old">${esc(e.before)}</div><div class="tce-diff-new">${esc(e.after)}</div></div>`
  ).join('');
  const batchRows = state.batches.slice(-5).reverse().map((b) =>
    `<div class="tce-diff-row"><div class="tce-diff-key"><span>Sent batch ${esc(b.batchId)} (${esc(b.page)})</span><span>${b.edits.length} edit(s)</span></div>${b.note ? `<p style="margin:0 0 4px">Note: ${esc(b.note)}</p>` : ''}<p style="margin:0;font-size:11px;color:#8fa699">Op ${esc(b.operationId.slice(0, 14))}…</p></div>`
  ).join('');
  drawer.innerHTML =
    `<h3><span>Chronolog pending edits (${state.edits.length})</span><button type="button" id="tce-drawer-x">Close</button></h3>` +
    (editRows || '<p>Click any highlighted text on the page to edit it inline. Edits save locally in Chronolog immediately.</p>') +
    (batchRows ? `<details open><summary>Sent to agent (${state.batches.length})</summary><div style="margin-top:8px">${batchRows}</div></details>` : '');
  drawer.querySelector('#tce-drawer-x')?.addEventListener('click', () => { drawer.hidden = true; });
  drawer.querySelectorAll('[data-undo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!session || !canAuthor) return;
      try {
        setStatus('Reverting…');
        await session.command('undoEdit', { key: btn.dataset.undo }, { operationId: crypto.randomUUID() });
        setStatus('Reverted in Chronolog');
      } catch (err) {
        setStatus(err.message ?? String(err));
      }
    });
  });
}

function updateControls() {
  countEl.textContent = String(state.edits.length);
  sendBtn.disabled = !canAuthor;
  if (!drawer.hidden) renderDrawer();
}

const IFRAME_EDIT_CSS = `
<style id="tce-frame-style">
body.tce-editing{padding-bottom:96px}
body.tce-editing h1{white-space:normal}
body.tce-editing [data-copy]{cursor:text;border-radius:4px;transition:outline-color .12s,background-color .12s}
body.tce-editing [data-copy]:hover{outline:1.5px dashed #df5f32;outline-offset:3px}
body.tce-editing [data-copy]:focus{outline:2px solid #df5f32;outline-offset:4px;background:rgba(223,95,50,.12)}
body.tce-editing [data-copy][data-dirty="1"]{outline:1.5px solid #25a370;outline-offset:3px;background:rgba(37,163,112,.11)}
body.tce-editing [data-copy][data-dirty="submitted"]{outline:1.5px solid #59a8ff;outline-offset:3px;background:rgba(89,168,255,.11)}
</style>`;

async function persistElementEdit(el, { formatDom = false } = {}) {
  const key = el.getAttribute('data-copy');
  if (!key) return;
  const existingTimer = saveTimers.get(key);
  if (existingTimer) { clearTimeout(existingTimer); saveTimers.delete(key); }
  const raw = (el.textContent ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const before = origRaw.get(key) ?? '';
  if (formatDom) {
    el.innerHTML = el.id === 'prompt-text'
      ? esc(raw.replaceAll('{host}', site.displayHost).replaceAll('{base}', site.displayOrigin))
      : fmtHtml(raw);
  }
  const current = currentEditsMap().get(key);
  const currentAfter = current ? current.after : before;
  if (raw === currentAfter && !inflightRaw.has(key)) return;
  if (!session || !canAuthor) { setStatus('Waiting for local session…'); return; }
  inflightRaw.set(key, raw);
  const task = (async () => {
    try {
      if (raw !== before) {
        setStatus(`Saving ${key}…`);
        const op = await session.command('putEdit', { key, before, after: raw }, { operationId: crypto.randomUUID() });
        await op.inspect();
        await live?.refresh?.().catch(() => {});
        setStatus(connectedPeers > 0 ? 'Saved & synced via Chronolog' : 'Saved locally in Chronolog');
      } else if (current) {
        const op = await session.command('undoEdit', { key }, { operationId: crypto.randomUUID() });
        await op.inspect();
        await live?.refresh?.().catch(() => {});
        setStatus('Restored original copy');
      }
    } catch (err) {
      setStatus(err.message ?? String(err));
    } finally {
      if (inflightRaw.get(key) === raw) inflightRaw.delete(key);
      syncIframeWithState();
    }
  })();
  pendingSaves.add(task);
  task.finally(() => pendingSaves.delete(task));
  return task;
}

async function flushAllEdits() {
  const doc = frame.contentDocument;
  for (const [key, timer] of [...saveTimers.entries()]) {
    clearTimeout(timer);
    saveTimers.delete(key);
    const el = doc?.querySelector?.(`[data-copy="${CSS.escape(key)}"]`);
    if (el) void persistElementEdit(el, { formatDom: el !== doc?.activeElement });
  }
  if (doc?.activeElement?.hasAttribute?.('data-copy')) {
    await persistElementEdit(doc.activeElement, { formatDom: true });
    doc.activeElement.blur();
  }
  if (pendingSaves.size) await Promise.all([...pendingSaves]);
  await live?.refresh?.().catch(() => {});
}

function bindIframeDocument() {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.body.classList.toggle('tce-editing', editing);
  for (const el of doc.querySelectorAll('[data-copy]')) {
    const key = el.getAttribute('data-copy');
    if (key && !origRaw.has(key)) origRaw.set(key, el.getAttribute('data-copy-raw') ?? el.textContent ?? '');
    if (editing) {
      el.setAttribute('contenteditable', 'plaintext-only');
      if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'true');
    } else {
      el.removeAttribute('contenteditable');
    }
  }
  syncIframeWithState();

  if (doc.__tceBound) return;
  doc.__tceBound = true;

  doc.addEventListener('click', (e) => {
    if (!editing) return;
    const target = e.target.closest?.('[data-copy]');
    if (target && target.closest('a,button')) {
      e.preventDefault();
      e.stopPropagation();
      target.focus();
    }
  }, true);

  doc.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-copy]');
    if (!el || !editing) return;
    const key = el.getAttribute('data-copy');
    const edited = currentEditsMap().get(key);
    el.textContent = inflightRaw.has(key)
      ? inflightRaw.get(key)
      : edited ? edited.after : (origRaw.get(key) ?? el.textContent ?? '');
  });

  doc.addEventListener('input', (e) => {
    const el = e.target.closest?.('[data-copy]');
    if (!el || !editing) return;
    const key = el.getAttribute('data-copy');
    if (!key) return;
    const raw = (el.textContent ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
    inflightRaw.set(key, raw);
    const prev = saveTimers.get(key);
    if (prev) clearTimeout(prev);
    saveTimers.set(key, setTimeout(() => {
      saveTimers.delete(key);
      void persistElementEdit(el, { formatDom: false });
    }, 400));
  });

  doc.addEventListener('focusout', (e) => {
    const el = e.target.closest?.('[data-copy]');
    if (!el || !editing) return;
    void persistElementEdit(el, { formatDom: true });
  });

  // Firefox may blur the iframe window without firing focusout on the inner activeElement.
  frame.contentWindow?.addEventListener('blur', () => {
    if (!editing) return;
    const active = doc.activeElement;
    if (active?.hasAttribute?.('data-copy')) void persistElementEdit(active, { formatDom: true });
  });
}

function loadPage(path) {
  currentPath = path;
  local.writeDraft(path, 'page');
  const page = site.pages.find((p) => p.path === path) ?? site.pages[0];
  const baseHref = new URL('./', import.meta.url).href;
  const injectedHead = `<base href="${esc(baseHref)}">${IFRAME_EDIT_CSS}`;
  const html = page.html.replace(/<head([^>]*)>/i, `<head$1>${injectedHead}`);
  frame.onload = () => bindIframeDocument();
  frame.srcdoc = html;
}

pageSelect.addEventListener('change', async () => {
  await flushAllEdits();
  loadPage(pageSelect.value);
});
modeBtn.addEventListener('click', () => {
  editing = !editing;
  modeBtn.classList.toggle('active', editing);
  modeBtn.textContent = editing ? 'Editing' : 'Preview';
  bindIframeDocument();
  setStatus(editing ? 'Click any text to edit inline' : 'Preview mode — links work normally');
});
diffBtn.addEventListener('click', () => {
  devicesPanel.hidden = true;
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) renderDrawer();
});
devicesBtn.addEventListener('click', () => {
  drawer.hidden = true;
  devicesPanel.hidden = !devicesPanel.hidden;
});
$('#tce-devices-close').addEventListener('click', () => { devicesPanel.hidden = true; });
$('#tce-hide').addEventListener('click', () => {
  $('#tce-dock').classList.add('collapsed');
  drawer.hidden = true;
  devicesPanel.hidden = true;
});
$('#tce-expand').addEventListener('click', () => { $('#tce-dock').classList.remove('collapsed'); });

sendBtn.addEventListener('click', async () => {
  await flushAllEdits();
  const note = (noteEl.value ?? '').trim();
  const edits = state.edits.map(({ key, before, after }) => ({ key, before, after }));
  if (!edits.length && !note) { setStatus('Make an edit or type a note first'); return; }
  if (!session || !canAuthor) return;
  try {
    sendBtn.disabled = true;
    const batchId = `batch_${Date.now().toString(36)}`;
    setStatus('Committing signed batch…');
    const op = await session.command('submitBatch', { batchId, page: currentPath, note, edits }, { operationId: crypto.randomUUID() });
    await op.inspect();
    noteEl.value = '';
    local.writeDraft('', 'note');
    setStatus(connectedPeers > 0 ? `Sent to agent (${batchId})` : `Signed & queued (${batchId})`);
  } catch (err) {
    setStatus(err.message ?? String(err));
  } finally {
    sendBtn.disabled = !canAuthor;
  }
});

loadPage(currentPath);

// Connect to the real Chronolog browser owner + peer participation.
const connectionView = mountConnectionView($('#conn-banner'), { hideWhenConnected: true });
let lastPhase = null;
const connection = createOwnerConnection({
  configuration,
  appName: 'Tendriller Copy Editor',
  onState(s) {
    connectionView.render(s);
    if (s.phase === 'connected') {
      dotEl.className = 'tce-dot ok';
      canAuthor = true;
      if (lastPhase !== 'connected') setStatus('Chronolog ready — click any text to edit');
    } else if (s.phase === 'key-required') {
      dotEl.className = 'tce-dot';
      canAuthor = false;
      setStatus('Waiting for automatic agent admission…');
    } else if (s.phase === 'failed') {
      dotEl.className = 'tce-dot err';
      canAuthor = false;
      setStatus(s.title);
    } else {
      dotEl.className = 'tce-dot';
      setStatus(s.title);
    }
    lastPhase = s.phase;
    updateControls();
  },
  async connect({ signal }) {
    attachment = await openBrowserOwner({
      workerUrl: new URL('./worker.mjs', import.meta.url),
      profileId,
      applicationId: configuration.applicationId,
      context: { viewId },
      timeoutMs: 30_000,
      signal,
      onOwnerReplaced: reloadOnOwnerReplaced,
    });
    session = attachment.session;
    session.onStatus?.((st) => {
      connectedPeers = st?.connectedPeers ?? 0;
      if (st?.canAuthor && live) void live.refresh?.().catch(() => {});
    });
    if (globalThis.tendril) {
      globalThis.tendril.application?.install?.(createApplicationBackend(session));
      globalThis.tendril.signals?.install?.(session.signals);
      globalThis.tendril.transport?.install?.(session);
    }
    if (!devices) {
      devices = mountDevices({ root: devicesBody, session, pageUrl: configuration.page_url, storage });
    }
    live = createLiveView(session, deriveCopyState, {
      onError(err) {
        if (canAuthor) setStatus(err.message ?? String(err));
      },
    });
    live.subscribe((snapshot) => {
      state = snapshot.value;
      syncIframeWithState();
      updateControls();
    });
    void live.ready({ timeoutMs: 30_000 }).catch(() => {});
    globalThis.tendril?.ready?.();
    return attachment;
  },
});
void connection.start().catch(() => {});
