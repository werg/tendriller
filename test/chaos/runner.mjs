// Executes a chaos plan (generated from a seed, or replayed from a log) against
// an opened world, checking safety after every action and liveness at heals.
import { ACTIONS, applyEntry, paramsStillValid } from './actions.mjs';
import { createModel, liveTabs, requiredNotes, parkedNotes, allNotes } from './model.mjs';
import { checkViewSafety, createAppliedTracker, missingFrom, classifyMessages, INJECTED_FAULTS } from './invariants.mjs';
export { INJECTED_FAULTS };
import { EXECUTORS, CONNECTED, createRuntime, watchPage, poll, readAgentRows, readTabRows, readTabState, waitReady } from './driver.mjs';
import { uiMarker } from './environment.mjs';
import { tokenOf } from './text.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clip = (value, limit = 4_000) => { const text = JSON.stringify(value); return text && text.length > limit ? `${text.slice(0, limit)}…` : value; };

/**
 * @param {object} options
 * @param {object} options.world opened environment
 * @param {object} options.config { browsers, pages, healEvery, steps, durationMs, healDeadlineMs, network, hostRestart, failFast }
 * @param {object} [options.planner] seed planner (generated mode)
 * @param {object[]} [options.replay] entries to replay exactly
 */
export async function runChaos({ world, config, planner, replay, injectFault, log = console.log }) {
  const model = createModel({ pages: Object.keys(world.golden.pages), browsers: config.browsers,
    network: config.network, hostRestart: config.hostRestart });
  const runtime = createRuntime();
  for (const page of Object.values(world.golden.pages)) runtime.knownDevices.add(page.nativeDeviceId);
  const tracker = createAppliedTracker();
  const entries = [], violations = [], convergence = [], snapshots = {};
  const started = Date.now();
  const invariantChecks = {};
  const count = name => { invariantChecks[name] = (invariantChecks[name] ?? 0) + 1; };
  const fail = (list, entry) => {
    for (const violation of list) {
      violation.step = entry?.index ?? null; violation.action = entry?.name ?? null;
      violations.push(violation);
      log(`chaos VIOLATION ${violation.invariant} at #${violation.step} ${violation.action}: ${JSON.stringify(violation).slice(0, 400)}`);
    }
  };
  const expectedMap = () => {
    const map = new Map();
    for (const note of allNotes(model)) {
      const author = note.origin === 'native' ? world.golden.pages[note.slug].nativeDeviceId : runtime.deviceOf.get(`${note.profile}/${note.slug}`);
      map.set(note.token, { slug: note.slug, text: note.text, author });
    }
    return map;
  };

  async function sweep(entry) {
    const expected = expectedMap();
    const context = { expected, knownDevices: runtime.knownDevices };
    const found = [];
    for (const { profile, tab } of liveTabs(model)) {
      const page = runtime.profiles.get(profile.id)?.tabs.get(tab.id);
      if (!page || page.isClosed()) continue;
      const rows = await readTabRows(page).catch(() => null);
      if (!rows) continue;
      count('unique-operation-ids'); count('single-application-per-intent'); count('known-authors'); count('page-isolation'); count('text-integrity');
      found.push(...checkViewSafety({ kind: 'tab', id: `${profile.id}/${tab.id}`, slug: tab.slug, rows }, context));
    }
    if (model.agent === 'running') for (const slug of model.config.pages) {
      const rows = await readAgentRows(world, slug).catch(error => { entry.notes = [...(entry.notes ?? []), `agent query ${slug}: ${error.message.slice(0, 200)}`]; return null; });
      if (!rows) continue;
      count('applied-never-disappears'); count('single-application-per-intent');
      found.push(...checkViewSafety({ kind: 'agent', id: `agent/${slug}`, slug, rows }, context));
      found.push(...tracker.observe(slug, rows, entry.index));
      found.push(...authorship(slug, rows, expected));
    }
    const errors = runtime.messages.filter(message => message.type === 'pageerror' && !message.reported);
    for (const message of errors) message.reported = true;
    const classified = classifyMessages(errors, config.allowlist);
    count('no-page-errors');
    found.push(...classified.failures.map(message => ({ invariant: 'no-page-errors', tab: message.tab, message: message.text.slice(0, 600) })));
    fail(found, entry);
  }

  function authorship(slug, rows, expected) {
    const out = [];
    for (const row of rows) {
      const known = expected.get(tokenOf(row.text ?? ''));
      count('author-matches-submitter');
      if (known?.author && known.slug === slug && row.author !== known.author)
        out.push({ invariant: 'author-matches-submitter', slug, token: tokenOf(row.text), expected: known.author, actual: row.author });
    }
    return out;
  }

  async function heal(entry) {
    const result = { restored: [] };
    // Bring every actor back: faults off, agent running, profiles open and online.
    if (model.network && world.faults) { await EXECUTORS['net.restore'](world, runtime, {}, model); result.restored.push('network'); }
    if (model.agent === 'paused') { world.signalAgent('SIGCONT'); result.restored.push('agent-resumed'); }
    if (model.agent === 'stopped') {
      count('agent-restarts');
      const started = await EXECUTORS['agent.start'](world, runtime, {});
      result.restored.push('agent-started');
      if (started.violations?.length) { fail(started.violations, entry); return result; }
    }
    for (const profile of model.profiles) {
      if (!profile.open) { await EXECUTORS['browser.reopenProfile'](world, runtime, { profile: profile.id }, model); result.restored.push(`open:${profile.id}`); }
      else if (!profile.online) { await runtime.profiles.get(profile.id).context.setOffline(false); result.restored.push(`online:${profile.id}`); }
    }
    ACTIONS.heal.effect(model);
    // A tab whose earlier action failed (for example a navigation refused while
    // offline; already recorded as an action error) is put back on its page.
    for (const { profile, tab } of liveTabs(model)) {
      const handle = runtime.profiles.get(profile.id);
      let page = handle?.tabs.get(tab.id);
      const state = page && !page.isClosed() ? await readTabState(page).catch(() => null) : null;
      if (state?.data !== null && state?.data !== undefined && state.url.startsWith(new URL(world.golden.pages[tab.slug].page_url).origin)) continue;
      if (!page || page.isClosed()) { page = await handle.context.newPage(); watchPage(runtime, page, `${profile.id}/${tab.id}`); handle.tabs.set(tab.id, page); }
      await page.goto(world.golden.pages[tab.slug].page_url, { timeout: 60_000 }).catch(() => {});
      result.restored.push(`repaired:${profile.id}/${tab.id}`);
    }
    const t0 = Date.now(), deadline = config.healDeadlineMs;
    const pages = model.config.pages;
    const applied = slug => note => note.operationId && tracker.has(slug, note.operationId);
    const required = Object.fromEntries(pages.map(slug => [slug, requiredNotes(model, slug, applied(slug))]));
    const parked = pages.flatMap(slug => parkedNotes(model, slug, applied(slug)).map(note => ({ slug, token: note.token, profile: note.profile })));
    let agentAt = null, tabsAt = null, connectedAt = null, uiAt = null, last;
    const check = async () => {
      const state = { agentMissing: {}, tabMissing: {}, notConnected: {}, staleUi: {} };
      for (const slug of pages) {
        const rows = await readAgentRows(world, slug).catch(error => ({ error: error.message }));
        state.agentMissing[slug] = rows.error ? [`query failed: ${rows.error.slice(0, 200)}`] : missingFrom({ rows }, required[slug]);
      }
      for (const { profile, tab } of liveTabs(model)) {
        const page = runtime.profiles.get(profile.id)?.tabs.get(tab.id);
        const id = `${profile.id}/${tab.id}`;
        if (!page || page.isClosed()) { state.tabMissing[id] = ['tab closed']; continue; }
        const rows = await readTabRows(page).catch(() => []);
        const missing = missingFrom({ rows }, required[tab.slug]);
        if (missing.length) state.tabMissing[id] = missing;
        const view = await readTabState(page).catch(error => ({ error: error.message }));
        if (view.error || !CONNECTED.test(view.peer ?? '') || !/application: ready/.test(view.data ?? '')) state.notConnected[id] = { peer: view.peer, data: view.data, connection: view.connection, error: view.error };
        const want = uiMarker(model.confirmedPublication[tab.slug]);
        if (!view.error && !view.draft && !(view.html ?? []).includes(want)) state.staleUi[id] = { want, have: view.html };
      }
      const now = Date.now() - t0;
      if (agentAt === null && Object.values(state.agentMissing).every(list => !list.length)) agentAt = now;
      if (tabsAt === null && !Object.keys(state.tabMissing).length) tabsAt = now;
      if (connectedAt === null && !Object.keys(state.notConnected).length) connectedAt = now;
      if (uiAt === null && !Object.keys(state.staleUi).length) uiAt = now;
      return state;
    };
    // Converged means every condition holds in the same observation; the
    // per-condition times record when each first held.
    const settled = state => Object.values(state.agentMissing).every(list => !list.length) && !Object.keys(state.tabMissing).length
      && !Object.keys(state.notConnected).length && !Object.keys(state.staleUi).length;
    const converged = await poll(async () => (last = await check()), state => !state.error && settled(state),
      { timeoutMs: deadline, intervalMs: 1_000 });
    const convergedAt = converged.ok ? Date.now() - t0 : null;
    count('converges'); count('not-stuck-connecting'); count('live-update');
    const found = [];
    last ??= {};
    if (!converged.ok && (Object.values(last.agentMissing ?? {}).some(list => list.length) || Object.keys(last.tabMissing ?? {}).length)) found.push({ invariant: 'converges', deadlineMs: deadline,
      agentMissing: clip(last.agentMissing), tabMissing: clip(last.tabMissing), required: Object.fromEntries(pages.map(slug => [slug, required[slug].length])) });
    if (!converged.ok && Object.keys(last.notConnected ?? {}).length) found.push({ invariant: 'not-stuck-connecting', deadlineMs: deadline, tabs: clip(last.notConnected) });
    if (!converged.ok && Object.keys(last.staleUi ?? {}).length) found.push({ invariant: 'live-update', deadlineMs: deadline, tabs: clip(last.staleUi) });
    if (!converged.ok && !found.length) found.push({ invariant: 'converges', deadlineMs: deadline, observation: clip(last) });
    fail(found, entry);
    // Persistence: every tab reloads and still shows every saved note.
    let persistedAt = null;
    if (converged.ok) {
      const p0 = Date.now();
      for (const { profile, tab } of liveTabs(model)) {
        const page = runtime.profiles.get(profile.id)?.tabs.get(tab.id);
        await page?.reload({ timeout: 60_000 }).catch(() => {});
      }
      const persisted = await poll(async () => {
        const missing = {};
        for (const { profile, tab } of liveTabs(model)) {
          const page = runtime.profiles.get(profile.id)?.tabs.get(tab.id);
          const rows = page && !page.isClosed() ? await readTabRows(page).catch(() => []) : [];
          const gap = missingFrom({ rows }, required[tab.slug]);
          if (gap.length) missing[`${profile.id}/${tab.id}`] = gap;
        }
        return missing;
      }, missing => !Object.keys(missing).length, { timeoutMs: Math.min(deadline, 60_000), intervalMs: 1_000 });
      count('persists-across-reload');
      if (!persisted.ok) fail([{ invariant: 'persists-across-reload', tabs: clip(persisted.value) }], entry);
      else persistedAt = Date.now() - p0;
      for (const { profile, tab } of liveTabs(model)) {
        const page = runtime.profiles.get(profile.id)?.tabs.get(tab.id);
        if (page && !page.isClosed()) await waitReady(page, 30_000).catch(() => {});
      }
    }
    if (injectFault) {
      count('injected-fault');
      const hit = INJECTED_FAULTS[injectFault](entries);
      if (hit) fail([{ invariant: 'injected-fault', fault: injectFault, ...hit }], entry);
    }
    const uncertain = allNotes(model).filter(note => note.status === 'uncertain');
    const timing = { step: entry.index, ok: converged.ok, ms: convergedAt, msAgent: agentAt, msTabs: tabsAt, msConnected: connectedAt, msUi: uiAt,
      msReloadPersist: persistedAt, required: Object.fromEntries(pages.map(slug => [slug, required[slug].length])),
      uncertainNotes: uncertain.length, parkedNotes: parked, tabs: liveTabs(model).length };
    convergence.push(timing);
    log(`chaos heal at #${entry.index}: ${converged.ok ? `converged in ${convergedAt}ms` : 'NOT converged'} agent=${agentAt}ms tabs=${tabsAt}ms connected=${connectedAt}ms ui=${uiAt}ms reload=${persistedAt}ms`);
    return { ...result, timing };
  }

  async function execute(entry) {
    const startedAt = Date.now();
    entry.at = new Date(startedAt).toISOString();
    entry.offsetMs = startedAt - started;
    runtime.step = entry.index;
    model.step = entry.index;
    try {
      if (entry.name === 'heal') { entry.result = await heal(entry); entry.status = 'ok'; }
      else {
        if (!ACTIONS[entry.name].pre(model) || !paramsStillValid(model, entry)) { entry.status = 'skipped'; return; }
        if (entry.name === 'browser.draftReload') count('draft-survives-reload');
        if (entry.name === 'agent.start') count('agent-restarts');
        const result = await EXECUTORS[entry.name](world, runtime, entry.params, model);
        const { violations: observed = [], ...rest } = result ?? {};
        entry.result = rest; entry.status = rest.skipped ? 'skipped-at-runtime' : 'ok';
        applyEntry(model, entry, rest);
        fail(observed, entry);
        await sweep(entry);
      }
    } catch (error) {
      entry.status = 'error'; entry.error = String(error?.message ?? error).slice(0, 1_500);
      // The world changed (or partly changed) anyway: keep the model's structure in step with the plan.
      if (entry.name !== 'heal') applyEntry(model, entry, null);
      log(`chaos action error #${entry.index} ${entry.name}: ${entry.error.split('\n')[0]}`);
      await sweep(entry).catch(() => {});
    } finally {
      entry.durationMs = Date.now() - startedAt;
      entries.push(entry);
    }
  }

  const stop = () => config.failFast && violations.length > 0;
  if (replay) {
    for (const original of replay) {
      if (stop()) break;
      await execute({ index: entries.length, name: original.name, params: structuredClone(original.params ?? {}) });
      log(`chaos #${entries.at(-1).index} ${entries.at(-1).name} ${entries.at(-1).status} (${entries.at(-1).durationMs}ms)`);
    }
  } else {
    while (!stop() && planner.actions < config.steps && Date.now() - started < config.durationMs) {
      const next = planner.next(model);
      await execute({ index: entries.length, ...next });
      log(`chaos #${entries.at(-1).index} ${entries.at(-1).name} ${entries.at(-1).status} (${entries.at(-1).durationMs}ms)`);
    }
  }
  if (!stop() && entries.at(-1)?.name !== 'heal') await execute({ index: entries.length, name: 'heal', params: {}, final: true });

  // Final snapshots for the report.
  for (const slug of model.config.pages)
    snapshots[`agent/${slug}`] = await readAgentRows(world, slug).catch(error => ({ error: error.message }));
  for (const { profile, tab } of liveTabs(model)) {
    const page = runtime.profiles.get(profile.id)?.tabs.get(tab.id);
    if (page && !page.isClosed()) snapshots[`tab/${profile.id}/${tab.id}`] = {
      slug: tab.slug, state: await readTabState(page).then(({ html, ...state }) => ({ ...state, ui: html })).catch(error => ({ error: error.message })),
      rows: await readTabRows(page).catch(error => ({ error: error.message })) };
  }
  const messages = classifyMessages(runtime.messages, config.allowlist);
  return { entries, violations, convergence, snapshots, model, runtime, invariantChecks,
    messages: { pageErrors: messages.failures, consoleErrors: messages.other.slice(0, 200), consoleErrorCount: messages.other.length,
      allowlisted: Object.entries(Object.groupBy(messages.allowlisted, item => item.rule)).map(([rule, items]) => ({ rule, count: items.length })) },
    notes: allNotes(model).map(({ text, ...note }) => ({ ...note, textLength: text?.length ?? null })) };
}

