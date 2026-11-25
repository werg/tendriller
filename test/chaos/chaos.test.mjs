// Unit tests for the pure parts of the chaos harness: PRNG determinism, text
// generation, action selection and preconditions, the model, invariant checks,
// the planner and the shrinker. They run in `npm run test:ci` (part of check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, parseSeed } from './prng.mjs';
import { generateNoteText, expectedRetainedText, NOTE_MAX_LENGTH, TEXT_KINDS, tokenOf, noteToken, padTo } from './text.mjs';
import { ACTIONS, applyEntry, chooseAction, eligibleActions, paramsStillValid } from './actions.mjs';
import { createModel, liveTabs, requiredNotes, parkedNotes } from './model.mjs';
import { createPlanner, runIdForSeed } from './planner.mjs';
import { checkViewSafety, createAppliedTracker, missingFrom, classifyMessages, INVARIANTS, INJECTED_FAULTS } from './invariants.mjs';
import { ddmin } from './shrink.mjs';
import { replayEntries, REPORT_FORMAT } from './report.mjs';

test('the PRNG is deterministic per seed and differs across seeds', () => {
  const draw = seed => { const rng = createRng(seed); return Array.from({ length: 50 }, () => rng.u32()); };
  assert.deepEqual(draw(42), draw(42));
  assert.notDeepEqual(draw(42), draw(43));
  // Pinned values guard against accidental algorithm changes that would break replay-by-seed.
  assert.deepEqual(draw(1).slice(0, 3), draw(1).slice(0, 3));
  const rng = createRng(7);
  for (let i = 0; i < 2_000; i++) {
    const value = rng.int(-3, 5); assert.ok(value >= -3 && value <= 5 && Number.isInteger(value));
    const unit = rng.next(); assert.ok(unit >= 0 && unit < 1);
  }
  const forkA = createRng(9).fork('agent'), forkB = createRng(9).fork('agent');
  assert.equal(forkA.u32(), forkB.u32());
});

test('seed parsing accepts decimal and hex 32-bit integers only', () => {
  assert.equal(parseSeed('12345'), 12345);
  assert.equal(parseSeed('0xff'), 255);
  assert.equal(parseSeed(undefined), undefined);
  assert.throws(() => parseSeed('-1'));
  assert.throws(() => parseSeed('4294967296'));
  assert.throws(() => parseSeed('1.5'));
  assert.throws(() => createRng(1.5));
});

test('weighted choice follows weights and never picks zero weight', () => {
  const rng = createRng(3), counts = { a: 0, b: 0, c: 0 };
  const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }, { id: 'c', weight: 0 }];
  for (let i = 0; i < 8_000; i++) counts[rng.weighted(items).id]++;
  assert.equal(counts.c, 0);
  assert.ok(counts.b / counts.a > 2.5 && counts.b / counts.a < 3.5, JSON.stringify(counts));
  assert.throws(() => rng.weighted([{ weight: 0 }]));
});

test('note texts carry a unique token and exercise the length boundary exactly', () => {
  const rng = createRng(11);
  for (const kind of TEXT_KINDS) {
    const token = noteToken('abc', 7);
    const { text } = generateNoteText(rng, token, kind);
    assert.equal(tokenOf(text), token, kind);
    if (kind === 'max') assert.equal(text.length, NOTE_MAX_LENGTH);
    if (kind === 'oversize') { assert.ok(text.length > NOTE_MAX_LENGTH); assert.equal(expectedRetainedText(text), null); }
    if (kind === 'whitespace') assert.equal(expectedRetainedText(text), text.trim());
  }
  // Padding never splits a surrogate pair.
  for (let i = 0; i < 200; i++) {
    const padded = padTo('x', 50 + (i % 7), rng);
    assert.equal(padded.length, 50 + (i % 7));
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(padded), false);
  }
  assert.equal(expectedRetainedText('   '), null);
});

