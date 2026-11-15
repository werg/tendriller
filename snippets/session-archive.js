// Owner-only workflow rollover. The service stores the archive and checks both
// revisions before clearing the selected scope; failed/conflicting requests keep it.
(() => {
  const ns = window.tendrilSnippets = window.tendrilSnippets || {};
  const labels = { notebook: 'notebook', guide: 'guide run', workshop: 'workshop', experiment: 'experiment', decisions: 'decision history', facilitation: 'group session' };
  const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), props, text == null ? {} : { textContent: text });
  function mount(target, options) {
    const host = typeof target === 'string' ? document.querySelector(target) : target, t = window.tendril;
    if (!host || !labels[options?.scope]) throw new Error('Session archive needs a host and a supported scope.');
    const scope = options.scope, name = options.title || labels[scope], base = (window.__TENDRIL__?.base || '/') + '_tendril/';
    const owner = () => t.device.role === 'owner' && !t.device.pending;
    let busy = false, reviewed = null, requestId = null, disposed = false;
    const panel = el('details', null, { className: 'session-archive' });
    const summary = el('summary', 'Keep this session and start again');
    const description = el('p', options.description || `Keep an owner-only archive of this ${name}, then make room for the next one.`);
    const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const nameLabel = el('label', 'Archive name '), title = el('input', null, { type: 'text', maxLength: 100, value: `${name[0].toUpperCase() + name.slice(1)} · ${new Date().toLocaleDateString()}` }); nameLabel.append(title);
    const actions = el('div', null, { className: 'actions' }), review = el('div', null, { hidden: true }), archives = el('div');
    const styles = el('style', '.session-archive{margin:1.25rem 0;padding:1rem;border:1px solid #b7c9bc;border-radius:.8rem;overflow-wrap:anywhere}.session-archive summary{cursor:pointer;font-weight:700}.session-archive label{display:block;margin:.75rem 0}.session-archive input{display:block;width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid #9bae9f;border-radius:.5rem;background:transparent;color:inherit}.session-archive button{font:inherit;min-height:44px;padding:.55rem .8rem;cursor:pointer}.session-archive .actions{display:flex;flex-wrap:wrap;gap:.5rem}.session-archive article{padding:.7rem 0;border-top:1px solid #b7c9bc}.session-archive [hidden]{display:none!important}.session-archive :focus-visible{outline:3px solid #b57525;outline-offset:3px}.session-archive [role=status]{min-height:1.5em}.session-archive .archive-review{padding:.8rem;background:color-mix(in srgb,currentColor 6%,transparent);border-radius:.6rem}');
    panel.append(summary, description, nameLabel, actions, review, status, el('h3', 'Saved archives'), archives); host.replaceChildren(styles, panel);
    const buttons = new Set();
    const button = (label, action) => { const node = el('button', label, { type: 'button' }); buttons.add(node); node.onclick = () => void run(action); return node; };
    function sync() { host.hidden = !owner(); panel.setAttribute('aria-busy', String(busy)); for (const button of buttons) button.disabled = busy; title.disabled = busy; }
    async function run(action) {
      if (busy || !owner() || disposed) return;
      busy = true; sync(); status.textContent = 'Working…';
      try { await action(); } catch (error) { status.textContent = `${error.message || 'Could not complete that action.'} Your work remains in the current session or a saved archive. If an archive request lost its connection, refresh saved archives before trying again.`; }
      finally { busy = false; sync(); }
    }
    async function request(path, method = 'GET', body) {
      if (!owner()) throw Error('Only the owner can manage archives.');
      const response = await fetch(base + path, { method, cache: 'no-store', credentials: 'same-origin', headers: { ...(t.deviceHeaders?.() || {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = response.status === 204 ? null : await response.json();
      if (!response.ok) { const error = Error(value?.error?.message || `Request failed (${response.status}).`); error.code = value?.error?.code; throw error; }
      if (!owner() || disposed) throw Error('Owner access changed. Open the owner page to continue.');
      return value;
    }
    function download(value, filename) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const a = el('a', null, { href: url, download: filename }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function guard() {
      if (!t.connected) throw Error('Reconnect before starting a new session.');
      const pending = t.pendingWork?.();
      if (!pending) throw Error('Update the Tendriller runtime before archiving this session.');
      if (pending.events || pending.state || pending.captures) throw Error('Wait for local messages, edits and captures to finish syncing. Retry or remove rejected captures first.');
      const reason = options.guard?.(); if (reason) throw Error(reason);
    }
    async function list() {
      const data = await request('archives'); archives.replaceChildren();
      const entries = data.archives || [];
      if (!entries.length) archives.append(el('p', 'No saved archives on this page yet.'));
      for (const item of entries) {
        const card = el('article'), controls = el('div', null, { className: 'actions' }), confirm = el('div', null, { hidden: true });
        card.append(el('strong', item.title || name), el('p', `${labels[item.scope] || item.scope} · ${new Date(item.created_at).toLocaleString()} · ${Math.max(1, Math.ceil(item.bytes / 1024))} KB`));
        controls.append(button('Download archive', async () => { download(await request(`archives/${encodeURIComponent(item.id)}`), `${scope}-${item.id}.json`); status.textContent = 'Archive download started. Media references are included; use a full bundle for media bytes.'; }), button('Remove archive…', async () => { confirm.hidden = false; confirm.querySelector('button').focus(); status.textContent = 'Review removal below. Your current session is unchanged.'; }));
        confirm.append(el('p', 'Remove this saved archive? Download it first if you want to keep a copy. This does not remove media or change the current session.'), button('Keep archive', async () => { confirm.hidden = true; status.textContent = 'Archive kept.'; }), button('Remove this archive', async () => { await request(`archives/${encodeURIComponent(item.id)}`, 'DELETE'); await list(); status.textContent = 'Archive removed. Your current session is unchanged.'; }));
        card.append(controls, confirm); archives.append(card);
      }
      archives.append(el('p', `${data.archives?.length || 0} of ${data.limit || 20} archive slots used across this page. Archives stop at ${Math.round((data.byte_limit || 8 * 1024 * 1024) / 1048576)} MiB total; older work is never silently evicted.`));
    }
    const prepare = button('Review archive and new session', async () => {
      guard(); await options.beforeReview?.(); guard();
      reviewed = await request(`archives/preview?scope=${scope}`); requestId = crypto.randomUUID();
      review.hidden = false; review.className = 'archive-review'; review.replaceChildren(el('h3', 'Review before starting again'), el('p', Object.entries(reviewed.counts || {}).map(([key, count]) => `${count} ${key.replaceAll('_', ' ')}`).join(' · ') || 'The current workflow will be kept in an owner-only archive.'),
        el('p', scope === 'guide' ? 'Your guide steps stay. Its checkpoints are archived and a new run starts at the first step.' : `The current ${name} is archived before this workflow is cleared. Other workflows on the page stay as they are.`),
        el('p', 'The server keeps the archive even if your connection drops. Media bytes stay on this page; download a full bundle if you need an independent media backup.'),
        button('Cancel new session', async () => { reviewed = null; requestId = null; review.hidden = true; status.textContent = 'Current session kept.'; }),
        button('Archive and start new session', async () => {
          guard(); if (!reviewed || !requestId) throw Error('Review the current session again.');
          const result = await request('archives', 'POST', { scope, title: title.value.trim() || name, expected_state_revision: reviewed.state_revision, expected_interaction_revision: reviewed.interaction_revision, request_id: requestId });
          reviewed = null; requestId = null; review.hidden = true;
          await options.afterArchive?.(result);
          download(result.archive, `${scope}-${result.archive.id}.json`);
          await list(); status.textContent = 'Previous session archived. Its download has started and a fresh session is ready. You can download the archive again below.';
        }));
      status.textContent = 'Review the saved counts and what will start again. Nothing has changed yet.';
      review.querySelector('button').focus();
    });
    actions.append(prepare, button('Download full data and media bundle', async () => { guard(); download(await request('bundle?include_data=true'), 'tendriller-with-media.json'); status.textContent = 'Full bundle download started. Private responses and approvals are kept separately in their archives.'; }), button('Refresh saved archives', async () => { await list(); status.textContent = 'Saved archives refreshed.'; }));
    panel.addEventListener('toggle', () => { if (panel.open && owner() && !busy) void run(list); });
    const off = t.on?.('role', () => { if (!owner()) { archives.replaceChildren(); review.replaceChildren(); review.hidden = true; reviewed = null; requestId = null; } sync(); });
    sync();
    return { refresh: () => run(list), destroy() { disposed = true; off?.(); host.replaceChildren(); } };
  }
  ns.sessionArchive = { mount };
})();
