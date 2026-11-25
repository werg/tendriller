// Pure invariant checks over observations. An observation of a view is
// { kind: 'agent' | 'tab', id, slug, rows: [{ text, operationId, author }] }.
// Tab rows carry the 12-character author prefix the notes template renders.
import { tokenOf } from './text.mjs';

export const INVARIANTS = Object.freeze({
  'unique-operation-ids': 'No operation ID appears twice in one view.',
  'single-application-per-intent': 'A submitted note (token) appears at most once per view.',
  'known-authors': 'Every row is authored by the agent device or an enrolled browser device.',
  'author-matches-submitter': 'The agent query attributes each note to the device that submitted it.',
  'agent-restarts': 'The agent program restarts and reopens every page after any stop (SIGTERM or SIGKILL).',
  'page-isolation': 'A note submitted to one page never appears in another page.',
  'text-integrity': 'A note row carries exactly the text that was saved (unicode round trip).',
  'applied-never-disappears': 'An operation once seen in the agent query stays in later agent queries.',
  'no-page-errors': 'No uncaught page errors or unhandled rejections in any tab.',
  'draft-survives-reload': 'Typed draft text survives a reload of the same tab.',
  'converges': 'At a heal phase every saved note reaches the agent query and every open tab before the deadline.',
  'not-stuck-connecting': 'At a heal phase every open tab reaches a connected, ready state before the deadline.',
  'persists-across-reload': 'At a heal phase every saved note is still shown after reloading each tab.',
  'live-update': 'At a heal phase every tab without a typed draft runs the latest confirmed UI publication.',
  'injected-fault': 'Test-only: a deliberately injected failure used to demonstrate shrinking.',
});

const authorMatches = (author, known, prefixOnly) => prefixOnly
  ? [...known].some(device => device.startsWith(author))
  : known.has(author);

/**
 * Check one view. `expected` maps token -> { slug, text } for every note the
 * model knows (saved or uncertain); `knownDevices` is a Set of full device keys.
 */
export function checkViewSafety(view, { expected, knownDevices }) {
  const violations = [];
  const seenOps = new Map(), seenTokens = new Map();
  for (const row of view.rows) {
    if (row.operationId) {
      if (seenOps.has(row.operationId)) violations.push({ invariant: 'unique-operation-ids', view: view.id, slug: view.slug, operationId: row.operationId });
      seenOps.set(row.operationId, row);
    }
    if (row.author && knownDevices.size && !authorMatches(row.author, knownDevices, view.kind === 'tab'))
      violations.push({ invariant: 'known-authors', view: view.id, slug: view.slug, author: row.author, operationId: row.operationId });
    const token = tokenOf(row.text ?? '');
    if (!token) continue;
    if (seenTokens.has(token)) violations.push({ invariant: 'single-application-per-intent', view: view.id, slug: view.slug, token,
      operationIds: [seenTokens.get(token).operationId, row.operationId] });
    seenTokens.set(token, row);
    const known = expected.get(token);
    if (!known) continue;
    if (known.slug !== view.slug) violations.push({ invariant: 'page-isolation', view: view.id, slug: view.slug, token, belongsTo: known.slug });
    else if (known.text !== undefined && known.text !== row.text)
      violations.push({ invariant: 'text-integrity', view: view.id, slug: view.slug, token,
        expectedLength: known.text.length, actualLength: row.text.length, expected: known.text.slice(0, 120), actual: row.text.slice(0, 120) });
  }
  return violations;
}

/** Tracks agent-query operation IDs per page; reports any that later vanish. */
export function createAppliedTracker() {
  const seen = new Map(); // slug -> Map(operationId -> first step)
  return {
    observe(slug, rows, step) {
      const known = seen.get(slug) ?? new Map();
      seen.set(slug, known);
      const present = new Set(rows.map(row => row.operationId));
      const violations = [...known].filter(([id]) => !present.has(id))
        .map(([operationId, since]) => ({ invariant: 'applied-never-disappears', slug, operationId, firstSeenStep: since, step }));
      for (const id of present) if (!known.has(id)) known.set(id, step);
      return violations;
    },
    size(slug) { return seen.get(slug)?.size ?? 0; },
  };
}

/**
 * Which required tokens a view still lacks. `required` is [{ token, operationId? }].
 * Returns the missing tokens (empty when converged).
 */
export function missingFrom(view, required) {
  const tokens = new Set(view.rows.map(row => tokenOf(row.text ?? '')).filter(Boolean));
  return required.filter(note => !tokens.has(note.token)).map(note => note.token);
}

/** Group page-error/console messages into hard failures vs allowlisted/benign. */
export function classifyMessages(messages, allowlist = DEFAULT_CONSOLE_ALLOWLIST) {
  const out = { failures: [], allowlisted: [], other: [] };
  for (const message of messages) {
    const allowed = allowlist.find(rule => rule.pattern.test(message.text));
    if (allowed) out.allowlisted.push({ ...message, rule: allowed.reason });
    else if (message.type === 'pageerror') out.failures.push(message);
    else out.other.push(message);
  }
  return out;
}

// Known benign browser messages under deliberate chaos (offline, killed agent,
// closed tabs). Each entry needs a reason; keep it narrow.
export const DEFAULT_CONSOLE_ALLOWLIST = Object.freeze([
  { pattern: /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/, reason: 'context.setOffline(true) blocks fetches' },
  { pattern: /net::ERR_(INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_RESET|NETWORK_CHANGED|ABORTED|EMPTY_RESPONSE)/, reason: 'deliberate offline/host restart' },
  { pattern: /WebSocket connection to .* failed/, reason: 'host restart or offline closes control sockets' },
  { pattern: /Failed to load resource: the server responded with a status of 50[234]/, reason: 'host restart window' },
  { pattern: /The service worker navigation preload request was cancelled/, reason: 'reload during navigation preload' },
]);

/** Test-only synthetic failures, used to demonstrate --shrink. Never a product signal. */
export const INJECTED_FAULTS = Object.freeze({
  // Fails at a heal if a profile went offline and later had a draft reloaded.
  'offline-then-draft': entries => {
    const offline = new Set();
    for (const entry of entries) {
      if (entry.status !== 'ok') continue;
      if (entry.name === 'browser.offline') offline.add(entry.params.profile);
      if (entry.name === 'browser.draftReload' && offline.has(entry.params.profile))
        return { detail: `profile ${entry.params.profile} reloaded a draft after going offline`, entry: entry.index };
    }
    return null;
  },
});