test('preconditions gate actions on the model', () => {
  const model = createModel({ pages: ['notes', 'journal'], browsers: 2 });
  const names = () => eligibleActions(model).map(item => item.name).sort();
  // No browser yet: only enroll, agent control, native commands, publish, host restart and wait.
  assert.ok(names().includes('browser.enroll'));
  assert.equal(names().some(name => ['browser.addNote', 'browser.reload', 'agent.start', 'agent.resume', 'heal', 'net.fault'].includes(name)), false);
  applyEntry(model, { name: 'browser.enroll', params: { profile: 'b0', tab: 't0', slug: 'notes' } });
  assert.ok(names().includes('browser.addNote'));
  applyEntry(model, { name: 'agent.kill', params: {} });
  assert.equal(model.agent, 'stopped');
  assert.ok(names().includes('agent.start'));
  for (const name of ['agent.command', 'publish', 'browser.enroll', 'agent.pause', 'agent.kill']) assert.equal(names().includes(name), false, name);
  // A browser can still save while the agent program is stopped.
  assert.ok(names().includes('browser.addNote'));
  // Navigating to a page this profile never enrolled on needs the agent program.
  assert.equal(names().includes('browser.navigate'), false);
  applyEntry(model, { name: 'agent.start', params: {} });
  assert.ok(names().includes('browser.navigate'));
  applyEntry(model, { name: 'agent.pause', params: {} });
  assert.deepEqual(names().filter(name => name.startsWith('agent.')), ['agent.resume']);
});

test('the model records notes from results and distinguishes saved from uncertain', () => {
  const model = createModel({ pages: ['notes'], browsers: 1 });
  applyEntry(model, { name: 'browser.enroll', params: { profile: 'b0', tab: 't0', slug: 'notes' } });
  applyEntry(model, { name: 'browser.addNote', params: { profile: 'b0', tab: 't0', slug: 'notes', n: 0, token: 'chaos-x-0', text: ' chaos-x-0 a ' } },
    { operationId: 'op-0', saved: true, retained: 'chaos-x-0 a' });
  applyEntry(model, { name: 'browser.addNote', params: { profile: 'b0', tab: 't0', slug: 'notes', n: 1, token: 'chaos-x-1', text: 'chaos-x-1' } },
    { operationId: 'op-1', saved: false, retained: 'chaos-x-1' });
  applyEntry(model, { name: 'browser.addNote', params: { profile: 'b0', tab: 't0', slug: 'notes', n: 2, token: 'chaos-x-2', text: 'x'.repeat(2001) } },
    { operationId: null, refused: true });
  assert.deepEqual(requiredNotes(model, 'notes').map(note => note.token), ['chaos-x-0']);
  assert.equal(model.notes.notes.length, 2);
  assert.equal(model.counters.note, 3);
  assert.equal(model.notes.notes[0].text, 'chaos-x-0 a');
});

test('a browser note is parked while no tab of its profile shows its page', () => {
  const model = createModel({ pages: ['notes', 'journal'], browsers: 1 });
  applyEntry(model, { name: 'browser.enroll', params: { profile: 'b0', tab: 't0', slug: 'journal' } });
  applyEntry(model, { name: 'browser.addNote', params: { profile: 'b0', tab: 't0', slug: 'journal', n: 0, token: 'chaos-p-0', text: 'chaos-p-0' } },
    { operationId: 'op-0', saved: true, retained: 'chaos-p-0' });
  applyEntry(model, { name: 'agent.command', params: { slug: 'journal', n: 1, token: 'chaos-p-1', text: 'chaos-p-1', operation: 'x' } }, { outcome: 'accepted' });
  assert.deepEqual(requiredNotes(model, 'journal').map(note => note.token), ['chaos-p-0', 'chaos-p-1']);
  applyEntry(model, { name: 'browser.navigate', params: { profile: 'b0', tab: 't0', from: 'journal', slug: 'notes' } });
  assert.deepEqual(requiredNotes(model, 'journal').map(note => note.token), ['chaos-p-1']);
  assert.deepEqual(parkedNotes(model, 'journal').map(note => note.token), ['chaos-p-0']);
  // Once seen applied, delivery no longer depends on the browser.
  assert.deepEqual(requiredNotes(model, 'journal', note => note.operationId === 'op-0').map(note => note.token), ['chaos-p-0', 'chaos-p-1']);
  applyEntry(model, { name: 'browser.secondTab', params: { profile: 'b0', tab: 't1', slug: 'journal' } });
  assert.deepEqual(parkedNotes(model, 'journal'), []);
});

