// Executors: the real side effects of each action in actions.mjs, against an
// opened world (environment.mjs). Executors return a JSON-serializable result
// that feeds the action's model effect, and may return `violations` they observe
// directly (for example a draft lost across reload).
import { join } from 'node:path';
import { expectedRetainedText } from './text.mjs';
import { launchProfile, markUiVersion, uiMarker, OWNER_PROFILE } from './environment.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Notes template (authored-time CRDT kit): #connection-status reports
// `Local signing and storage ready · N connected peers · database X`, and #count
// reports the rendered live materialized snapshot (`… · local snapshot <digest> · revisable`,
// or `— not current` when the live view failed). There is no #data-status/#peer-status.
const AUTHOR_READY = /^Local signing and storage ready · /;
export const CONNECTED = /^Local signing and storage ready · [1-9]\d* connected peers/;
const SNAPSHOT_CURRENT = /local snapshot [0-9a-f]{12} · revisable/;
/** Heal liveness: local author+storage ready, at least one connected peer, and a current rendered snapshot. */
export const isConnectedAndReady = view => !view.error && CONNECTED.test(view.peer ?? '') && SNAPSHOT_CURRENT.test(view.data ?? '') && !view.viewError;

export async function poll(read, done, { timeoutMs, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await read().catch(error => ({ error: error.message }));
    if (done(value)) return { ok: true, value };
    if (Date.now() >= deadline) return { ok: false, value };
    await sleep(intervalMs);
  }
}

/** Runtime handles beside the model: contexts, pages, device keys and collected messages. */
export function createRuntime() {
  return { profiles: new Map(), knownDevices: new Set(), deviceOf: new Map(), messages: [], recoveries: [], admissions: [], step: 0, traces: [] };
}

const pageUrl = (world, slug) => world.golden.pages[slug].page_url;

export function watchPage(runtime, page, label) {
  page.on('pageerror', error => runtime.messages.push({ type: 'pageerror', text: String(error?.stack ?? error?.message ?? error).slice(0, 2_000), tab: label, step: runtime.step, at: new Date().toISOString() }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (runtime.messages.length < 5_000) runtime.messages.push({ type: 'console', text: message.text().slice(0, 1_000), tab: label, step: runtime.step, at: new Date().toISOString() });
  });
  page.on('crash', () => runtime.messages.push({ type: 'pageerror', text: 'PAGE_CRASHED', tab: label, step: runtime.step, at: new Date().toISOString() }));
}

const readyState = page => page.evaluate(() => ({
  connection: document.getElementById('connection-status')?.textContent ?? null,
  count: document.getElementById('count')?.textContent ?? null,
  submit: document.getElementById('submit') ? !document.getElementById('submit').disabled : null,
  submission: document.getElementById('submission-status')?.textContent ?? null }));

/** Ready = this device can author locally and its live view rendered a current snapshot (no peer requirement). */
export async function waitReady(page, timeoutMs = 60_000) {
  const result = await poll(() => readyState(page), value => AUTHOR_READY.test(value.connection ?? '') && SNAPSHOT_CURRENT.test(value.count ?? ''), { timeoutMs });
  if (!result.ok) throw Error(`Tab not ready: ${JSON.stringify(result.value)}`);
}

async function recordDevice(runtime, page, profileId, slug) {
  const key = await page.locator('#public-key').inputValue({ timeout: 5_000 }).catch(() => '');
  if (/^[a-f0-9]{64}$/.test(key)) {
    runtime.knownDevices.add(key);
    runtime.deviceOf.set(`${profileId}/${slug}`, key);
  }
  return key;
}

/**
 * A new owner-account browser is admitted automatically: any online member (the
 * agent program or another open profile) verifies its host attestation, signs the
 * admission and wraps the page keys. Nothing is copied. When no member is online
 * the harness owner profile (the page creator) is opened until it has admitted the
 * newcomer, then closed again.
 */
