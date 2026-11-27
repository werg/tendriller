// Multi-page agent federation helper: query multiple Chronolog v2 sessions in parallel
// with bounded concurrency, per-page error isolation, and revision attribution.

/**
 * Run a declared query or read-only SQL query across several Chronolog v2 pages in parallel.
 * Each entry may provide an already-open `{ page, session }` OR a lazy `{ page, open }`
 * opener returning `{ session, detach? }` (matching `withSession`).
 */
export async function queryMultipleSessions(entries, {
  query,
  input = null,
  sql,
  topic,
  params = [],
  format = 'objects',
  concurrency = 4,
  signal,
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!query && !sql) {
    throw Object.assign(new Error('Supply either "query" or "sql" to queryMultipleSessions'), { code: 'FEDERATED_QUERY_INVALID' });
  }
  const limit = Math.max(1, Math.min(16, Number(concurrency) || 4));
  const results = new Array(list.length);
  let cursor = 0;

  async function runOne(idx) {
    const entry = list[idx];
    const pageName = entry?.page ?? `page-${idx}`;
    signal?.throwIfAborted();
    let owned = null;
    try {
      const session = entry.session ?? (owned = await entry.open({ signal })).session;
      let res;
      if (sql) {
        const redTopics = session.topic?.('$reducers')?.topics ?? {};
        let targetTopic = topic;
        if (!targetTopic) {
          const sqlTopics = Object.entries(redTopics)
            .filter(([name, binding]) => !name.startsWith('$') && binding?.module === 'chronolog/sql')
            .map(([name]) => name);
          targetTopic = sqlTopics.length === 1 ? sqlTopics[0] : (sqlTopics.includes('sql') ? 'sql' : Object.keys(redTopics).find(n => !n.startsWith('$') && !n.startsWith('agent/')));
        }
        if (!targetTopic) throw Object.assign(new Error('No SQL topic found on page'), { code: 'SQL_TOPIC_NOT_FOUND' });
        res = await session.query(targetTopic, { sql, params, format });
        results[idx] = { page: pageName, ok: true, topic: targetTopic, revision: res.revision, value: res.value };
      } else {
        res = await session.query(query, input);
        results[idx] = { page: pageName, ok: true, revision: res.revision, value: res.value };
      }
    } catch (error) {
      results[idx] = {
        page: pageName,
        ok: false,
        error: { code: error?.code ?? 'query_failed', message: error?.message ?? String(error) },
      };
    } finally {
      if (owned) {
        try { await (owned.detach?.() ?? owned.close?.()); } catch {}
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      await runOne(i);
    }
  });
  await Promise.all(workers);

  return {
    results,
    succeeded: results.filter(r => r?.ok).length,
    failed: results.filter(r => r && !r.ok).length,
  };
}