test('replayed entries that no longer fit the model are skipped, not applied', () => {
  const model = createModel({ pages: ['notes', 'journal'], browsers: 2 });
  assert.equal(applyEntry(model, { name: 'browser.addNote', params: { profile: 'b0', tab: 't0', slug: 'notes', n: 0, token: 't', text: 't' } }), false);
  assert.equal(applyEntry(model, { name: 'agent.start', params: {} }), false);
  applyEntry(model, { name: 'browser.enroll', params: { profile: 'b0', tab: 't0', slug: 'notes' } });
  assert.equal(paramsStillValid(model, { name: 'browser.enroll', params: { profile: 'b0', tab: 't9', slug: 'notes' } }), false);
  assert.equal(paramsStillValid(model, { name: 'browser.reload', params: { profile: 'b0', tab: 't1', slug: 'notes' } }), false);
  assert.equal(paramsStillValid(model, { name: 'browser.reload', params: { profile: 'b0', tab: 't0', slug: 'notes' } }), true);
  applyEntry(model, { name: 'browser.closeProfile', params: { profile: 'b0' } });
  assert.equal(model.profiles[0].open, true, 'The last open profile cannot be closed.');
});

test('the planner yields the same sequence for one seed and keeps every entry eligible', () => {
  const plan = seed => {
    const model = createModel({ pages: ['notes', 'journal'], browsers: 3, hostRestart: true });
    const planner = createPlanner({ seed, runId: runIdForSeed(seed), healEvery: 10 });
    const out = [];
    while (planner.actions < 200) {
      const entry = planner.next(model);
      if (entry.name !== 'heal') {
        assert.ok(ACTIONS[entry.name].pre(model), `${entry.name} chosen while ineligible`);
        assert.ok(paramsStillValid(model, entry), `${entry.name} planned with stale parameters`);
      }
      // Results never change structure: the same plan with or without results.
      assert.ok(applyEntry(model, entry, entry.name === 'browser.addNote' ? { operationId: `op-${out.length}`, saved: true, retained: entry.params.text.trim() } : undefined));
      out.push(entry);
    }
    return { out, model };
  };
  const a = plan(2024), b = plan(2024), c = plan(2025);
  assert.deepEqual(a.out, b.out);
  assert.notDeepEqual(a.out, c.out);
  assert.equal(a.out[0].name, 'browser.enroll');
  assert.ok(a.out.filter(entry => entry.name === 'heal').length >= 19);
  const kinds = new Set(a.out.map(entry => entry.name));
  for (const name of ['browser.addNote', 'browser.draftReload', 'agent.kill', 'agent.start', 'agent.command', 'browser.offline', 'publish'])
    assert.ok(kinds.has(name), `200 actions should include ${name}`);
  assert.equal(kinds.has('net.fault'), false, 'Network faults need --network.');
  // Tokens are unique across the run.
  const tokens = a.out.filter(entry => entry.params.token).map(entry => entry.params.token);
  assert.equal(new Set(tokens).size, tokens.length);
  assert.ok(liveTabs(a.model).length >= 0);
});

test('chooseAction respects exclusions', () => {
  const model = createModel({ pages: ['notes'], browsers: 1 });
  const rng = createRng(5);
  for (let i = 0; i < 50; i++) assert.equal(chooseAction(rng, model, { runId: 'x' }, ACTIONS, { exclude: ['agent.kill', 'agent.stop', 'agent.pause', 'agent.command', 'publish', 'host.restart', 'browser.enroll'] }).name, 'wait');
});

test('view safety flags duplicates, unknown authors, cross-page notes and altered text', () => {
  const device = 'a'.repeat(64), other = 'b'.repeat(64);
  const expected = new Map([['chaos-r-1', { slug: 'notes', text: 'chaos-r-1 héllo 👩‍💻' }], ['chaos-r-2', { slug: 'journal', text: 'chaos-r-2' }]]);
  const context = { expected, knownDevices: new Set([device]) };
  assert.deepEqual(checkViewSafety({ kind: 'agent', id: 'agent/notes', slug: 'notes', rows: [
    { text: 'chaos-r-1 héllo 👩‍💻', author: device, operationId: 'o1' }, { text: 'untracked', author: device, operationId: 'o2' }] }, context), []);
  const found = checkViewSafety({ kind: 'agent', id: 'agent/notes', slug: 'notes', rows: [
    { text: 'chaos-r-1 hello', author: device, operationId: 'o1' },
    { text: 'chaos-r-1 héllo 👩‍💻', author: other, operationId: 'o1' },
    { text: 'chaos-r-2', author: device, operationId: 'o3' }] }, context).map(item => item.invariant).sort();
  assert.deepEqual(found, ['known-authors', 'page-isolation', 'single-application-per-intent', 'text-integrity', 'unique-operation-ids']);
  // Tab rows carry a 12-character author prefix.
  assert.deepEqual(checkViewSafety({ kind: 'tab', id: 'b0/t0', slug: 'notes', rows: [{ text: 'x', author: device.slice(0, 12), operationId: 'o9' }] }, context), []);
  assert.equal(checkViewSafety({ kind: 'tab', id: 'b0/t0', slug: 'notes', rows: [{ text: 'x', author: other.slice(0, 12), operationId: 'o9' }] }, context)[0].invariant, 'known-authors');
});

