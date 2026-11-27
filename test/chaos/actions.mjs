// The action registry. Each action is pure: `pre(model)` decides eligibility,
// `plan(rng, model, context)` draws every random choice into explicit parameters
// (so the log replays exactly), and `effect(model, params, result)` updates the
// model. Executors with real side effects live in driver.mjs under the same names.
import { allocate, bump, liveTabs, openProfiles, profileById, tabById } from './model.mjs';
import { generateNoteText, noteToken } from './text.mjs';

// Loading a document needs the network (page code is not saved for offline use by
// default), so navigation-type actions only pick online profiles. Saving does not.
const onlineTabs = model => liveTabs(model).filter(({ profile }) => profile.online);
const pickLive = (rng, model, { online = false } = {}) => {
  const { profile, tab } = rng.pick(online ? onlineTabs(model) : liveTabs(model));
  return { profile: profile.id, tab: tab.id, slug: tab.slug };
};
const agentRunning = model => model.agent === 'running';

export const ACTIONS = Object.freeze({
  'browser.enroll': {
    weight: 1.5,
    description: 'Open a brand-new browser profile and let the running agent program enroll it on a page.',
    pre: model => agentRunning(model) && model.host === 'running' && model.profiles.length < model.config.browsers,
    plan: (rng, model) => ({ profile: allocate(model, 'profile', 'b'), tab: allocate(model, 'tab', 't'), slug: rng.pick(model.config.pages) }),
    effect(model, params) {
      bump(model, 'profile', params.profile); bump(model, 'tab', params.tab);
      model.profiles.push({ id: params.profile, open: true, online: true, enrolled: [params.slug],
        tabs: [{ id: params.tab, slug: params.slug, draft: '' }] });
    },
  },
  'browser.addNote': {
    weight: 10,
    description: 'Type a generated note (unicode, emoji, multiline, whitespace, max/over length) and Save.',
    pre: model => liveTabs(model).length > 0,
    plan(rng, model, context) {
      const target = pickLive(rng, model), n = model.counters.note;
      const token = noteToken(context.runId, n);
      return { ...target, n, token, ...generateNoteText(rng, token) };
    },
    effect(model, params, result) {
      model.counters.note = Math.max(model.counters.note, params.n + 1);
      const tab = tabById(model, params.profile, params.tab);
      if (result?.operationId) model.notes[params.slug].push({ token: params.token, text: result.retained, origin: 'browser',
        profile: params.profile, step: model.step, operationId: result.operationId, status: result.saved ? 'saved' : 'uncertain' });
      if (tab) tab.draft = result?.saved ? '' : null;
    },
  },
  'browser.draftReload': {
    weight: 4,
    description: 'Type a draft without saving, reload the tab; the draft must survive.',
    pre: model => onlineTabs(model).length > 0,
    plan(rng, model) {
      const target = pickLive(rng, model, { online: true });
      const { text } = generateNoteText(rng, `draft-${model.step}`, rng.pick(['plain', 'unicode', 'emoji', 'multiline']));
      return { ...target, text };
    },
    effect(model, params) { const tab = tabById(model, params.profile, params.tab); if (tab) tab.draft = params.text; },
  },
  'browser.reload': {
    weight: 4,
    description: 'Reload one application tab.',
    pre: model => onlineTabs(model).length > 0,
    plan: (rng, model) => pickLive(rng, model, { online: true }),
    effect() {},
  },
  'browser.reopenTab': {
    weight: 2,
    description: 'Close one tab and open the same page in a new tab of the same profile.',
    pre: model => onlineTabs(model).length > 0,
    plan: (rng, model) => ({ ...pickLive(rng, model, { online: true }), next: allocate(model, 'tab', 't') }),
    effect(model, params) {
      bump(model, 'tab', params.next);
      const tab = tabById(model, params.profile, params.tab);
      if (tab) Object.assign(tab, { id: params.next, draft: null });
    },
  },
  'browser.secondTab': {
    weight: 2,
    description: 'Open another tab on the same profile (shared device owner).',
    pre: model => openProfiles(model).some(profile => profile.online && profile.tabs.length < model.config.maxTabsPerProfile && profile.enrolled.length),
    plan(rng, model) {
      const profile = rng.pick(openProfiles(model).filter(item => item.online && item.tabs.length < model.config.maxTabsPerProfile && item.enrolled.length));
      return { profile: profile.id, tab: allocate(model, 'tab', 't'), slug: rng.pick(profile.enrolled) };
    },
    effect(model, params) {
      bump(model, 'tab', params.tab);
      profileById(model, params.profile)?.tabs.push({ id: params.tab, slug: params.slug, draft: '' });
    },
  },
  'browser.closeTab': {
    weight: 1,
    description: 'Close one of several tabs of a profile.',
    pre: model => openProfiles(model).some(profile => profile.tabs.length > 1),
    plan(rng, model) {
      const profile = rng.pick(openProfiles(model).filter(item => item.tabs.length > 1));
      return { profile: profile.id, tab: rng.pick(profile.tabs).id };
    },
    effect(model, params) {
      const profile = profileById(model, params.profile);
      if (profile) profile.tabs = profile.tabs.filter(tab => tab.id !== params.tab);
    },
  },
  'browser.navigate': {
    weight: 2,
    description: 'Navigate a tab to the other page of the workspace (enrolling there first if needed).',
    pre: model => model.config.pages.length > 1 && onlineTabs(model).some(({ profile, tab }) =>
      agentRunning(model) || model.config.pages.some(slug => slug !== tab.slug && profile.enrolled.includes(slug))),
    plan(rng, model) {
      const candidates = onlineTabs(model).filter(({ profile, tab }) =>
        agentRunning(model) || model.config.pages.some(slug => slug !== tab.slug && profile.enrolled.includes(slug)));
      const { profile, tab } = rng.pick(candidates);
      const targets = model.config.pages.filter(slug => slug !== tab.slug && (agentRunning(model) || profile.enrolled.includes(slug)));
      return { profile: profile.id, tab: tab.id, from: tab.slug, slug: rng.pick(targets) };
    },
    effect(model, params) {
      const profile = profileById(model, params.profile), tab = tabById(model, params.profile, params.tab);
      if (!profile || !tab) return;
      if (!profile.enrolled.includes(params.slug)) profile.enrolled.push(params.slug);
      Object.assign(tab, { slug: params.slug, draft: null });
    },
  },
  'browser.offline': {
    weight: 3,
    description: 'context.setOffline(true) for one open profile.',
    pre: model => openProfiles(model).some(profile => profile.online),
    plan: (rng, model) => ({ profile: rng.pick(openProfiles(model).filter(item => item.online)).id }),
    effect(model, params) { const profile = profileById(model, params.profile); if (profile) profile.online = false; },
  },
  'browser.online': {
    weight: 3,
    description: 'context.setOffline(false) for one offline profile.',
    pre: model => openProfiles(model).some(profile => !profile.online),
    plan: (rng, model) => ({ profile: rng.pick(openProfiles(model).filter(item => !item.online)).id }),
    effect(model, params) { const profile = profileById(model, params.profile); if (profile) profile.online = true; },
  },
  'browser.closeProfile': {
    weight: 1,
    description: 'Close a whole browser profile (its persistent storage is kept).',
    pre: model => openProfiles(model).length > 1,
    plan: (rng, model) => ({ profile: rng.pick(openProfiles(model)).id }),
    effect(model, params) { const profile = profileById(model, params.profile); if (profile) profile.open = false; },
  },
  'browser.reopenProfile': {
    weight: 2,
    description: 'Relaunch a closed browser profile from its persistent storage and reopen its tabs.',
    pre: model => model.profiles.some(profile => !profile.open),
    plan: (rng, model) => ({ profile: rng.pick(model.profiles.filter(item => !item.open)).id }),
    effect(model, params) {
      const profile = profileById(model, params.profile);
      if (!profile) return;
      Object.assign(profile, { open: true, online: true });
      for (const tab of profile.tabs) tab.draft = null;
    },
  },
  'race.saveKill': {
    weight: 1.5,
    description: 'Save a note in a browser and SIGKILL the agent program a random few milliseconds later (apply in flight).',
    pre: model => agentRunning(model) && liveTabs(model).length > 0,
    plan(rng, model, context) {
      const target = pickLive(rng, model), n = model.counters.note;
      const token = noteToken(context.runId, n);
      return { ...target, n, token, ...generateNoteText(rng, token, rng.pick(['plain', 'unicode', 'emoji'])), delayMs: rng.int(0, 400) };
    },
    effect(model, params, result) {
      ACTIONS['browser.addNote'].effect(model, params, result);
      model.agent = 'stopped';
    },
  },
  'agent.command': {
    weight: 5,
    description: 'A native addNote through a separate attach CLI process.',
    pre: agentRunning,
    plan(rng, model, context) {
      const n = model.counters.note, token = noteToken(context.runId, n);
      const { kind, text } = generateNoteText(rng, token, rng.pick(['plain', 'unicode', 'emoji', 'multiline', 'max']));
      return { slug: rng.pick(model.config.pages), n, token, kind, text: text.trim(), operation: `chaos-native-${context.runId}-${n}` };
    },
    effect(model, params, result) {
      model.counters.note = Math.max(model.counters.note, params.n + 1);
      if (result?.outcome || result?.uncertain) model.notes[params.slug].push({ token: params.token, text: result.retained ?? params.text, origin: 'native',
        step: model.step, operationId: result.operationId ?? null, status: result.outcome === 'accepted' ? 'saved' : 'uncertain' });
    },
  },
  'agent.kill': {
    weight: 1.5,
    description: 'SIGKILL the agent program (no cleanup).',
    pre: agentRunning,
    plan: () => ({}),
    effect(model) { model.agent = 'stopped'; },
  },
  'agent.stop': {
    weight: 1,
    description: 'SIGTERM the agent program; browsers keep saving locally.',
    pre: agentRunning,
    plan: () => ({}),
    effect(model) { model.agent = 'stopped'; },
  },
  'agent.start': {
    weight: 3,
    description: 'Start the agent program again.',
    pre: model => model.agent === 'stopped',
    plan: () => ({}),
    effect(model) { model.agent = 'running'; },
  },
  'agent.pause': {
    weight: 1,
    description: 'SIGSTOP the agent program (frozen sockets and timers).',
    pre: agentRunning,
    plan: () => ({}),
    effect(model) { model.agent = 'paused'; },
  },
  'agent.resume': {
    weight: 3,
    description: 'SIGCONT a paused agent program.',
    pre: model => model.agent === 'paused',
    plan: () => ({}),
    effect(model) { model.agent = 'running'; },
  },
  'publish': {
    weight: 1,
    description: 'Publish a new signed UI version of one page while browsers are open (live update).',
    pre: agentRunning,
    plan(rng, model) {
      const slug = rng.pick(model.config.pages);
      return { slug, version: model.published[slug] + 1 };
    },
    effect(model, params, result) {
      model.published[params.slug] = Math.max(model.published[params.slug], params.version);
      if (result?.published) model.confirmedPublication[params.slug] = Math.max(model.confirmedPublication[params.slug], params.version);
    },
  },
  'host.restart': {
    weight: 0.5,
    description: 'Dispose and restart the local packed host on the same storage.',
    pre: model => model.config.hostRestart && model.host === 'running',
    plan: () => ({}),
    effect() {},
  },
  'net.fault': {
    weight: 1,
    description: 'Docker lab only: block UDP (forcing relay) or impair the link.',
    pre: model => model.config.network && model.network === null,
    plan: rng => ({ kind: rng.pick(['udp-blocked', 'impaired']) }),
    effect(model, params) { model.network = params.kind; },
  },
  'net.restore': {
    weight: 2,
    description: 'Docker lab only: remove the active packet fault.',
    pre: model => model.config.network && model.network !== null,
    plan: () => ({}),
    effect(model) { model.network = null; },
  },
  'wait': {
    weight: 2,
    description: 'Let time pass (timers, reconnect backoff).',
    pre: () => true,
    plan: rng => ({ ms: rng.int(100, 4_000) }),
    effect() {},
  },
  'heal': {
    weight: 0, // Scheduled, never drawn.
    description: 'Restore every actor (agent running, profiles open and online, no faults) and check liveness.',
    pre: () => true,
    // A browser delivers a page's saved operations only while that page is open in
    // one of its tabs. Heal reopens a tab for every (profile, page) that holds a
    // submitted, not-yet-seen-applied browser operation and has no tab there.
    plan: model => ({ reopen: undeliveredWithoutTab(model).map(({ profile, slug }, i) =>
      ({ profile, slug, tab: `t${model.counters.tab + i}` })) }),
    effect(model, params = {}) {
      model.agent = 'running'; model.host = 'running'; model.network = null;
      for (const profile of model.profiles) Object.assign(profile, { open: true, online: true });
      for (const item of params.reopen ?? []) {
        bump(model, 'tab', item.tab);
        const profile = profileById(model, item.profile);
        if (!profile || profile.tabs.some(tab => tab.id === item.tab)) continue;
        if (!profile.enrolled.includes(item.slug)) profile.enrolled.push(item.slug);
        profile.tabs.push({ id: item.tab, slug: item.slug, draft: null });
      }
    },
  },
});