async function admitFromOnlineMember(world, runtime, page, slug) {
  const started = Date.now();
  const recipientKey = await page.locator('#public-key').inputValue();
  let via = 'online-member';
  const admitted = await poll(() => page.locator('#submit').isEnabled({ timeout: 2_000 }), value => value === true, { timeoutMs: 20_000 });
  if (!admitted.ok) {
    via = 'owner-profile';
    const owner = await launchProfile(world, OWNER_PROFILE, { trace: false });
    try {
      const member = owner.pages()[0] ?? await owner.newPage();
      watchPage(runtime, member, `${OWNER_PROFILE}/${slug}`);
      await member.goto(pageUrl(world, slug), { timeout: 60_000 });
      const ready = await poll(() => member.locator('#submit').isEnabled({ timeout: 2_000 }), value => value === true, { timeoutMs: 60_000 });
      if (!ready.ok) throw Error(`Owner device not ready to admit on ${slug}: ${JSON.stringify(await readyState(member).catch(error => error.message))}`);
      const enabled = await poll(() => page.locator('#submit').isEnabled({ timeout: 2_000 }), value => value === true, { timeoutMs: 60_000 });
      if (!enabled.ok) throw Error(`Automatic admission did not enable Save on ${slug}: ${await page.locator('#devices').textContent().catch(() => '')}`);
    } finally { await owner.close().catch(() => {}); }
  }
  runtime.admissions.push({ slug, recipient: recipientKey, via, step: runtime.step, ms: Date.now() - started });
}

/** Navigate a page to a slug; a browser not yet admitted there is admitted automatically by an online member. */
async function openSlug(world, runtime, page, profileId, slug, { enrollMs = 90_000, readyMs = 60_000 } = {}) {
  await page.goto(pageUrl(world, slug), { timeout: 60_000 });
  const known = runtime.deviceOf.has(`${profileId}/${slug}`);
  if (!known) {
    const key = await poll(() => page.locator('#public-key').inputValue({ timeout: 2_000 }), value => /^[a-f0-9]{64}$/.test(value ?? ''), { timeoutMs: 30_000 });
    if (!key.ok) throw Error('Browser device key did not appear');
    // A brand-new device on this page origin cannot author until an online member admits it.
    const authorized = await poll(() => readyState(page), value => AUTHOR_READY.test(value.connection ?? ''), { timeoutMs: 5_000 });
    if (!authorized.ok) await admitFromOnlineMember(world, runtime, page, slug);
  }
  await waitReady(page, known ? readyMs : enrollMs);
  const key = await recordDevice(runtime, page, profileId, slug);
  if (known && key !== runtime.deviceOf.get(`${profileId}/${slug}`))
    return { violation: { invariant: 'known-authors', profile: profileId, slug, detail: 'Browser device key changed for an existing profile', before: runtime.deviceOf.get(`${profileId}/${slug}`), after: key } };
  return {};
}

function profileHandle(runtime, id) {
  const handle = runtime.profiles.get(id);
  if (!handle?.context) throw Error(`Profile ${id} is not open`);
  return handle;
}
function tabPage(runtime, profileId, tabId) {
  const page = profileHandle(runtime, profileId).tabs.get(tabId);
  if (!page || page.isClosed()) throw Error(`Tab ${profileId}/${tabId} is not open`);
  return page;
}
async function newTab(runtime, profileId, tabId) {
  const handle = profileHandle(runtime, profileId);
  const spare = handle.context.pages().find(page => ![...handle.tabs.values()].includes(page) && page.url() === 'about:blank');
  const page = spare ?? await handle.context.newPage();
  watchPage(runtime, page, `${profileId}/${tabId}`);
  handle.tabs.set(tabId, page);
  return page;
}

/** Open a new tab of an open profile on a page (used by heal to deliver parked work). */
export async function openTabOn(world, runtime, profileId, tabId, slug) {
  const page = await newTab(runtime, profileId, tabId);
  return openSlug(world, runtime, page, profileId, slug);
}

async function stopTrace(world, runtime, profileId, reason) {
  const handle = runtime.profiles.get(profileId);
  if (!world.trace || !handle?.context) return;
  const path = join(world.logs, `trace-${profileId}-${runtime.traces.length}.zip`);
  await handle.context.tracing.stop({ path }).then(() => runtime.traces.push({ profile: profileId, path, reason }), () => {});
}

