// The only long-running local program: one hub connection, one Chronolog session per
// granted and initialized page (own device store, shared signer), one attach socket.
import { existsSync, watch as watchFiles } from 'node:fs';
import { join } from 'node:path';

const PAGE_RETRY_MS = 1000, PAGE_MAX_RETRY_MS = 60_000;
const safeCode = error => /^[A-Za-z0-9_]{1,96}$/u.test(error?.code ?? '') ? error.code : 'page_unavailable';

/** Run until the signal aborts. `report` receives one JSON-safe object per event. */
export async function runAgent(workspace, { signal, report = () => {}, openOwnerSupervisor } = {}) {
  signal?.throwIfAborted();
  const client = await workspace.client();
  const binding = await workspace.attachBinding({ create: true });
  const { createNativeWorkspaceSupervisor } = await import('@tendriller/core/native-owner');
  const supervisor = await (openOwnerSupervisor ?? createNativeWorkspaceSupervisor)({ directory: workspace.paths.owner,
    workspaceId: workspace.config.agent.id.replace(/[^A-Za-z0-9_.:-]/gu, '_'), bindings: [binding], signal });
  const pages = new Map(); // id -> { slug, state, owner?, retryTimer?, failures, changes? }
  let granted = null, stopping = false, rescanTimer;
  const hub = client.hub;
  const stopEvents = hub.events(event => void onHubEvent(event).catch(() => {}));
  const stopStatus = hub.onStatus(status => {
    report({ hub: status.state, ...(status.retryInMs === undefined ? {} : { retryInMs: status.retryInMs }) });
    if (status.state === 'connected' && status.reconnected) scheduleRescan(true);
    if (status.state === 'revoked') report({ state: 'agent_revoked', next: 'The owner revoked this agent or its token. Re-register the workspace agent; local page data is kept.' });
  });
  hub.connect();

  async function refreshGrants() {
    const next = new Set();
    for await (const page of client.pages.all({ signal })) next.add(page.id);
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
      const context = await workspace.pageContext(entry.slug, { signal: pageSignal, report: value => report({ page: id, slug: entry.slug, ...value }) });
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
      entry.changes = (async () => {
        try { for await (const change of owner.session.changes({ signal: pageSignal })) report({ page: id, slug: entry.slug, revision: change.revision, change: change.kind }); }
        catch { /* the session signal reports the cause below */ }
      })();
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
    try { if (entry.owner && !await supervisor.removePage(id)) await entry.owner.close(); } catch {}
    try { await entry.changes; } catch {}
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
    } else if (event.kind === 'revoked' || event.kind === 'page-deleted') {
      granted?.delete(event.page);
      await closePage(event.page, event.kind);
    }
  }

  let watcher;
  try {
    // Watch the existing private parent, including when no page directory exists
    // yet. Registration discovers a page; only explicit provisioning may open it.
    if (existsSync(workspace.paths.secret)) {
      watcher = watchFiles(workspace.paths.secret, { recursive: true }, (_type, name) => {
        const file = String(name ?? '').split(/[\\/]/u).at(-1);
        if (file === 'page.json' || file === 'initialized.json') scheduleRescan();
      });
      watcher.on('error', () => {});
    }
  } catch { /* recursive watches are optional; restart or attach after initialization */ }
  report({ running: true, workspace: workspace.root, agent: workspace.config.agent.id, socket: supervisor.socketPath,
    terminal: 'tendril --page <slug> self', processLifetime: 'Until this process stops; pages keep their local data when it is not running.' });
  try {
    await rescan({ remote: true });
    if (!signal?.aborted) await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
  } finally {
    stopping = true; clearTimeout(rescanTimer); watcher?.close();
    stopEvents(); stopStatus();
    await Promise.allSettled([...pages.keys()].map(id => closePage(id, 'stopping')));
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
