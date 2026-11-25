// The chaos model: what the harness believes about the world (which actors are
// running/online, which tabs exist where) and what it expects (submitted notes,
// published UI versions). Structural state depends only on action parameters, so
// a seed always yields the same action sequence; execution results only refine
// expectations (for example whether a browser save produced an operation).

export function createModel({ pages, browsers = 3, maxTabsPerProfile = 3, network = false, hostRestart = true } = {}) {
  if (!Array.isArray(pages) || !pages.length) throw Error('The chaos model needs at least one page slug');
  return {
    config: { pages: [...pages], browsers, maxTabsPerProfile, network, hostRestart },
    agent: 'running', // running | paused | stopped
    host: 'running',
    network: null, // null | 'udp-blocked' | 'impaired'
    profiles: [], // { id, open, online, enrolled: [slug], tabs: [{ id, slug, draft }] }
    counters: { profile: 0, tab: 0, note: 0 },
    published: Object.fromEntries(pages.map(slug => [slug, 1])), // planned version per page
    confirmedPublication: Object.fromEntries(pages.map(slug => [slug, 1])), // versions the publisher confirmed
    notes: Object.fromEntries(pages.map(slug => [slug, []])),
    step: 0,
  };
}

export const cloneModel = model => structuredClone(model);

export const profileById = (model, id) => model.profiles.find(profile => profile.id === id);
export const openProfiles = model => model.profiles.filter(profile => profile.open);
export const tabById = (model, profileId, tabId) => profileById(model, profileId)?.tabs.find(tab => tab.id === tabId);

/** Tabs that show an application page of an open profile: [{ profile, tab }]. */
export function liveTabs(model) {
  return openProfiles(model).flatMap(profile => profile.tabs
    .filter(tab => tab.slug && profile.enrolled.includes(tab.slug)).map(tab => ({ profile, tab })));
}

export const allocate = (model, kind, prefix) => `${prefix}${model.counters[kind]}`;
/** Effects call this so replayed parameters keep counters ahead of every used id. */
export function bump(model, kind, id) {
  const n = Number(/(\d+)$/.exec(String(id))?.[1]);
  if (Number.isSafeInteger(n)) model.counters[kind] = Math.max(model.counters[kind], n + 1);
}

/**
 * Every note the model requires to converge on `slug` (saved = a signed attempt
 * was confirmed). A browser attempt lives in that profile's local journal for
 * the page's origin; it can only be delivered while the profile has a tab open
 * on that page. Unless it was already seen applied (`applied(note)`), such a
 * *parked* note is not required until a tab of its profile shows the page again.
 */
export function requiredNotes(model, slug, applied = () => false) {
  return model.notes[slug].filter(note => note.status === 'saved'
    && (note.origin !== 'browser' || applied(note) || hasLiveTab(model, note.profile, slug)));
}
export const parkedNotes = (model, slug, applied = () => false) => model.notes[slug].filter(note => note.status === 'saved'
  && note.origin === 'browser' && !applied(note) && !hasLiveTab(model, note.profile, slug));
export const hasLiveTab = (model, profileId, slug) => liveTabs(model).some(({ profile, tab }) => profile.id === profileId && tab.slug === slug);
export const allNotes = model => Object.entries(model.notes).flatMap(([slug, notes]) => notes.map(note => ({ ...note, slug })));
