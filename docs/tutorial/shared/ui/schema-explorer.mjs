// Reactive Live Schema & Reducers Explorer for Chronolog v2 apps.
// Automatically re-renders whenever an admin, agent, or writer evolves `chronolog-db`
// tables, RLS predicates, user-owned dynamic tables, or `$reducers` ES Module bindings.

const STYLE = `.tse-root{font-size:.88rem;line-height:1.45}
.tse-grid{display:grid;gap:12px;margin-top:8px}
.tse-card{border:1px solid #cbd6cd;border-radius:8px;padding:12px;background:rgba(127,127,127,.04)}
.tse-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.tse-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600;background:rgba(20,104,77,.14)}
.tse-cols{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.tse-col{padding:2px 7px;border-radius:5px;border:1px solid #cbd6cd;font-family:ui-monospace,monospace;font-size:.78rem}
.tse-rls{font-family:ui-monospace,monospace;font-size:.76rem;opacity:.85;margin:4px 0 0;overflow-wrap:anywhere}
.tse-list{margin:6px 0 0;padding-left:18px}`;

export function mountSchemaExplorer({ root, session, sqlTopics } = {}) {
  if (!root || !session) return { refresh: async () => {}, destroy() {} };
  if (typeof document !== 'undefined' && !document.getElementById('tse-style')) {
    document.head?.append(Object.assign(document.createElement('style'), { id: 'tse-style', textContent: STYLE }));
  }
  const container = document.createElement('div');
  container.className = 'tse-root';
  root.append(container);
  let destroyed = false;

  async function refresh() {
    if (destroyed) return;
    const reducers = session.topic?.('$reducers') ?? { imports: {}, topics: {} };
    const topicMap = reducers.topics ?? {};
    const targetSqlTopics = Array.isArray(sqlTopics) && sqlTopics.length
      ? sqlTopics
      : Object.entries(topicMap)
          .filter(([name, binding]) => !name.startsWith('$') && binding?.module === 'chronolog/sql')
          .map(([name]) => name);

    const frag = document.createDocumentFragment();

    // 1. Live SQL topics
    for (const topicName of targetSqlTopics) {
      let schema = null;
      try {
        schema = (await session.query(topicName, { kind: 'schema' }))?.value ?? null;
      } catch { schema = null; }
      const section = document.createElement('div');
      section.className = 'tse-card';
      const head = document.createElement('div');
      head.className = 'tse-head';
      const title = document.createElement('strong');
      title.textContent = `SQL topic: ${topicName}`;
      const meta = document.createElement('span');
      meta.className = 'tse-badge';
      meta.textContent = schema
        ? `schema v${schema.schemaVersion ?? 0} · ${schema.allowUserDdl ? 'user DDL on' : 'admin DDL only'}`
        : 'not initialized';
      head.append(title, meta);
      section.append(head);

      const tables = Array.isArray(schema?.tables) ? schema.tables : [];
      if (!tables.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No tables materialized yet.';
        section.append(empty);
      } else {
        const grid = document.createElement('div');
        grid.className = 'tse-grid';
        for (const tbl of tables) {
          const item = document.createElement('div');
          const tHead = document.createElement('div');
          tHead.className = 'tse-head';
          const tName = document.createElement('strong');
          tName.textContent = `${tbl.name} (${tbl.type})`;
          tHead.append(tName);
          if (tbl.owner) {
            const own = document.createElement('span');
            own.className = 'tse-badge';
            own.textContent = `personal · ${tbl.owner.slice(0, 8)}…`;
            tHead.append(own);
          }
          item.append(tHead);
          if (Array.isArray(tbl.columns) && tbl.columns.length) {
            const cols = document.createElement('div');
            cols.className = 'tse-cols';
            for (const col of tbl.columns) {
              const chip = document.createElement('span');
              chip.className = 'tse-col';
              chip.textContent = col;
              cols.append(chip);
            }
            item.append(cols);
          }
          if (tbl.rls && typeof tbl.rls === 'object') {
            const rlsLine = document.createElement('div');
            rlsLine.className = 'tse-rls';
            rlsLine.textContent = `RLS: ${Object.entries(tbl.rls).map(([k, v]) => `${k}=(${v})`).join(' · ')}`;
            item.append(rlsLine);
          }
          grid.append(item);
        }
        section.append(grid);
      }
      frag.append(section);
    }

    // 2. Hash-pinned $reducers bindings
    const redCard = document.createElement('div');
    redCard.className = 'tse-card';
    const rHead = document.createElement('div');
    rHead.className = 'tse-head';
    const rTitle = document.createElement('strong');
    rTitle.textContent = 'Hash-pinned $reducers';
    const rCount = document.createElement('span');
    rCount.className = 'tse-badge';
    const appTopics = Object.entries(topicMap).filter(([name]) => !name.startsWith('$'));
    rCount.textContent = `${appTopics.length} app topic${appTopics.length === 1 ? '' : 's'}`;
    rHead.append(rTitle, rCount);
    redCard.append(rHead);
    const list = document.createElement('ul');
    list.className = 'tse-list';
    for (const [name, binding] of appTopics) {
      const li = document.createElement('li');
      const uri = reducers.imports?.[binding.module] ?? binding.module;
      li.textContent = `${name} → ${binding.module}${binding.export ? `#${binding.export}` : ''} (${String(uri).slice(0, 28)}…)`;
      list.append(li);
    }
    redCard.append(list);
    frag.append(redCard);

    if (!destroyed) container.replaceChildren(frag);
  }

  void refresh();
  const off = typeof session.onChange === 'function' ? session.onChange(() => void refresh()) : () => {};
  return Object.freeze({
    element: container,
    refresh,
    destroy() { destroyed = true; off(); container.remove(); },
  });
}
