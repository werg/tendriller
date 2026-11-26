// URL-addressable shared notes & transcript facet (?view=notes) over the exact
// same Chronolog session as the video call.
export function mount(root, ctx) {
  const style = document.createElement('style');
  style.textContent = `
    :host, .notes { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; }
    .notes { padding: 16px; display: grid; gap: 12px; }
    .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .head h3 { margin: 0; font-size: 16px; }
    .meta { font-size: 12px; color: #64748b; }
    .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .item { padding: 10px 12px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 13px; }
    .item-meta { font-size: 11px; color: #64748b; margin-bottom: 4px; }
    .empty { margin: 0; font-size: 13px; color: #64748b; }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'notes';
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('h3');
  title.textContent = 'Shared Meeting Notes & Saved Transcript';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `v${ctx.version} · ?view=notes`;
  head.append(title, meta);

  const list = document.createElement('ul');
  list.className = 'list';
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'No saved transcript lines yet. Enable "Save transcript" during a call to persist utterances to Chronolog.';
  wrap.append(head, list, empty);
  root.append(style, wrap);

  const session = ctx.app?.session;
  const callId = ctx.app?.callId ?? 'main';
  const refresh = async () => {
    if (ctx.signal.aborted || typeof session?.query !== 'function') return;
    try {
      const state = await session.query('callState', { callId });
      if (ctx.signal.aborted) return;
      const items = state?.utterances ?? [];
      empty.hidden = items.length > 0;
      list.replaceChildren(...items.slice(-50).map(u => {
        const li = document.createElement('li');
        li.className = 'item';
        const lineMeta = document.createElement('div');
        lineMeta.className = 'item-meta';
        lineMeta.textContent = `${u.displayName || u.speakerId?.slice(0, 8) || 'Participant'} · ${new Date(u.startedAtMs).toLocaleTimeString()}`;
        const body = document.createElement('div');
        body.textContent = u.text;
        li.append(lineMeta, body);
        return li;
      }));
    } catch {}
  };
  const off = typeof session?.onChange === 'function' ? session.onChange(() => { void refresh(); }) : () => {};
  void refresh();

  return () => { off(); };
}
