// Application-owned presentation helpers. They do not create a session or dispatch
// commands. Feed coherent query values in; confirm mutations in injected callbacks.
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, run) => {
  const node = element('button', text); node.type = 'button';
  node.addEventListener('click', run); return node;
};
let serial = 0;
const STYLE = String.raw`
.tp-workspace{display:grid;grid-template-columns:minmax(16rem,1fr) minmax(0,1.7fr);gap:1.25rem;align-items:start}
.tp-collection,.tp-inspector,.tp-state{min-width:0;background:white;border:1px solid #d7e1dc;border-radius:1rem;padding:1.25rem}
.tp-workspace label,.tp-editor label{display:grid;gap:.4rem;font-weight:600}
.tp-workspace input,.tp-workspace select,.tp-editor textarea{box-sizing:border-box;width:100%;font:inherit;padding:.7rem;border:1px solid #9aafa4;border-radius:.5rem;background:white;color:#18352a}
.tp-filters{display:grid;gap:.8rem}.tp-count,.tp-subtitle,.tp-message{color:#526b60;font-size:.92rem}
.tp-items{display:grid;gap:.6rem;list-style:none;padding:0;margin:.8rem 0 0}.tp-items a{display:block;padding:.85rem;border:1px solid #d7e1dc;border-radius:.6rem;color:inherit;text-decoration:none;overflow-wrap:anywhere}
.tp-items a[aria-current=true]{background:#eaf4ef;border-color:#24664b}.tp-items a:hover{border-color:#24664b}
.tp-items strong,.tp-items small{display:block}.tp-items small{margin-top:.3rem;color:#526b60}
.tp-inspector header{display:flex;gap:1rem;align-items:start;justify-content:space-between}.tp-inspector>header>button{flex:none;white-space:nowrap}.tp-inspector h2{min-width:0;margin:0 0 .4rem;font-size:1.45rem;overflow-wrap:anywhere}
.tp-inspector[hidden],.tp-state[hidden],.tp-workspace [hidden],.tp-editor [hidden]{display:none!important}
.tp-body{min-width:0;overflow-wrap:anywhere}.tp-body p{line-height:1.6}
.tp-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.9rem}
.tp-workspace button,.tp-editor button,.tp-state button{font:inherit;border:1px solid #9aafa4;border-radius:.5rem;padding:.65rem .9rem;background:white;color:#18352a;cursor:pointer}
.tp-workspace button:disabled,.tp-editor button:disabled{opacity:.55;cursor:default}.tp-primary{background:#1d6247!important;color:white!important;border-color:#1d6247!important}
.tp-editor textarea{min-height:6rem;resize:vertical;line-height:1.5}.tp-editor{border-top:1px solid #d7e1dc;margin-top:1.5rem;padding-top:1.25rem}
.tp-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;margin:.75rem 0}.tp-compare section{min-width:0;border-radius:.5rem;padding:.8rem;background:#f5f7f5}.tp-compare h3{font-size:.85rem;margin:0 0 .5rem;color:#526b60}.tp-compare p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.tp-compare del{background:#ffebe8;text-decoration:none}.tp-compare ins{background:#e1f3e7;text-decoration:none}
.tp-state h3{margin:0 0 .5rem}.tp-state p{margin:.4rem 0}.tp-state[data-phase=error]{border-color:#c58e7e}
.tp-workspace :focus-visible,.tp-editor :focus-visible,.tp-state :focus-visible{outline:3px solid #b76627;outline-offset:3px}
@media(max-width:640px){.tp-workspace{display:block}.tp-workspace[data-selected=true]>.tp-collection{display:none}.tp-workspace[data-selected=false]>.tp-inspector{display:none}.tp-compare{grid-template-columns:1fr}.tp-collection,.tp-inspector{padding:1rem}.tp-inspector header{gap:.5rem}}
`;
function styles() {
  if (!document.getElementById('tp-style')) document.head.append(Object.assign(element('style', STYLE), { id:'tp-style' }));
}