export const actionNames = () => Object.keys(ACTIONS);

/** [{ profile, slug }] with a submitted browser operation not yet seen applied and no tab of that profile on that page. */
export function undeliveredWithoutTab(model) {
  const out = [];
  for (const [slug, notes] of Object.entries(model.notes)) for (const note of notes) {
    if (note.origin !== 'browser' || note.applied || !note.operationId) continue;
    if (out.some(item => item.profile === note.profile && item.slug === slug)) continue;
    const profile = profileById(model, note.profile);
    if (!profile || profile.tabs.some(tab => tab.slug === slug)) continue;
    out.push({ profile: note.profile, slug });
  }
  return out;
}

export function eligibleActions(model, registry = ACTIONS, { exclude = [] } = {}) {
  return Object.entries(registry).filter(([name, action]) => !exclude.includes(name) && action.weight > 0 && action.pre(model))
    .map(([name, action]) => ({ name, action, weight: action.weight }));
}

/** Draw the next action for this model. Throws if nothing is eligible (wait always is). */
export function chooseAction(rng, model, context, registry = ACTIONS, options = {}) {
  const choice = rng.weighted(eligibleActions(model, registry, options));
  return { name: choice.name, params: choice.action.plan(rng, model, context) };
}

/** Apply an entry's effect. Returns false (and leaves the model unchanged) if its precondition fails. */
export function applyEntry(model, entry, result, registry = ACTIONS) {
  const action = registry[entry.name];
  if (!action) throw Error(`Unknown chaos action: ${entry.name}`);
  if (!action.pre(model) || !paramsStillValid(model, entry)) return false;
  action.effect(model, entry.params, result);
  return true;
}

