import { openBrowserOwner } from '@tendriller/core/browser-owner';
import { createApplicationBackend, createLiveView, createViewStore } from '@chronolog/peer-session';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { createOwnerConnection } from '../../shared/connection.mjs';
import { mountConnectionView } from '../../shared/connect-view.mjs';
import { mountDevices } from '../../shared/helpers/devices-view.mjs';
import { createDraftGuard } from '../../shared/helpers/live-updates.mjs';
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
const updateBtn = $('#tce-update-btn');
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
let focusedCopyEl = null;

const draftGuard = createDraftGuard({
  reason: 'Editing copy in Tendriller Copy Editor',
  isDirty() {
    const active = frame.contentDocument?.activeElement;
    const editingBoxFocused = Boolean(editing && active?.matches?.(COPY_SEL));
    return editingBoxFocused || saveTimers.size > 0 || pendingSaves.size > 0 || inflightRaw.size > 0;
  },
  async flush() {
    await flushAllEdits();
  },
});

globalThis.tendril?.publication?.onUpdate?.((update) => {
  if (update?.kind === 'reload' && update.version != null) {
    updateBtn.textContent = `Update v${update.version} · Reload`;
    updateBtn.hidden = false;
  } else {
    updateBtn.hidden = true;
  }
});

updateBtn?.addEventListener('click', async () => {
  updateBtn.disabled = true;
  try {
    await flushAllEdits();
  } catch {}
  globalThis.tendril?.publication?.update?.();
});

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
    const isRemoved = !raw.trim();
    el.setAttribute('data-copy-raw', raw);
    if (edited) el.setAttribute('data-dirty', edited.state === 'submitted' ? 'submitted' : '1');
    else el.removeAttribute('data-dirty');
    if (isRemoved) el.setAttribute('data-removed', '1');
    else el.removeAttribute('data-removed');
    el.innerHTML = isRemoved
      ? ''
      : (el.id === 'prompt-text' ? esc(substituteVars(raw)) : fmtHtml(raw));
  }
  positionBoxToolbar();
}