export function mountViewState(container) {
  styles(); const panel = element('section', undefined, 'tp-state');
  const title = element('h3'), detail = element('p'), action = button('', () => current?.action?.run());
  panel.append(title, detail, action); container.append(panel); let current;
  return {
    element: panel,
    render(state) {
      current = state; panel.hidden = state.phase === 'ready'; panel.dataset.phase = state.phase;
      panel.setAttribute('role', state.phase === 'error' ? 'alert' : 'status');
      panel.setAttribute('aria-busy', String(state.phase === 'loading'));
      title.textContent = state.title; detail.textContent = state.detail ?? '';
      action.hidden = !state.action; action.textContent = state.action?.label ?? '';
    },
    close() { panel.remove(); },
  };
}

export function mountInspector(container, { onClose = () => {} } = {}) {
  styles(); const panel = element('section', undefined, 'tp-inspector'), header = element('header');
  const heading = element('h2'), content = element('div', undefined, 'tp-body');
  heading.id = 'tp-inspector-' + ++serial; heading.tabIndex = -1;
  panel.setAttribute('aria-labelledby', heading.id);
  const back = button('Back to list', onClose); header.append(heading, back);
  panel.append(header, content); container.append(panel); panel.hidden = true;
  return {
    element: panel, content,
    show(title, { focus = false } = {}) {
      heading.textContent = title; panel.hidden = false;
      if (focus) heading.focus();
    },
    hide() { panel.hidden = true; content.replaceChildren(); },
    close() { panel.remove(); },
  };
}

export function mountComparison(container, { before, after, label = 'Review changes' }) {
  styles(); const root = element('div', undefined, 'tp-compare');
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', label);
  for (const [title, text, tag] of [['Before', before, 'del'], ['After', after, 'ins']]) {
    const section = element('section'), body = element('p');
    body.append(element(tag, text)); section.append(element('h3', title), body); root.append(section);
  }
  container.append(root); return { element:root, close() { root.remove(); } };
}