export const EXECUTORS = {
  async 'browser.enroll'(world, runtime, params) {
    const context = await launchProfile(world, params.profile);
    runtime.profiles.set(params.profile, { context, tabs: new Map() });
    const page = await newTab(runtime, params.profile, params.tab);
    const opened = await openSlug(world, runtime, page, params.profile, params.slug);
    return { device: runtime.deviceOf.get(`${params.profile}/${params.slug}`), violations: opened.violation ? [opened.violation] : [] };
  },

  async 'browser.addNote'(world, runtime, params) {
    const page = tabPage(runtime, params.profile, params.tab);
    const enabled = await poll(() => page.locator('#submit').isEnabled({ timeout: 2_000 }), value => value === true, { timeoutMs: 20_000 });
    if (!enabled.ok) return { skipped: 'submit-disabled', submission: await page.locator('#submission-status').textContent().catch(() => null) };
    const before = await page.locator('#operation-id').inputValue();
    // The candidate editor keeps editing the same note id after a save; adding a
    // note is "New note" then Save (as the kit's own qualification does).
    await page.locator('#new').click();
    await page.locator('#note').fill(params.text);
    const typed = await page.locator('#note').inputValue();
    const retained = expectedRetainedText(typed);
    await page.locator('#submit').click();
    // The page writes the new ID into #operation-id before dispatch; whether an
    // operation was actually created is the local journal's answer.
    const storedOperation = id => page.evaluate(async id => {
      const operation = await window.tendril.application.backend.operations.get(id);
      return operation ? (await operation.inspect()).stored === true : false;
    }, id).catch(() => false);
    if (retained === null) {
      await sleep(2_000);
      const after = await page.locator('#operation-id').inputValue();
      const created = after !== before && Boolean(after) && await storedOperation(after);
      return { refused: !created, typedLength: typed.length, operationId: null, status: (await page.locator('#operation-status').textContent().catch(() => null))?.slice(0, 300),
        violations: created ? [{ invariant: 'text-integrity', detail: 'An over-length or empty note created an operation', operationId: after }] : [] };
    }
    const settled = await poll(async () => ({ id: await page.locator('#operation-id').inputValue(),
      status: await page.locator('#operation-status').textContent(), submission: await page.locator('#submission-status').textContent() }),
    // Only facts naming this attempt's operation ID count; a failed dispatch names it in its retry advice.
    value => value.id && value.id !== before && /^[0-9a-f-]{36}$/.test(value.id) && (value.status ?? '').includes(value.id)
      && (/Stored locally: (yes|no)/.test(value.status ?? '') || /Inspect or retry the retained operation/.test(value.status ?? '')), { timeoutMs: 30_000 });
    const { id, status } = settled.value;
    const operationId = id && id !== before ? id : null;
    const shown = Boolean(operationId) && (status ?? '').startsWith(`Operation: ${operationId}\n`) && /\nStored locally: yes/.test(status ?? '');
    const saved = shown || (Boolean(operationId) && await storedOperation(operationId));
    return { operationId, saved, savedShown: shown, retained, retainedLength: retained.length, typedLength: typed.length, status: status?.slice(0, 300), settled: settled.ok };
  },

  async 'browser.draftReload'(world, runtime, params) {
    const page = tabPage(runtime, params.profile, params.tab);
    await page.locator('#note').fill(params.text);
    await sleep(100);
    await page.reload({ timeout: 60_000 });
    const kept = await poll(() => page.locator('#note').inputValue({ timeout: 2_000 }), value => value === params.text, { timeoutMs: 20_000 });
    const ready = await waitReady(page, 60_000).then(() => true, error => error.message);
    return { kept: kept.ok, ready, violations: kept.ok ? [] : [{ invariant: 'draft-survives-reload', profile: params.profile, tab: params.tab, slug: params.slug,
      expected: params.text.slice(0, 120), actual: typeof kept.value === 'string' ? kept.value.slice(0, 120) : kept.value }] };
  },

  async 'browser.reload'(world, runtime, params) {
    const page = tabPage(runtime, params.profile, params.tab);
    await page.reload({ timeout: 60_000 });
    await waitReady(page);
    return {};
  },

  async 'browser.reopenTab'(world, runtime, params) {
    const handle = profileHandle(runtime, params.profile);
    const page = tabPage(runtime, params.profile, params.tab);
    await page.close({ runBeforeUnload: false });
    handle.tabs.delete(params.tab);
    const next = await newTab(runtime, params.profile, params.next);
    const opened = await openSlug(world, runtime, next, params.profile, params.slug);
    return { violations: opened.violation ? [opened.violation] : [] };
  },

  async 'browser.secondTab'(world, runtime, params) {
    const page = await newTab(runtime, params.profile, params.tab);
    const opened = await openSlug(world, runtime, page, params.profile, params.slug);
    return { violations: opened.violation ? [opened.violation] : [] };
  },

  async 'browser.closeTab'(world, runtime, params) {
    const handle = profileHandle(runtime, params.profile);
    await handle.tabs.get(params.tab)?.close({ runBeforeUnload: false });
    handle.tabs.delete(params.tab);
    return {};
  },

  async 'browser.navigate'(world, runtime, params) {
    const page = tabPage(runtime, params.profile, params.tab);
    const opened = await openSlug(world, runtime, page, params.profile, params.slug);
    return { violations: opened.violation ? [opened.violation] : [] };
  },

  async 'browser.offline'(world, runtime, params) { await profileHandle(runtime, params.profile).context.setOffline(true); return {}; },
  async 'browser.online'(world, runtime, params) { await profileHandle(runtime, params.profile).context.setOffline(false); return {}; },

  async 'browser.closeProfile'(world, runtime, params) {
    await stopTrace(world, runtime, params.profile, 'closed');
    const handle = profileHandle(runtime, params.profile);
    await handle.context.close();
    runtime.profiles.set(params.profile, { context: null, tabs: new Map() });
    return {};
  },

  async 'browser.reopenProfile'(world, runtime, params, model) {
    const context = await launchProfile(world, params.profile);
    runtime.profiles.set(params.profile, { context, tabs: new Map() });
    const profile = model.profiles.find(item => item.id === params.profile);
    const violations = [];
    for (const tab of profile.tabs) {
      const page = await newTab(runtime, params.profile, tab.id);
      if (tab.slug) {
        const opened = await openSlug(world, runtime, page, params.profile, tab.slug);
        if (opened.violation) violations.push(opened.violation);
      }
    }
    return { tabs: profile.tabs.length, violations };
  },

  async 'race.saveKill'(world, runtime, params, model) {
    const kill = sleep(params.delayMs).then(() => world.killAgent('SIGKILL'));
    const [saved, exit] = await Promise.all([EXECUTORS['browser.addNote'](world, runtime, params, model), kill]);
    return { ...saved, exit };
  },

  async 'agent.command'(world, runtime, params) {
    try {
      // Candidate notes domain: putNote with a fresh stable note id (the old addNote created a new note).
      const reply = await world.tendril(['--page', params.slug, 'command', 'putNote', JSON.stringify({ noteId: params.operation, text: params.text }),
        '--operation', params.operation, '--wait', 'materialized'], { timeoutMs: 60_000 });
      return { outcome: reply.materialized?.outcome ?? null, stored: reply.stored ?? null, operationId: reply.operationId ?? null, proposalId: reply.proposalId ?? null };
    } catch (error) { return { uncertain: true, error: String(error.stderr || error.message).slice(-800) }; }
  },

  async 'agent.kill'(world) { return { exit: await world.killAgent('SIGKILL') }; },
  async 'agent.stop'(world) {
    const exit = await world.killAgent('SIGTERM');
    return { exit, cleanExit: exit?.code === 0 && exit?.signal === null };
  },
  async 'agent.start'(world) {
    const started = Date.now();
    try { await world.startAgent(); return { ms: Date.now() - started }; }
    catch (error) {
      return { ms: Date.now() - started, violations: [{ invariant: 'agent-restarts', error: error.message.slice(0, 2_000) }] };
    }
  },
  async 'agent.pause'(world) { world.signalAgent('SIGSTOP'); return {}; },
  async 'agent.resume'(world) { world.signalAgent('SIGCONT'); return {}; },

  async 'publish'(world, runtime, params) {
    const built = join(world.app, world.golden.pages[params.slug].built);
    await markUiVersion(built, params.version);
    try {
      const reply = await world.tendril(['--page', params.slug, 'publish', built, '--operation', `chaos-${params.slug}-publication-${params.version}`], { timeoutMs: 120_000 });
      return { published: Boolean(reply.publication?.id), id: reply.publication?.id ?? null, marker: uiMarker(params.version) };
    } catch (error) { return { published: false, error: String(error.stderr || error.message).slice(-800) }; }
  },

  async 'host.restart'(world) {
    const started = Date.now();
    await world.restartHost();
    return { ms: Date.now() - started };
  },

  async 'net.fault'(world, runtime, params) {
    if (!world.faults) throw Error('Network faults are unavailable outside the Docker lab');
    if (params.kind === 'udp-blocked') await world.faults.blockUdp(); else await world.faults.impair();
    return {};
  },
  async 'net.restore'(world, runtime, params, model) {
    if (!world.faults) throw Error('Network faults are unavailable outside the Docker lab');
    if (model.network === 'udp-blocked') await world.faults.restoreUdp(); else await world.faults.restoreImpairment();
    return {};
  },

  async 'wait'(world, runtime, params) { await sleep(params.ms); return {}; },
};

