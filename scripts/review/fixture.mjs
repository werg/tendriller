import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function restoreFixtureCreationMode(db) {
  db("UPDATE service_state SET mode='creation_paused' WHERE id=1 AND mode='open'");
  if (db('SELECT mode FROM service_state WHERE id=1').results[0]?.mode !== 'creation_paused') {
    throw Error('Staging mode restoration needs operator review');
  }
}

/** Recover a saved handle even when the create child failed after persisting it. */
export async function cleanupFixturePage({ project, origin, creationAttempted, handle, fetch: fetcher = globalThis.fetch }) {
  if (!handle && !creationAttempted) return [];
  if (!handle) {
    try { handle = JSON.parse(readFileSync(resolve(project, '.private/handle.json'), 'utf8')); }
    catch { return ['Creation outcome is unknown; retain the private fixture for operator reconciliation']; }
  }
  try {
    const api = new URL(handle.api);
    if (api.origin !== origin || api.username || api.password || api.search || api.hash ||
        !/^[a-z2-7]{12}$/.test(handle.id ?? '') || api.pathname !== '/api/t/' + handle.id ||
        typeof handle.token !== 'string' || !handle.token) {
      return ['Saved fixture handle does not match the selected deployment; no cleanup request was sent'];
    }
    const response = await fetcher(api.href, { method: 'DELETE', redirect: 'error',
      headers: { Authorization: 'Bearer ' + handle.token }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return ['Could not delete the qualification-owned synthetic page'];
    return [];
  } catch { return ['Could not delete the qualification-owned synthetic page']; }
}
