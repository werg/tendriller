// The only long-running local program: one hub connection, one Chronolog session per
// granted and initialized page (own device store, shared signer and wrap key), one attach socket.
// A page whose data a browser created opens too: it waits there until a member admits this agent.
import { existsSync, watch as watchFiles } from 'node:fs';
import { join } from 'node:path';
import { evaluateBroadcastMatch, verifyBroadcastSignature } from '@tendriller/core';
import { pullAgentConnections } from './connections.mjs';
import { acknowledgeWorkspaceBroadcast, detectWorkspaceVersions, readBroadcastState, saveBroadcastState } from './workspace.mjs';

const PAGE_RETRY_MS = 1000, PAGE_MAX_RETRY_MS = 60_000;
const safeCode = error => /^[A-Za-z0-9_]{1,96}$/u.test(error?.code ?? '') ? error.code : 'page_unavailable';

/** Run until the signal aborts. `report` receives one JSON-safe object per event. */
export async function runAgent(workspace, { signal, report = () => {}, openOwnerSupervisor } = {}) {
  signal?.throwIfAborted();
  const client = await workspace.client();
  const binding = await workspace.attachBinding({ create: true });
  const [{ createNativeWorkspaceSupervisor }, { mergeSessionChanges }] = await Promise.all([
    import('@tendriller/core/native-owner'), import('@chronolog/peer-session')]);
  const supervisor = await (openOwnerSupervisor ?? createNativeWorkspaceSupervisor)({ directory: workspace.paths.owner,
    workspaceId: workspace.config.agent.id.replace(/[^A-Za-z0-9_.:-]/gu, '_'), bindings: [binding], signal });
  const pages = new Map(); // id -> { slug, state, owner?, retryTimer?, failures }
  // One change feed for every running page; a page's own feed ends with its session.
  const changes = mergeSessionChanges([], { signal, onError: () => {} });
  const pageOf = new Map(); // applicationId -> { id, slug }
  const changeReport = (async () => {
    try {
      for await (const change of changes) {
        const page = pageOf.get(change.applicationId);
        if (page) report({ page: page.id, slug: page.slug, revision: change.revision, change: change.kind });
      }
    } catch { /* each session's signal reports its own cause */ }
  })();
  let granted = null, stopping = false, rescanTimer;
  const rosters = new Map(); // pageId -> { primary_agent_id, is_primary, agents, listeners: Set }
  const ensureRosterEntry = pageId => {
    let r = rosters.get(pageId);
    if (!r) {
      r = { primary_agent_id: null, is_primary: false, agents: [], listeners: new Set() };
      rosters.set(pageId, r);
    }
    return r;
  };
  const updatePageRoster = (pageId, data) => {
    const entry = ensureRosterEntry(pageId);
    const primaryId = data?.primary_agent_id ?? null;
    const agents = Array.isArray(data?.agents) ? data.agents : entry.agents;
    const isPrimary = typeof data?.is_primary === 'boolean'
      ? data.is_primary
      : primaryId === workspace.config.agent.id;
    entry.primary_agent_id = primaryId;
    entry.is_primary = isPrimary;
    entry.agents = agents;
    const snap = Object.freeze({ primary_agent_id: primaryId, is_primary: isPrimary, agents: Object.freeze([...agents]) });
    for (const listener of entry.listeners) {
      try { listener(snap); } catch { /* Listener errors cannot break hub delivery */ }
    }
    return snap;
  };
  const rosterHandleFor = pageId => {
    const entry = ensureRosterEntry(pageId);
    return Object.freeze({
      get primaryAgentId() { return entry.primary_agent_id; },
      get isPrimary() { return entry.is_primary; },
      get agents() { return entry.agents; },
      snapshot: () => Object.freeze({ primary_agent_id: entry.primary_agent_id, is_primary: entry.is_primary, agents: Object.freeze([...entry.agents]) }),
      onChange(fn) {
        entry.listeners.add(fn);
        return () => { entry.listeners.delete(fn); };
      },
    });
  };

  const [versions, broadcastState] = await Promise.all([
    detectWorkspaceVersions(workspace.root, workspace.config.kit),
    readBroadcastState(workspace),
  ]);
  const broadcastListeners = new Set();
  const broadcastCache = {
    lastSeq: broadcastState.lastSeq,
    acknowledged: new Set(broadcastState.acknowledged),
    trustedKeys: broadcastState.trustedKeys,
    byId: new Map((broadcastState.items ?? []).map(item => [item.id, item])),
  };
  const broadcastsHandle = Object.freeze({
    snapshot: () => {
      const all = [...broadcastCache.byId.values()].sort((a, b) => a.seq - b.seq);
      return Object.freeze({
        latestSeq: broadcastCache.lastSeq,
        versions,
        active: Object.freeze(all.filter(item => item.matched && !broadcastCache.acknowledged.has(item.id))),
        all: Object.freeze(all),
      });
    },
    async acknowledge(id) {
      await acknowledgeWorkspaceBroadcast(workspace, id);
      broadcastCache.acknowledged.add(id);
      const existing = broadcastCache.byId.get(id);
      if (existing) broadcastCache.byId.set(id, { ...existing, acknowledged: true });
      return true;
    },
    onBroadcast(fn) {
      broadcastListeners.add(fn);
      return () => { broadcastListeners.delete(fn); };
    },
  });

  async function onHubBroadcasts(batch) {
    let trustedKeys = broadcastCache.trustedKeys;
    try {
      const fetched = await client.broadcastKeys({ signal });
      if (fetched.keys.length) trustedKeys = broadcastCache.trustedKeys = fetched.keys;
    } catch {
      if (!trustedKeys.length && Array.isArray(batch.keys)) trustedKeys = batch.keys;
    }
    const newlyVerified = [];
    for (const signed of batch.broadcasts ?? []) {
      const check = await verifyBroadcastSignature(signed, trustedKeys, { issuer: workspace.config.service });
      if (!check.valid) {
        report({ broadcast_rejected: { id: signed?.payload?.id ?? null, reason: check.reason ?? 'invalid_signature' } });
        continue;
      }
      const payload = signed.payload;
      const match = evaluateBroadcastMatch(payload, { audience: 'agents', versions });
      const entry = {
        ...payload,
        signed: { payload, signature: signed.signature },
        signature: signed.signature,
        verified: true,
        matched: match.matched,
        matchReasons: match.reasons,
        acknowledged: broadcastCache.acknowledged.has(payload.id),
      };
      const isNew = !broadcastCache.byId.has(payload.id);
      broadcastCache.byId.set(payload.id, entry);
      if (isNew) newlyVerified.push(entry);
    }
    if (Number.isSafeInteger(batch.latest_seq) && batch.latest_seq > broadcastCache.lastSeq) {
      broadcastCache.lastSeq = batch.latest_seq;
    }
    await saveBroadcastState(workspace, {
      lastSeq: broadcastCache.lastSeq,
      acknowledged: [...broadcastCache.acknowledged],
      trustedKeys: broadcastCache.trustedKeys,
      items: [...broadcastCache.byId.values()],
    }).catch(() => {});
    for (const item of newlyVerified) {
      report({
        broadcast: {
          id: item.id, seq: item.seq, kind: item.kind, severity: item.severity,
          title: item.title, summary: item.summary, docs_url: item.docs_url,
          action: item.action, matched: item.matched, matchReasons: item.matchReasons,
          verified: true, acknowledged: item.acknowledged,
        },
      });
      for (const listener of broadcastListeners) {
        try { listener(item); } catch { /* listener errors cannot disrupt hub delivery */ }
      }
    }
  }

  let pullingConnections = null;
  async function syncPendingAgentConnections() {
    if (stopping || pullingConnections) return pullingConnections;
    pullingConnections = (async () => {
      try {
        const { pulled } = await pullAgentConnections(workspace, signal);
        for (const item of pulled) {
          report({ outbound_connection_pulled: item });
        }
      } catch {
        /* best-effort auto-pull; manual `tendril connection pull` remains available */
      } finally {
        pullingConnections = null;
      }
    })();
    return pullingConnections;
  }

  const hub = client.hub;
  const stopEvents = hub.events(event => void onHubEvent(event).catch(() => {}));
  const stopBroadcasts = hub.broadcasts?.(batch => void onHubBroadcasts(batch).catch(() => {})) ?? (() => {});
  hub.sendHello?.({ versions, lastBroadcastSeq: broadcastCache.lastSeq });
  // Periodically check `/api/broadcasts` with ETag (`304 Not Modified` when unchanged)
  // so long-lived sessions pick up manual operator advisories without waiting for a reconnect.
  let broadcastEtag = null;
  const pollBroadcasts = async () => {
    if (stopping || signal?.aborted || typeof client.broadcasts !== 'function') return;
    try {
      const feed = await client.broadcasts({ audience: 'agents', since: broadcastCache.lastSeq, etag: broadcastEtag, signal });
      if (feed.etag) broadcastEtag = feed.etag;
      if (!feed.notModified && (feed.broadcasts?.length || feed.latest_seq > broadcastCache.lastSeq)) {
        await onHubBroadcasts(feed);
      }
    } catch { /* non-fatal: hub hello remains the primary delivery channel */ }
  };
  const broadcastPollTimer = setInterval(() => { void pollBroadcasts(); }, 15 * 60_000);
  broadcastPollTimer.unref?.();
  const stopStatus = hub.onStatus(status => {
    report({ hub: status.state, ...(status.retryInMs === undefined ? {} : { retryInMs: status.retryInMs }) });
    if (status.state === 'connected') {
      if (status.reconnected) scheduleRescan(true);
      void syncPendingAgentConnections();
    }
    if (status.state === 'revoked') report({ state: 'agent_revoked', next: 'The owner revoked this agent or its token (or the host cut over to a new storage namespace). Export any local page data first, then run tendril workspace reenroll to keep your existing signing/wrap keys; local page stores are never deleted.' });
  });
  hub.connect();

  async function refreshGrants() {
    const next = new Set();
    for await (const page of client.pages.all({ signal })) {
      next.add(page.id);
      updatePageRoster(page.id, page);
    }
    granted = next;
    return next;
  }
  function scheduleRescan(remote = false) {
    if (stopping) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { void rescan({ remote }).catch(error => report({ state: 'rescan_failed', code: safeCode(error) })); }, 250);
  }
  async function rescan({ remote = false } = {}) {
    if (stopping) return;
    const listed = await workspace.pages();
    // A page registered since the last listing (page new while running) is not in
    // the cached grants yet; re-read them before treating it as ungranted.
    if (remote || granted === null || listed.some(page => !granted.has(page.id))) {
      try { await refreshGrants(); }
      catch (error) { report({ state: 'grants_unavailable', code: safeCode(error), status: error.status ?? null }); }
    }
    for (const page of listed) {
      if (granted && !granted.has(page.id)) { await closePage(page.id, 'grant_missing'); continue; }
      if (page.initialized && page.module && !pages.has(page.id)) openPage(page);
      else if (!pages.has(page.id) && !page.initialized) report({ page: page.id, slug: page.slug, state: 'awaiting_initialization' });
    }
    for (const id of [...pages.keys()]) if (!listed.some(page => page.id === id)) await closePage(id, 'unregistered');
  }
  function openPage(page) {
    const entry = { slug: page.slug, state: 'opening', failures: 0 };
    pages.set(page.id, entry);
    void start(page.id, entry);
  }
  async function start(id, entry) {
    if (stopping || pages.get(id) !== entry) return;
    const lifetime = entry.lifetime = new AbortController();
    const pageSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      const context = await workspace.pageContext(entry.slug, {
        signal: pageSignal,
        report: value => report({ page: id, slug: entry.slug, ...value }),
        roster: rosterHandleFor(id),
        broadcasts: broadcastsHandle,
      });
      const module = await workspace.pageModule({ slug: entry.slug });
      if (typeof module.openPage !== 'function') throw Object.assign(Error(`pages/${entry.slug}/agent.mjs must export openPage(context)`), { code: 'page_module_invalid' });
      const owner = await module.openPage(context);
      if (pages.get(id) !== entry || stopping) { await owner?.close?.(); return; }
      entry.owner = owner;
      const profile = await supervisor.addPage(id, owner);
      entry.state = 'running'; entry.failures = 0;
      report({ page: id, slug: entry.slug, state: 'running', publicKey: profile.publicKey, applicationId: profile.applicationId,
        definition: { id: owner.session.definition.id, version: owner.session.definition.version } });
      entry.stopParticipation = owner.participation?.onStatus?.(status => report({ page: id, slug: entry.slug, connection: status.phase, ...(status.error ? { error: status.error } : {}) }));
      entry.stopStatus = owner.session.onStatus(status => report({ page: id, slug: entry.slug, canAuthor: status.canAuthor, database: status.database }));
      pageOf.set(owner.session.applicationId, { id, slug: entry.slug });
      changes.add(owner.session);
      await new Promise(resolve => {
        if (owner.session.signal?.aborted || pageSignal.aborted) resolve();
        owner.session.signal?.addEventListener('abort', resolve, { once: true });
        pageSignal.addEventListener('abort', resolve, { once: true });
      });
      if (!pageSignal.aborted) report({ page: id, slug: entry.slug, state: 'session_ended', code: safeCode(owner.session.signal?.reason) });
    } catch (error) {
      if (pageSignal.aborted) return;
      report({ page: id, slug: entry.slug, state: 'page_failed', code: safeCode(error), message: String(error?.message ?? error).slice(0, 300) });
      if (entry.owner) { try { if (!await supervisor.removePage(id)) await entry.owner.close(); } catch { try { await entry.owner.close(); } catch {} } entry.owner = undefined; }
    }
    if (entry.owner) changes.remove(entry.owner.session);
    if (stopping || pages.get(id) !== entry || pageSignal.aborted) return;
    entry.stopParticipation?.(); entry.stopStatus?.();
    if (entry.owner) { try { if (!await supervisor.removePage(id)) await entry.owner.close(); } catch {} entry.owner = undefined; }
    const ms = Math.min(PAGE_MAX_RETRY_MS, PAGE_RETRY_MS * 2 ** Math.min(entry.failures++, 6));
    entry.state = 'retrying';
    report({ page: id, slug: entry.slug, state: 'page_retry', retryInMs: ms });
    entry.retryTimer = setTimeout(() => { void start(id, entry); }, ms);
  }
  async function closePage(id, reason) {
    const entry = pages.get(id);
    if (!entry) return;
    pages.delete(id);
    clearTimeout(entry.retryTimer); entry.lifetime?.abort();
    entry.stopParticipation?.(); entry.stopStatus?.();
    if (entry.owner) changes.remove(entry.owner.session);
    try { if (entry.owner && !await supervisor.removePage(id)) await entry.owner.close(); } catch {}
    report({ page: id, slug: entry.slug, state: 'closed', reason });
  }
  async function onHubEvent(event) {
    report({ event: event.kind, page: event.page });
    if (event.kind === 'grant') {
      granted?.add(event.page);
      const listed = await workspace.pages();
      if (!listed.some(page => page.id === event.page))
        report({ page: event.page, state: 'granted_unregistered', next: `Register it with tendril page grant <slug> ${event.page}` });
      scheduleRescan();
    } else if (event.kind === 'agents-changed') {
      if (event.data && typeof event.data === 'object') {
        updatePageRoster(event.page, event.data);
      } else {
        scheduleRescan(true);
      }
    } else if (event.kind === 'revoked' || event.kind === 'page-deleted') {
      granted?.delete(event.page);
      await closePage(event.page, event.kind);
    } else if (event.kind === 'outbound-connection-ready') {
      await syncPendingAgentConnections();
    } else if (event.kind === 'outbound-connection-revoked') {
      report({ outbound_connection_revoked: event.data ?? {} });
    }
  }

  let watcher;
  try {
    // Watch the existing private parent, including when no page directory exists
    // yet. Registration discovers a page; `init` (initialized.json) lets the program open it.
    if (existsSync(workspace.paths.secret)) {
      watcher = watchFiles(workspace.paths.secret, { recursive: true }, (_type, name) => {
        const file = String(name ?? '').split(/[\\/]/u).at(-1);
        if (file === 'page.json' || file === 'initialized.json') scheduleRescan();
      });
      watcher.on('error', () => {});
    }
  } catch { /* recursive watches are optional; restart or attach after initialization */ }
  report({ running: true, workspace: workspace.root, agent: workspace.config.agent.id, handle: workspace.config.agent.handle, socket: supervisor.socketPath,
    terminal: 'tendril --page <slug> self', processLifetime: 'Until this process stops; pages keep their local data when it is not running.' });
  try {
    await rescan({ remote: true });
    if (!signal?.aborted) await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
  } finally {
    stopping = true; clearTimeout(rescanTimer); clearInterval(broadcastPollTimer); watcher?.close();
    stopEvents(); stopBroadcasts(); stopStatus();
    await Promise.allSettled([...pages.keys()].map(id => closePage(id, 'stopping')));
    changes.close(); await changeReport;
    hub.close(); client.close?.();
    await supervisor.close();
    report({ running: false });
  }
}