/**
 * Read the notes a tab shows: [{ text, operationId, author }]. The candidate list
 * renders only a (180-unit truncated) label per note, so the full text, author and
 * operation ID come from the tab's own materialized snapshot (the same note.put /
 * note.deleted derivation its live view renders), and a note counts only if its
 * label is actually rendered in #notes.
 */
export async function readTabRows(page) {
  const { dom, notes } = await page.evaluate(async () => {
    const dom = [...document.querySelectorAll('#notes li a')].map(link => link.textContent ?? '');
    const backend = window.tendril?.application?.backend;
    if (!backend) throw Error('No installed application backend');
    const view = await backend.readView();
    const notes = new Map(); let cursor;
    try {
      for (;;) {
        const batch = await view.readEvents({ topics: ['note.put', 'note.deleted'], limit: 128, ...(cursor ? { cursor } : {}) });
        for (const event of batch.events) {
          if (event.topic === 'note.deleted') notes.delete(event.payload.noteId);
          else notes.set(event.payload.noteId, { text: event.payload.text, author: event.author, operationId: event.operationId });
        }
        if (!batch.hasMore || cursor === batch.cursor) break;
        cursor = batch.cursor;
      }
    } finally { await view.release(); }
    return { dom, notes: [...notes.values()] };
  });
  const labels = new Map();
  for (const label of dom) labels.set(label, (labels.get(label) ?? 0) + 1);
  const rows = [];
  for (const note of notes) {
    const label = note.text.length > 180 ? note.text.slice(0, 180) + '…' : note.text;
    if (!labels.get(label)) continue;
    labels.set(label, labels.get(label) - 1);
    rows.push({ text: note.text, author: note.author ?? null, operationId: note.operationId ?? null });
  }
  return rows;
}

