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
  storage = {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
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

// Populate grouped page selector.
const pagesByPath = new Map();
const groups = new Map();
for (const p of site.pages) {
  pagesByPath.set(p.path, p);
  const gName = p.group || 'Pages';
  if (!groups.has(gName)) groups.set(gName, []);
  groups.get(gName).push(p);
}
for (const [groupLabel, items] of groups.entries()) {
  const optgroup = document.createElement('optgroup');
  optgroup.label = groupLabel;
  for (const p of items) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.label;
    optgroup.append(opt);
  }
  pageSelect.append(optgroup);
}

function readHashPage() {
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const p = params.get('page');
    return p && pagesByPath.has(p) ? p : null;
  } catch {
    return null;
  }
}

let currentPath = readHashPage() || local.readDraft('page') || '/';
if (!pagesByPath.has(currentPath)) currentPath = '/';
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

function currentPageRecord() {
  return pagesByPath.get(currentPath) ?? site.pages[0];
}

function currentVars() {
  return {
    host: site.displayHost,
    base: site.displayOrigin,
    ...(currentPageRecord()?.vars ?? {}),
  };
}

function substituteVars(raw) {
  let out = String(raw);
  for (const [k, v] of Object.entries(currentVars())) {
    if (v !== undefined) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const fmtHtml = (raw) =>
  esc(substituteVars(raw))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

const setStatus = (msg) => { statusEl.textContent = msg; };

function currentEditsMap() {
  const map = new Map();
  for (const e of state.submitted ?? []) map.set(e.key, { ...e, state: 'submitted' });
  for (const e of state.edits ?? []) map.set(e.key, { ...e, state: 'pending' });
  return map;
}

const COPY_SEL = '[data-copy][data-copy-raw]';

function syncIframeWithState() {
  const doc = frame.contentDocument;
  if (!doc) return;
  const map = currentEditsMap();
  const active = doc.activeElement;
  for (const el of doc.querySelectorAll(COPY_SEL)) {
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
      ? esc(substituteVars(raw))
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
    (editRows || '<p>Click any highlighted text on any page to edit it inline. Click navigation links (or Cmd/Ctrl+click any button link) to move between pages while keeping all edits in Chronolog.</p>') +
    (batchRows ? `<details open><summary>Sent to agent (${state.batches.length})</summary><div style="margin-top:8px">${batchRows}</div></details>` : '');
  drawer.querySelector('#tce-drawer-x')?.addEventListener('click', () => { drawer.hidden = true; });
  drawer.querySelectorAll('[data-undo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!session || !canAuthor) return;
      try {
        setStatus('Reverting…');
        const op = await session.command('undoEdit', { key: btn.dataset.undo }, { operationId: crypto.randomUUID() });
        await op.materialized?.().catch(() => {});
        await live?.refresh?.().catch(() => {});
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
body.tce-editing [data-copy][data-copy-raw]{cursor:text;border-radius:4px;transition:outline-color .12s,background-color .12s}
body.tce-editing [data-copy][data-copy-raw]:hover{outline:1.5px dashed #df5f32;outline-offset:3px}
body.tce-editing [data-copy][data-copy-raw]:focus{outline:2px solid #df5f32;outline-offset:4px;background:rgba(223,95,50,.12)}
body.tce-editing [data-copy][data-copy-raw][data-dirty="1"]{outline:1.5px solid #25a370;outline-offset:3px;background:rgba(37,163,112,.11)}
body.tce-editing [data-copy][data-copy-raw][data-dirty="submitted"]{outline:1.5px solid #59a8ff;outline-offset:3px;background:rgba(89,168,255,.11)}
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
      ? esc(substituteVars(raw))
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
        await op.materialized?.().catch(() => {});
        await live?.refresh?.().catch(() => {});
        setStatus(connectedPeers > 0 ? 'Saved & synced via Chronolog' : 'Saved locally in Chronolog');
      } else if (current) {
        const op = await session.command('undoEdit', { key }, { operationId: crypto.randomUUID() });
        await op.materialized?.().catch(() => {});
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
    const el = doc?.querySelector?.(`[data-copy="${CSS.escape(key)}"][data-copy-raw]`);
    if (el) void persistElementEdit(el, { formatDom: el !== doc?.activeElement });
  }
  if (doc?.activeElement?.matches?.(COPY_SEL)) {
    await persistElementEdit(doc.activeElement, { formatDom: true });
    doc.activeElement.blur();
  }
  if (pendingSaves.size) await Promise.all([...pendingSaves]);
  await live?.refresh?.().catch(() => {});
}

/**
 * Resolves an `<a href>` clicked inside the preview iframe into either:
 * - `{ kind: 'hash', hash }` for an in-page anchor jump,
 * - `{ kind: 'internal', path, hash }` for an editable page in `site.pages`,
 * - `{ kind: 'external', url }` for external links or non-HTML docs.
 */
function resolvePreviewHref(rawHref) {
  if (!rawHref) return null;
  if (rawHref.startsWith('#')) return { kind: 'hash', hash: rawHref };
  let url;
  try {
    url = new URL(rawHref, site.displayOrigin + '/');
  } catch {
    return null;
  }
  const displayOrigin = new URL(site.displayOrigin).origin;
  const isSameSite = url.origin === displayOrigin || url.origin === location.origin;
  if (!isSameSite) return { kind: 'external', url: url.href };

  let p = url.pathname.replace(/\/+$/, '') || '/';
  // Normalize known dynamic/sample paths to their editable preview route.
  if (p === '/sample-page' || p === '/sample-page/index.html') p = '/_tendril/manage';
  else if (p.endsWith('/_tendril/manage')) p = '/_tendril/manage';
  else if (p.endsWith('/_tendril/report')) p = '/report';
  else if (/^\/dashboard\/t\/[^/]+$/.test(p)) p = '/dashboard/activity';

  if (pagesByPath.has(p)) {
    return { kind: 'internal', path: p, hash: url.hash || '' };
  }
  // Open non-editable docs (.md, .json, /terms, /privacy, etc.) on the actual service origin in a new tab.
  return { kind: 'external', url: new URL(url.pathname + url.search + url.hash, configuration.serviceOrigin || site.displayOrigin).href };
}

function bindIframeDocument() {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.body.classList.toggle('tce-editing', editing);
  for (const el of doc.querySelectorAll(COPY_SEL)) {
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

  // Prevent real form submissions from breaking the srcdoc preview.
  doc.addEventListener('submit', (e) => {
    e.preventDefault();
    setStatus('Preview mode — form submissions are disabled in copy editor');
  }, true);

  // Seamless click-around navigation across all editable pages!
  doc.addEventListener('click', (e) => {
    const anchor = e.target.closest?.('a[href]');
    const copyTarget = e.target.closest?.(COPY_SEL);
    const forceNavigate = e.metaKey || e.ctrlKey || !editing;

    // If clicking an editable text span inside a link/button in Editing mode (without Cmd/Ctrl), focus for inline editing.
    if (editing && !forceNavigate && copyTarget && copyTarget.closest('a,button,summary')) {
      e.preventDefault();
      e.stopPropagation();
      copyTarget.focus();
      return;
    }

    if (!anchor) return;
    const resolved = resolvePreviewHref(anchor.getAttribute('href') || '');
    if (!resolved) return;

    e.preventDefault();
    e.stopPropagation();
    if (resolved.kind === 'hash') {
      const id = resolved.hash.slice(1);
      const target = id ? doc.getElementById(id) : null;
      if (target) target.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (resolved.kind === 'internal') {
      void (async () => {
        await flushAllEdits();
        loadPage(resolved.path, { hash: resolved.hash });
      })();
      return;
    }
    if (resolved.kind === 'external') {
      window.open(resolved.url, '_blank', 'noopener');
      setStatus(`Opened ${new URL(resolved.url).pathname} in a new tab`);
    }
  }, true);

  // When homepage prompt tabs switch, update origRaw & re-apply any Chronolog edits for the newly selected prompt key.
  doc.addEventListener('click', (e) => {
    const tab = e.target.closest?.('.prompt-tab');
    if (!tab) return;
    queueMicrotask(() => {
      const promptEl = doc.getElementById('prompt-text');
      if (!promptEl) return;
      const key = promptEl.getAttribute('data-copy');
      const raw = tab.getAttribute('data-prompt-raw') ?? promptEl.getAttribute('data-copy-raw');
      if (key && raw !== null && !origRaw.has(key)) {
        origRaw.set(key, raw);
      }
      syncIframeWithState();
    });
  });

  doc.addEventListener('focusin', (e) => {
    const el = e.target.closest?.(COPY_SEL);
    if (!el || !editing) return;
    const key = el.getAttribute('data-copy');
    const edited = currentEditsMap().get(key);
    el.textContent = inflightRaw.has(key)
      ? inflightRaw.get(key)
      : edited ? edited.after : (origRaw.get(key) ?? el.textContent ?? '');
  });

  doc.addEventListener('input', (e) => {
    const el = e.target.closest?.(COPY_SEL);
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
    const el = e.target.closest?.(COPY_SEL);
    if (!el || !editing) return;
    void persistElementEdit(el, { formatDom: true });
  });

  // Firefox may blur the iframe window without firing focusout on the inner activeElement.
  frame.contentWindow?.addEventListener('blur', () => {
    if (!editing) return;
    const active = doc.activeElement;
    if (active?.matches?.(COPY_SEL)) void persistElementEdit(active, { formatDom: true });
  });
}

function loadPage(path, { hash = '', pushHash = true } = {}) {
  const page = pagesByPath.get(path) ?? site.pages[0];
  currentPath = page.path;
  pageSelect.value = currentPath;
  local.writeDraft(currentPath, 'page');
  if (pushHash) {
    const targetHash = `#page=${encodeURIComponent(currentPath)}`;
    if (location.hash !== targetHash) history.pushState(null, '', targetHash);
  }
  const baseHref = new URL('./', import.meta.url).href;
  const injectedHead = `<base href="${esc(baseHref)}">${IFRAME_EDIT_CSS}`;
  const html = page.html.replace(/<head([^>]*)>/i, `<head$1>${injectedHead}`);
  frame.onload = () => {
    bindIframeDocument();
    if (hash && hash.length > 1) {
      const target = frame.contentDocument?.getElementById(hash.slice(1));
      if (target) target.scrollIntoView();
    }
  };
  frame.srcdoc = html;
  if (canAuthor) setStatus(`${page.label} — click text to edit, nav links to browse`);
}

window.addEventListener('hashchange', async () => {
  const fromHash = readHashPage();
  if (fromHash && fromHash !== currentPath) {
    await flushAllEdits();
    loadPage(fromHash, { pushHash: false });
  }
});

pageSelect.addEventListener('change', async () => {
  await flushAllEdits();
  loadPage(pageSelect.value);
});
modeBtn.addEventListener('click', () => {
  editing = !editing;
  modeBtn.classList.toggle('active', editing);
  modeBtn.textContent = editing ? 'Editing' : 'Browse';
  bindIframeDocument();
  setStatus(editing ? 'Editing mode — click text to edit, nav links or Cmd/Ctrl+click to navigate' : 'Browse mode — click any link to move across pages');
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
    await op.materialized?.().catch(() => {});
    await live?.refresh?.().catch(() => {});
    noteEl.value = '';
    local.writeDraft('', 'note');
    setStatus(connectedPeers > 0 ? `Sent to agent (${batchId})` : `Signed & queued (${batchId})`);
  } catch (err) {
    setStatus(err.message ?? String(err));
  } finally {
    sendBtn.disabled = !canAuthor;
  }
});

loadPage(currentPath, { pushHash: false });

// Connect to the real Chronolog v2 browser owner + peer participation.
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
      if (lastPhase !== 'connected') setStatus('Chronolog v2 ready — click text to edit, nav links to browse');
    } else if (s.phase === 'key-required') {
      dotEl.className = 'tce-dot';
      canAuthor = false;
      setStatus(s.title || 'Waiting for admission…');
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
      state = snapshot.value ?? { edits: [], submitted: [], batches: [] };
      syncIframeWithState();
      updateControls();
    });
    void live.ready({ timeoutMs: 30_000 }).catch(() => {});
    globalThis.tendril?.ready?.();
    return attachment;
  },
});
void connection.start().catch(() => {});
