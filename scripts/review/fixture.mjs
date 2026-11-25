import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/** Enumerated public consumer sources only; never copy private device stores or generated application data. */
export const REVIEW_FIXTURE_FILES = [
  ['review-app.mjs', 'plugin/review-app.mjs'],
  ['review-domain.mjs', 'plugin/review-domain.mjs'],
  ['review-local.mjs', 'plugin/review-local.mjs'],
  ['review-agent.mjs', 'plugin/review-agent.mjs'],
  ['review-setup.mjs', 'plugin/review-setup.mjs'],
  ['review-page.mjs', 'plugin/review-page.mjs'],
  ['review-worker.mjs', 'plugin/review-worker.mjs'],
  ['review-index.html', 'plugin/review-index.html'],
  // Canonical shared starter helpers, copied byte-for-byte; never maintain a second lifecycle, bootstrap,
  // preparation, publication or workspace stack. The workspace itself comes from the installed @tendriller/tools archive.
  ['support/participant-lifecycle.mjs', 'docs/tutorial/shared/participant-lifecycle.mjs'],
  ['support/native-page.mjs', 'docs/tutorial/shared/native-page.mjs'],
  ['support/prepare-host.mjs', 'docs/tutorial/shared/helpers/prepare-host.mjs'],
  ['support/publish.mjs', 'docs/tutorial/shared/publish.mjs'],
  ['support/page-provisioning.mjs', 'docs/tutorial/shared/helpers/page-provisioning.mjs'],
  ['support/browser-bootstrap.mjs', 'docs/tutorial/shared/helpers/browser-bootstrap.mjs'],
  ['support/browser-profile.mjs', 'docs/tutorial/shared/helpers/browser-profile.mjs'],
  ['support/provisioning-view.mjs', 'docs/tutorial/shared/helpers/provisioning-view.mjs'],
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

/**
 * The workspace's retained agent credential and its one page, as the cleanup handle. `id` is null when the agent
 * was registered but its page was never created or registered. Throws when no credential was retained.
 */
export function readFixtureHandle(project, slug = 'review') {
  const config = JSON.parse(readFileSync(resolve(project, 'tendriller.json'), 'utf8'));
  const credential = JSON.parse(readFileSync(resolve(project, '.tendriller/agent/credential.json'), 'utf8'));
  const id = config.pages?.[slug]?.id ?? null;
  let page = {};
  if (id !== null) try { page = JSON.parse(readFileSync(resolve(project, '.tendriller/pages', id, 'page.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let intent = null;
  try { intent = JSON.parse(readFileSync(resolve(project, '.tendriller/page-intents/' + slug + '/intent.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { id, service: credential.service, token: credential.token, signerPublicKey: credential.publicKey, intendedApplicationId: intent?.applicationId ?? null,
    api: id === null ? null : credential.service + '/api/agent/pages/' + id,
    ...(page.page_url ? { page_url: page.page_url, name: page.name, application: page.application } : {}) };
}

/** Recover the retained workspace handle even when a setup child failed after persisting it. */
export async function cleanupFixturePage({ project, origin, creationAttempted, handle, fetch: fetcher = globalThis.fetch }) {
  if (!handle && !creationAttempted) return [];
  if (!handle) {
    try { handle = readFixtureHandle(project); }
    catch { return ['Creation outcome is unknown; retain the private fixture for operator reconciliation']; }
  }
  try {
    const api = handle.id === null ? null : new URL(handle.api);
    if (api && (api.origin !== origin || api.username || api.password || api.search || api.hash ||
        !/^[a-z2-7]{12}$/.test(handle.id ?? '') || api.pathname !== '/api/agent/pages/' + handle.id) ||
        typeof handle.token !== 'string' || !/^ta_[a-z2-7]{32}$/.test(handle.token) || (handle.service ?? origin) !== origin) {
      return ['Saved fixture handle does not match the selected deployment; no cleanup request was sent'];
    }
    const remove = url => fetcher(url, { method: 'DELETE', redirect: 'error',
      headers: { Authorization: 'Bearer ' + handle.token }, signal: AbortSignal.timeout(15000) });
    if (api) {
      const response = await remove(api.href);
      if (!response.ok) return ['Could not delete the qualification-owned synthetic page'];
    } else if (handle.intendedApplicationId) {
      // Creation may have succeeded behind a lost reply. Only the exact retained application ID identifies that page.
      const found = [];
      for (let cursor = '', pages = 0; pages < 10; pages++) {
        const listed = await fetcher(origin + '/api/agent/pages' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { redirect: 'error',
          headers: { Authorization: 'Bearer ' + handle.token }, signal: AbortSignal.timeout(15000) });
        if (!listed.ok) return ['Could not inspect granted pages for the possibly created synthetic page'];
        const body = await listed.json();
        found.push(...body.pages.filter(page => page.application?.id === handle.intendedApplicationId && /^[a-z2-7]{12}$/.test(page.id ?? '')));
        if (!body.next_cursor) break; cursor = body.next_cursor;
      }
      if (found.length > 1) return ['More than one page has the retained synthetic application ID; nothing was deleted'];
      if (found.length === 1 && !(await remove(origin + '/api/agent/pages/' + found[0].id)).ok) return ['Could not delete the qualification-owned synthetic page'];
    }
    // The workspace agent is revoked with its only page.
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
