import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/** Enumerated public consumer sources only; never copy private device stores or generated application data. */
export const REVIEW_FIXTURE_FILES = [
  ['review-app.mjs', 'plugin/review-app.mjs'],
  ['review-domain.mjs', 'plugin/review-domain.mjs'],
  ['review-assistant.mjs', 'plugin/review-assistant.mjs'],
  ['support/participant-lifecycle.mjs', 'docs/tutorial/shared/participant-lifecycle.mjs'],
];
export function installReviewFixtureSources(root, project) {
  for (const [file, source] of REVIEW_FIXTURE_FILES) {
    const target = resolve(project, file); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, source), target);
  }
  return REVIEW_FIXTURE_FILES.map(([file]) => file);
}

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
        !/^[a-z2-7]{12}$/.test(handle.id ?? '') || api.pathname !== '/api/agent/pages/' + handle.id ||
        typeof handle.token !== 'string' || !/^ta_[a-z2-7]{32}$/.test(handle.token)) {
      return ['Saved fixture handle does not match the selected deployment; no cleanup request was sent'];
    }
    const remove = url => fetcher(url, { method: 'DELETE', redirect: 'error',
      headers: { Authorization: 'Bearer ' + handle.token }, signal: AbortSignal.timeout(15000) });
    const response = await remove(api.href);
    if (!response.ok) return ['Could not delete the qualification-owned synthetic page'];
    // The fixture's own agent is revoked with its only page.
    const revoked = await remove(origin + '/api/agent');
    if (!revoked.ok) return ['Could not revoke the qualification-owned synthetic agent'];
    return [];
  } catch { return ['Could not delete the qualification-owned synthetic page']; }
}

/** Reject missing identities before any approval or replay comparison. */
export function validateReviewProposal(proposal) {
  assert.equal(typeof proposal?.proposed, 'string', 'Proposal identity must be a hex64 string');
  assert.match(proposal.proposed, /^[a-f0-9]{64}$/, 'Proposal identity must be a hex64 string');
  assert.equal(typeof proposal.approved, 'boolean', 'Proposal approval must be boolean');
  return proposal;
}