export async function readTabState(page) {
  return page.evaluate(() => {
    const viewError = document.getElementById('view-error');
    const operation = document.getElementById('operation-status')?.textContent ?? null;
    return {
      peer: document.getElementById('connection-status')?.textContent ?? null,
      data: document.getElementById('count')?.textContent ?? null,
      viewError: viewError && !viewError.hidden ? viewError.textContent : null,
      submission: document.getElementById('submission-status')?.textContent ?? null,
      connection: document.getElementById('connection-status')?.textContent?.trim().slice(0, 200) ?? null,
      draft: document.getElementById('note')?.value ?? null,
      operation: operation?.slice(0, 400) ?? null,
      // There is no "selected history changed" notice. Record what the UI does
      // show instead: an excluded selected operation, or a not-current live view.
      recovery: /Excluded: yes/.test(operation ?? '') ? operation.slice(0, 400) : viewError && !viewError.hidden ? viewError.textContent : null,
      html: document.documentElement.outerHTML.match(/chaos-ui-v\d+/g) ?? [],
      url: location.href,
    };
  });
}

/** Excluded-or-not facts for operation IDs as this tab's local journal knows them (diagnostic only). */
export async function readExcludedFacts(page, operationIds) {
  return page.evaluate(async ids => {
    const out = {};
    for (const id of ids) {
      const operation = await window.tendril.application.backend.operations.get(id).catch(error => ({ error: error.message }));
      if (!operation) { out[id] = null; continue; }
      if (operation.error) { out[id] = { error: operation.error }; continue; }
      const facts = await operation.inspect();
      out[id] = { stored: facts.stored, excluded: facts.excluded, finalized: facts.finalized, materialized: facts.materialized?.outcome ?? null };
    }
    return out;
  }, operationIds);
}

export async function readAgentRows(world, slug) {
  const reply = await world.tendril(['--page', slug, 'query', 'notes', 'null'], { timeoutMs: 30_000 });
  return reply.value.map(note => ({ text: note.text, author: note.author, operationId: note.operationId }));
}