/** The CLI attach path: authenticate to the running agent program and name one page. */
export async function attachPage(workspace, ref, { signal, context } = {}) {
  const page = await workspace.page(ref), binding = await workspace.attachBinding();
  if (!binding) throw Object.assign(Error('Start tendril agent run in this workspace, then attach again.'), { code: 'OWNER_UNREACHABLE' });
  const [{ attachNativeSession, readPrivateJson }, { connectApplicationOwner }] = await Promise.all([
    import('@tendriller/core/native-owner').then(async owner => ({ ...owner, readPrivateJson: (await import('@tendriller/core/ipc')).readPrivateJson })),
    import('@chronolog/peer-session/browser')]);
  const profile = existsSync(join(workspace.paths.owner, `profile-${page.id}.json`))
    ? await readPrivateJson(workspace.paths.owner, `profile-${page.id}.json`) : null;
  if (!profile) throw Object.assign(Error(`Page ${page.slug} has not been opened by tendril agent run yet. Initialize it, then start or keep the agent program running.`), { code: 'OWNER_UNREACHABLE' });
  return attachNativeSession({ directory: workspace.paths.owner, token: binding.token, page: page.id, connect: connectApplicationOwner,
    applicationId: profile.applicationId,
    ...(context ? { context } : {}), signal });
}