function renderDrawer() {
  const editRows = state.edits.map((e) =>
    `<div class="tce-diff-row"><div class="tce-diff-key"><span>${esc(e.key)}</span><button type="button" data-undo="${esc(e.key)}">Undo</button></div><div class="tce-diff-old">${esc(e.before || '(empty)')}</div><div class="tce-diff-new">${e.after ? esc(e.after) : '<em style="color:#f5b77b">(removed)</em>'}</div></div>`
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
        await draftGuard.holdWhile(async () => {
          const op = await session.command('undoEdit', { key: btn.dataset.undo }, { operationId: crypto.randomUUID() });
          await op.materialized?.().catch(() => {});
          await live?.refresh?.().catch(() => {});
        });
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
body.tce-editing [data-copy][data-copy-raw][data-removed="1"]{display:inline-block;min-width:10rem;min-height:1.4em;padding:2px 8px;outline:1.5px dashed rgba(244,124,124,.7);background:rgba(244,124,124,.10);border-radius:6px;vertical-align:middle}
body.tce-editing [data-copy][data-copy-raw][data-removed="1"]:empty::before{content:"Removed — click to edit or restore";color:#d96b6b;font:500 12px/1.4 system-ui,sans-serif;font-style:italic;pointer-events:none}
body:not(.tce-editing) [data-copy][data-copy-raw][data-removed="1"]{display:none !important}
#tce-box-bar{position:fixed;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;padding:4px 7px;border-radius:9px;background:rgba(20,33,27,.96);color:#f6f1e3;border:1px solid rgba(255,244,218,.22);box-shadow:0 8px 24px rgba(0,0,0,.45);font:500 11.5px/1 system-ui,-apple-system,sans-serif;pointer-events:auto;user-select:none}
#tce-box-bar[hidden]{display:none}
#tce-box-bar .tce-box-key{font:600 11px/1 ui-monospace,monospace;color:#9be6be;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#tce-box-bar button{appearance:none;border:1px solid rgba(255,248,232,.22);background:rgba(255,248,232,.10);color:#fff9ec;border-radius:6px;padding:4px 8px;font:650 11px/1 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
#tce-box-bar button:hover{background:rgba(255,248,232,.20)}
#tce-box-bar button.tce-del{background:rgba(220,68,68,.24);border-color:rgba(244,124,124,.55);color:#ffd4d4}
#tce-box-bar button.tce-del:hover{background:rgba(220,68,68,.42)}
#tce-box-bar button[hidden]{display:none}
</style>`;

function ensureBoxToolbar(doc) {
  let bar = doc.getElementById('tce-box-bar');
  if (bar) return bar;
  bar = doc.createElement('div');
  bar.id = 'tce-box-bar';
  bar.hidden = true;
  bar.setAttribute('contenteditable', 'false');
  bar.innerHTML = `<span class="tce-box-key"></span><button type="button" class="tce-restore" hidden>Restore</button><button type="button" class="tce-del" title="Remove this copy block (sets it empty so production omits it)">Delete box</button>`;
  // Prevent mousedown from stealing focus/blurring before click fires.
  bar.addEventListener('mousedown', (e) => { e.preventDefault(); });
  bar.querySelector('.tce-del').addEventListener('click', async () => {
    const target = focusedCopyEl;
    if (!target || !target.isConnected) return;
    target.textContent = '';
    target.setAttribute('data-removed', '1');
    await persistElementEdit(target, { formatDom: true, forceRaw: '' });
    target.blur();
    hideBoxToolbar();
  });
  bar.querySelector('.tce-restore').addEventListener('click', async () => {
    const target = focusedCopyEl;
    if (!target || !target.isConnected) return;
    const key = target.getAttribute('data-copy');
    const orig = origRaw.get(key) ?? '';
    target.textContent = orig;
    if (orig.trim()) target.removeAttribute('data-removed');
    await persistElementEdit(target, { formatDom: true, forceRaw: orig });
    target.blur();
    hideBoxToolbar();
  });
  doc.body.append(bar);
  return bar;
}

function hideBoxToolbar() {
  const doc = frame.contentDocument;
  const bar = doc?.getElementById('tce-box-bar');
  if (bar) bar.hidden = true;
  focusedCopyEl = null;
}

function positionBoxToolbar() {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return;
  const bar = doc.getElementById('tce-box-bar');
  if (!bar) return;
  if (!editing || !focusedCopyEl || !focusedCopyEl.isConnected) {
    bar.hidden = true;
    return;
  }
  const key = focusedCopyEl.getAttribute('data-copy') ?? '';
  const orig = origRaw.get(key) ?? '';
  const curText = (focusedCopyEl.textContent ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const isModified = curText !== orig || currentEditsMap().has(key);
  bar.querySelector('.tce-box-key').textContent = key;
  const restoreBtn = bar.querySelector('.tce-restore');
  restoreBtn.hidden = !isModified;
  const delBtn = bar.querySelector('.tce-del');
  delBtn.hidden = curText === '';
  bar.hidden = false;
  const rect = focusedCopyEl.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const top = rect.top > barRect.height + 10 ? rect.top - barRect.height - 6 : Math.min(win.innerHeight - barRect.height - 8, rect.bottom + 6);
  const left = Math.max(8, Math.min(win.innerWidth - barRect.width - 8, rect.right - barRect.width));
  bar.style.top = `${Math.max(6, top)}px`;
  bar.style.left = `${left}px`;
}

async function persistElementEdit(el, { formatDom = false, forceRaw } = {}) {
  const key = el.getAttribute('data-copy');
  if (!key) return;
  const existingTimer = saveTimers.get(key);
  if (existingTimer) { clearTimeout(existingTimer); saveTimers.delete(key); }
  const raw = forceRaw !== undefined
    ? String(forceRaw).replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim()
    : (el.textContent ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const before = origRaw.get(key) ?? '';
  if (raw) el.removeAttribute('data-removed');
  else el.setAttribute('data-removed', '1');
  if (formatDom) {
    el.innerHTML = raw
      ? (el.id === 'prompt-text' ? esc(substituteVars(raw)) : fmtHtml(raw))
      : '';
  }
  const current = currentEditsMap().get(key);
  const currentAfter = current ? current.after : before;
  if (raw === currentAfter && !inflightRaw.has(key)) { draftGuard.sync(); return; }
  if (!session || !canAuthor) { setStatus('Waiting for local session…'); draftGuard.sync(); return; }
  inflightRaw.set(key, raw);
  draftGuard.sync();
  const task = draftGuard.holdWhile(async () => {
    try {
      if (raw !== before) {
        setStatus(raw ? `Saving ${key}…` : `Removing ${key}…`);
        const op = await session.command('putEdit', { key, before, after: raw }, { operationId: crypto.randomUUID() });
        await op.materialized?.().catch(() => {});
        await live?.refresh?.().catch(() => {});
        setStatus(raw
          ? (connectedPeers > 0 ? 'Saved & synced via Chronolog' : 'Saved locally in Chronolog')
          : `Marked ${key} as removed`);
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
      draftGuard.sync();
    }
  });
  pendingSaves.add(task);
  task.finally(() => {
    pendingSaves.delete(task);
    draftGuard.sync();
  });
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
    ensureBoxToolbar(doc);
    focusedCopyEl = el;
    const key = el.getAttribute('data-copy');
    const edited = currentEditsMap().get(key);
    el.textContent = inflightRaw.has(key)
      ? inflightRaw.get(key)
      : edited ? edited.after : (origRaw.get(key) ?? el.textContent ?? '');
    positionBoxToolbar();
    draftGuard.sync();
  });

  doc.addEventListener('input', (e) => {
    const el = e.target.closest?.(COPY_SEL);
    if (!el || !editing) return;
    const key = el.getAttribute('data-copy');
    if (!key) return;
    const raw = (el.textContent ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
    if (raw) el.removeAttribute('data-removed');
    else el.setAttribute('data-removed', '1');
    inflightRaw.set(key, raw);
    positionBoxToolbar();
    const prev = saveTimers.get(key);
    if (prev) clearTimeout(prev);
    saveTimers.set(key, setTimeout(() => {
      saveTimers.delete(key);
      void persistElementEdit(el, { formatDom: false });
    }, 400));
    draftGuard.sync();
  });

  doc.addEventListener('focusout', (e) => {
    const el = e.target.closest?.(COPY_SEL);
    if (!el || !editing) return;
    if (focusedCopyEl === el) hideBoxToolbar();
    void persistElementEdit(el, { formatDom: true });
    draftGuard.sync();
  });

  frame.contentWindow?.addEventListener('scroll', () => positionBoxToolbar(), { passive: true });
  frame.contentWindow?.addEventListener('resize', () => positionBoxToolbar(), { passive: true });

  // Firefox may blur the iframe window without firing focusout on the inner activeElement.
  frame.contentWindow?.addEventListener('blur', () => {
    if (!editing) return;
    hideBoxToolbar();
    const active = doc.activeElement;
    if (active?.matches?.(COPY_SEL)) void persistElementEdit(active, { formatDom: true });
    draftGuard.sync();
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
    await draftGuard.holdWhile(async () => {
      const op = await session.command('submitBatch', { batchId, page: currentPath, note, edits }, { operationId: crypto.randomUUID() });
      await op.materialized?.().catch(() => {});
      await live?.refresh?.().catch(() => {});
    });
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
    });
    session = attachment.session;
    let lastSyncErr = null;
    session.onStatus?.((st) => {
      connectedPeers = st?.connectedPeers ?? 0;
      const syncErr = st?.connectionError ?? st?.error ?? st?.materializationError ?? null;
      if (syncErr) {
        lastSyncErr = String(syncErr);
        dotEl.className = 'tce-dot err';
        dotEl.title = `Sync error: ${lastSyncErr}`;
        setStatus(`Sync error (${lastSyncErr}) — saved locally, retrying…`);
      } else if (lastSyncErr) {
        lastSyncErr = null;
        if (canAuthor) {
          dotEl.className = 'tce-dot ok';
          dotEl.title = connectedPeers > 0 ? `Chronolog synced (${connectedPeers} peer${connectedPeers === 1 ? '' : 's'})` : 'Chronolog local ready (mailbox sync)';
          setStatus(connectedPeers > 0 ? 'Reconnected & synced via Chronolog' : 'Chronolog v2 ready — edits saved locally');
        }
      } else if (canAuthor) {
        dotEl.title = connectedPeers > 0 ? `Chronolog synced (${connectedPeers} peer${connectedPeers === 1 ? '' : 's'})` : 'Chronolog local ready (mailbox sync)';
      }
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
