// Hot-swappable live stage facet. An agent can edit this file and deploy a new
// publication mid-call — Tendriller diffs the atomic manifest and swaps this
// module live inside its Shadow DOM without reloading the call shell or media.
export function mount(root, ctx) {
  const style = document.createElement('style');
  style.textContent = `
    :host, .stage { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; }
    .stage { padding: 16px; display: grid; gap: 12px; }
    .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px; }
    .head h3 { margin: 0; font-size: 16px; }
    .meta { font-size: 12px; color: #64748b; }
    .canvas { min-height: 120px; border: 1px dashed #cbd5e1; border-radius: 10px; padding: 14px; background: #f8fafc; display: grid; gap: 8px; align-content: start; }
    .hint { margin: 0; font-size: 13px; color: #475569; line-height: 1.5; }
    .status { font-size: 12px; color: #0f766e; }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'stage';
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('h3');
  title.textContent = 'Live Stage';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `Publication v${ctx.version} · hot-swappable slot`;
  head.append(title, meta);

  const canvas = document.createElement('div');
  canvas.className = 'canvas';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Agents can push visualizations, whiteboards, diagrams, or summaries to facets/stage.mjs mid-call — this pane updates live without dropping video or audio.';
  const status = document.createElement('div');
  status.className = 'status';
  canvas.append(hint, status);
  wrap.append(head, canvas);
  root.append(style, wrap);

  const session = ctx.app?.session;
  const callId = ctx.app?.callId ?? 'main';
  const refresh = async () => {
    if (ctx.signal.aborted || typeof session?.query !== 'function') return;
    try {
      const state = await session.query('callState', { callId });
      if (ctx.signal.aborted) return;
      const saved = state?.utterances?.length ?? 0;
      const notes = state?.notes?.length ?? 0;
      status.textContent = `Shared Chronolog state ready · ${notes} saved note${notes === 1 ? '' : 's'} · ${saved} saved transcript line${saved === 1 ? '' : 's'}.`;
    } catch {
      if (!ctx.signal.aborted) status.textContent = 'Waiting for local Chronolog snapshot…';
    }
  };
  const off = typeof session?.onChange === 'function' ? session.onChange(() => { void refresh(); }) : () => {};
  void refresh();

  return () => { off(); };
}