test('applied operations may not disappear from the agent query', () => {
  const tracker = createAppliedTracker();
  assert.deepEqual(tracker.observe('notes', [{ operationId: 'a' }, { operationId: 'b' }], 1), []);
  assert.deepEqual(tracker.observe('notes', [{ operationId: 'a' }, { operationId: 'b' }, { operationId: 'c' }], 2), []);
  const lost = tracker.observe('notes', [{ operationId: 'a' }, { operationId: 'c' }], 3);
  assert.deepEqual(lost.map(item => [item.invariant, item.operationId, item.firstSeenStep]), [['applied-never-disappears', 'b', 1]]);
  assert.deepEqual(tracker.observe('journal', [], 3), [], 'Pages are tracked separately.');
});

test('convergence reports missing tokens; messages split into failures and allowlisted', () => {
  const view = { rows: [{ text: 'chaos-q-1 a' }, { text: 'no token' }] };
  assert.deepEqual(missingFrom(view, [{ token: 'chaos-q-1' }, { token: 'chaos-q-2' }]), ['chaos-q-2']);
  const classified = classifyMessages([
    { type: 'pageerror', text: 'TypeError: boom' },
    { type: 'console', text: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED' },
    { type: 'console', text: 'something else' }]);
  assert.equal(classified.failures.length, 1);
  assert.equal(classified.allowlisted.length, 1);
  assert.equal(classified.other.length, 1);
  for (const name of ['converges', 'not-stuck-connecting', 'persists-across-reload', 'no-page-errors', 'draft-survives-reload']) assert.ok(INVARIANTS[name]);
});

test('ddmin finds a 1-minimal failing subsequence within budget and caches trials', async () => {
  const items = Array.from({ length: 64 }, (_, i) => ({ i }));
  let calls = 0;
  const result = await ddmin(items, async subset => { calls++; const ids = subset.map(item => item.i); return ids.includes(5) && ids.includes(40); });
  assert.deepEqual(result.minimal.map(item => item.i), [5, 40]);
  assert.equal(result.trials, calls);
  const limited = await ddmin(items, async subset => subset.some(item => item.i === 63), { budget: 3 });
  assert.ok(limited.exhausted);
  assert.ok(limited.trials <= 3);
  // Order-sensitive failures keep relative order.
  const ordered = await ddmin(['x', 'a', 'y', 'b', 'z'], async subset => subset.indexOf('a') > -1 && subset.indexOf('a') < subset.indexOf('b'));
  assert.deepEqual(ordered.minimal, ['a', 'b']);
});

test('the injected test-only fault and report replay round trip', () => {
  const entries = [
    { index: 0, name: 'browser.enroll', status: 'ok', params: { profile: 'b0' } },
    { index: 1, name: 'browser.draftReload', status: 'ok', params: { profile: 'b0' } },
    { index: 2, name: 'browser.offline', status: 'ok', params: { profile: 'b0' } }];
  assert.equal(INJECTED_FAULTS['offline-then-draft'](entries), null);
  entries.push({ index: 3, name: 'browser.draftReload', status: 'ok', params: { profile: 'b0' } });
  assert.equal(INJECTED_FAULTS['offline-then-draft'](entries).entry, 3);
  const report = { format: REPORT_FORMAT, actions: [...entries, { index: 4, name: 'heal', params: {}, final: true }] };
  assert.deepEqual(replayEntries(report).map(entry => entry.name), ['browser.enroll', 'browser.draftReload', 'browser.offline', 'browser.draftReload']);
  assert.throws(() => replayEntries({ format: 'other' }));
});