/** The entries of a log that would apply in a dry model run (results unknown). */
export function applicableEntries(entries, { pages, browsers, network = false, hostRestart = true }, createModel) {
  const model = createModel({ pages, browsers, network, hostRestart });
  return entries.filter(entry => entry.name === 'heal'
    ? (ACTIONS.heal.effect(model, entry.params ?? {}), true)
    : applyEntry(model, entry, entry.name === 'browser.addNote' || entry.name === 'race.saveKill'
      ? { operationId: `dry-${entry.params.n}`, saved: true, retained: entry.params.text } : undefined));
}

/** A replayed or shrunk entry may name a profile/tab that no longer exists in this model. */
export function paramsStillValid(model, { name, params }) {
  if (name === 'browser.enroll') return !profileById(model, params.profile);
  if (name === 'browser.secondTab') {
    const profile = profileById(model, params.profile);
    return Boolean(profile?.open && profile.online && profile.enrolled.includes(params.slug) && profile.tabs.length < model.config.maxTabsPerProfile);
  }
  if (name === 'browser.navigate') {
    const profile = profileById(model, params.profile), tab = tabById(model, params.profile, params.tab);
    return Boolean(profile?.open && profile.online && tab?.slug && tab.slug !== params.slug && (model.agent === 'running' || profile.enrolled.includes(params.slug)));
  }
  if (['browser.addNote', 'race.saveKill', 'browser.draftReload', 'browser.reload', 'browser.reopenTab'].includes(name)) {
    const profile = profileById(model, params.profile), tab = tabById(model, params.profile, params.tab);
    return Boolean(profile?.open && (name === 'browser.addNote' || name === 'race.saveKill' || profile.online) && tab?.slug
      && profile.enrolled.includes(tab.slug) && tab.slug === (params.slug ?? tab.slug));
  }
  if (name === 'browser.closeTab') {
    const profile = profileById(model, params.profile);
    return Boolean(profile?.open && profile.tabs.length > 1 && profile.tabs.some(tab => tab.id === params.tab));
  }
  if (name === 'browser.offline') return Boolean(profileById(model, params.profile)?.open && profileById(model, params.profile).online);
  if (name === 'browser.online') return Boolean(profileById(model, params.profile)?.open && !profileById(model, params.profile).online);
  if (name === 'browser.closeProfile') return Boolean(profileById(model, params.profile)?.open);
  if (name === 'browser.reopenProfile') return Boolean(profileById(model, params.profile) && !profileById(model, params.profile).open);
  if (name === 'publish') return params.version > model.published[params.slug];
  return true;
}