// Stateful details return { update(record), close() } and keep their instance
// for the same record ID. A cleanup-only renderer still remounts on replacement
// objects, so existing static renderers cannot silently display stale values.
export function mountListDetail(container, {
  records = [], filters = [], renderDetail, routeKey = 'item', searchLabel = 'Search records',
}) {
  styles(); const root = element('div', undefined, 'tp-workspace'), list = element('section', undefined, 'tp-collection');
  const search = element('input'); search.type = 'search';
  const searchWrap = element('label', searchLabel); searchWrap.append(search);
  const filter = element('select'), filterWrap = element('label', 'Status');
  filter.setAttribute('aria-label', 'Status');
  for (const [value, label] of [['', 'All statuses'], ...filters]) {
    const option = element('option', label); option.value = value; filter.append(option);
  }
  filterWrap.append(filter);
  const toolbar = element('div', undefined, 'tp-filters'); toolbar.append(searchWrap, filterWrap);
  const count = element('p', undefined, 'tp-count'); count.setAttribute('role', 'status');
  const items = element('ul', undefined, 'tp-items'); items.setAttribute('aria-label', 'Records');
  const state = mountViewState(list); state.element.remove();
  list.append(toolbar, count, items, state.element); root.append(list); container.append(root);
  let current = records, detail, renderedRecord, renderedRoute, closed = false;
  const disposeDetail = () => {
    const previous = detail; detail = undefined;
    if (typeof previous === 'function') previous();
    else previous?.close?.();
  };
  const keys = { item:routeKey, search:routeKey + '-search', filter:routeKey + '-status' };
  const locationState = () => {
    const params = new URL(location.href).searchParams;
    return { id:params.get(keys.item), search:params.get(keys.search) ?? '', filter:params.get(keys.filter) ?? '' };
  };
  const urlFor = updates => {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(updates)) {
      if (value) url.searchParams.set(keys[key], value); else url.searchParams.delete(keys[key]);
    }
    return url;
  };
  const navigate = (updates, replace = false, focus = false) => {
    history[replace ? 'replaceState' : 'pushState'](null, '', urlFor(updates));
    render(focus);
  };
  const focusListRecord = id => {
    const link = [...items.querySelectorAll('a')].find(node => node.dataset.id === id);
    (link ?? search).focus();
  };
  const inspector = mountInspector(root, { onClose: () => navigate({ item:null }, false, true) });
  function render(focus = false) {
    if (closed) return;
    // Capture ownership before replacing nodes. Background snapshots must not
    // steal focus from another control or another list/detail instance.
    const active = document.activeElement;
    const focusedItem = items.contains(active) ? active.closest('a[data-id]')?.dataset.id : undefined;
    const focusedDetail = inspector.element.contains(active);
    const focusedContent = inspector.content.contains(active);
    const previousId = renderedRoute?.id;
    const route = locationState(); search.value = route.search; filter.value = route.filter;
    const query = route.search.toLocaleLowerCase();
    const visible = current.filter(record => (!route.filter || record.status === route.filter)
      && [record.title, record.subtitle, record.searchText].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    count.textContent = visible.length + (visible.length === 1 ? ' record' : ' records');
    items.replaceChildren(...visible.map(record => {
      const li = element('li'), link = element('a'); link.href = urlFor({ item:record.id }).href;
      link.dataset.id = record.id; link.setAttribute('aria-current', String(record.id === route.id));
      link.append(element('strong', record.title), element('small', record.subtitle ?? record.status));
      link.addEventListener('click', event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate({ item:record.id }, false, true);
      }); li.append(link); return li;
    }));
    state.render(visible.length ? { phase:'ready' } : {
      phase:'empty', title:current.length ? 'No matching records' : 'No records yet',
      detail:current.length ? 'Try another search or clear the filters.' : 'Add your first item to begin.',
      ...(current.length && { action:{ label:'Clear filters', run:() => navigate({ search:'', filter:'' }, true) } }),
    });
    const selected = current.find(record => record.id === route.id);
    const sameRecord = selected && renderedRecord && selected.id === renderedRecord.id;
    const canUpdate = sameRecord && typeof detail?.update === 'function';
    const replacingDetail = !sameRecord || (selected !== renderedRecord && !canUpdate);
    if (replacingDetail) {
      disposeDetail(); inspector.content.replaceChildren();
    }
    root.dataset.selected = String(Boolean(route.id));
    if (selected) {
      inspector.show(selected.title, { focus:focus || (replacingDetail && focusedContent) });
      if (replacingDetail) detail = renderDetail?.(selected, inspector.content);
      else if (canUpdate) detail.update(selected);
    } else if (route.id) {
      inspector.show('Record unavailable', { focus:focus || focusedContent });
      inspector.content.append(element('p', 'This record is no longer in the current view. Return to the list.'));
    } else {
      inspector.hide(); root.dataset.selected = 'false';
    }
    if (!route.id && (focus || focusedDetail)) focusListRecord(previousId);
    else if (!focus && focusedItem !== undefined) focusListRecord(focusedItem);
    else if (!focus && root.contains(active) && !active.getClientRects().length) search.focus();
    renderedRecord = selected; renderedRoute = route;
  }
  const searchChange = () => navigate({ search:search.value }, true);
  const filterChange = () => navigate({ filter:filter.value }, false);
  const historyChange = () => render(renderedRoute !== undefined && locationState().id !== renderedRoute.id);
  search.addEventListener('input', searchChange); filter.addEventListener('change', filterChange);
  window.addEventListener('popstate', historyChange); render();
  return {
    element:root,
    setRecords(value) { current = value; render(); },
    close() {
      if (closed) return;
      closed = true;
      try { disposeDetail(); }
      finally { window.removeEventListener('popstate', historyChange); root.remove(); }
    },
  };
}

// onSave/onUndo must resolve { confirmed:true, value:string } only after an
// accepted applied result. observe() supplies coherent snapshot values, never
// operation outcomes. Only explicit reconcile() can unlock uncertain work.
export function mountInlineReview(container, { label, value, onSave, onUndo }) {
  styles(); const root = element('section', undefined, 'tp-editor'), field = element('textarea');
  const fieldLabel = element('label', label); fieldLabel.append(field);
  const comparison = element('div'), message = element('p', undefined, 'tp-message');
  const conflict = element('p', undefined, 'tp-message');
  message.setAttribute('role', 'status'); conflict.setAttribute('role', 'status');
  const actions = element('div', undefined, 'tp-actions');
  let baseline = value, observed = value, observation = 0, previous, reviewed;
  let busy = false, blocked = false, disposed = false;
  field.value = value;
  const review = button('Review changes', () => {
    if (disposed || busy || blocked) return;
    // This explicit review, not an incoming snapshot, accepts a changed baseline.
    if (observed !== baseline) { baseline = observed; previous = undefined; }
    reviewed = field.value; comparison.replaceChildren();
    mountComparison(comparison, { before:baseline, after:reviewed }); update();
  });
  const save = button('Save reviewed change', () => void commit(false)); save.className = 'tp-primary';
  const cancel = button('Discard draft', () => {
    if (disposed || busy || blocked) return;
    if (observed !== baseline) previous = undefined;
    baseline = observed; field.value = baseline; reviewed = undefined;
    comparison.replaceChildren(); message.textContent = ''; update();
  });
  const undo = button('Undo saved change', () => void commit(true));
  actions.append(review, save, cancel, undo); root.append(fieldLabel, comparison, actions, message, conflict); container.append(root);
  async function commit(revert) {
    if (disposed || busy || blocked || observed !== baseline || (revert ? previous === undefined : reviewed === undefined)) return;
    const before = baseline, after = revert ? previous : reviewed, startedObservation = observation;
    busy = true; message.textContent = 'Waiting for confirmation…'; update();
    try {
      const result = await (revert ? onUndo : onSave)({ before, after });
      if (result?.confirmed !== true || typeof result.value !== 'string') throw Error('The change has not been confirmed.');
      if (disposed) return;
      previous = revert ? undefined : before; baseline = result.value; field.value = baseline;
      // The callback can confirm before the live view observes this write. Do not
      // treat the pre-dispatch snapshot as a concurrent edit. A snapshot received
      // during the callback remains visible if it differs from its result.
      if (observation === startedObservation) observed = baseline;
      reviewed = undefined; comparison.replaceChildren(); message.textContent = revert ? 'Saved change undone.' : 'Change saved.';
    } catch {
      if (disposed) return;
      blocked = true; message.textContent = 'Change not confirmed. Inspect the original operation before continuing.';
    } finally { busy = false; if (!disposed) update(); }
  }
  function update() {
    const changed = observed !== baseline;
    field.disabled = busy || blocked;
    review.disabled = busy || blocked || field.value === observed;
    save.hidden = reviewed === undefined; save.disabled = busy || blocked || changed;
    cancel.disabled = busy || blocked || (field.value === baseline && !changed);
    undo.hidden = previous === undefined || !onUndo;
    undo.disabled = busy || blocked || changed || field.value !== baseline;
    conflict.hidden = !changed;
    conflict.textContent = !changed ? '' : busy
      ? 'The saved value changed while confirmation is pending.'
      : blocked ? 'The latest value changed. Inspect the original operation before continuing.'
        : 'The saved value changed. Review your draft against the latest value or discard it.';
  }
  field.addEventListener('input', () => { reviewed = undefined; comparison.replaceChildren(); message.textContent = ''; update(); });
  update();
  return {
    element:root,
    observe(currentValue) {
      if (disposed) return;
      if (currentValue === observed) {
        // A coalesced snapshot can restore the old value without observing the
        // intermediate write. Its arrival still fences a pending confirmation.
        if (busy) observation++;
        return;
      }
      if (typeof currentValue !== 'string') throw TypeError('Expected a coherent string value.');
      observed = currentValue; observation++;
      if (!busy && !blocked) {
        if (field.value === baseline && reviewed === undefined && previous === undefined) {
          baseline = currentValue; field.value = currentValue; message.textContent = 'Value updated from the latest snapshot.';
        } else { reviewed = undefined; comparison.replaceChildren(); }
      }
      update();
    },
    reconcile(confirmedValue) {
      if (disposed) return;
      if (busy) throw Error('Wait for the outstanding callback before reconciliation.');
      baseline = observed = confirmedValue; field.value = confirmedValue; previous = reviewed = undefined;
      blocked = false; comparison.replaceChildren(); message.textContent = ''; update();
    },
    close() { disposed = true; root.remove(); },
  };
}
