// Executors: the real side effects of each action in actions.mjs, against an
// opened world (environment.mjs). Executors return a JSON-serializable result
// that feeds the action's model effect, and may return `violations` they observe
// directly (for example a draft lost across reload).
import { join } from 'node:path';
import { expectedRetainedText } from './text.mjs';
import { launchProfile, markUiVersion, uiMarker } from './environment.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const READY = /Data: ready; application: (ready|waiting)/;
export const CONNECTED = /Connection: (connected|following|coordinating)\./;

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
  return { profiles: new Map(), knownDevices: new Set(), deviceOf: new Map(), messages: [], step: 0, traces: [] };
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

export async function waitReady(page, timeoutMs = 60_000) {
  await page.locator('#app-content').waitFor({ state: 'visible', timeout: timeoutMs });
  const result = await poll(() => page.locator('#data-status').textContent({ timeout: 2_000 }), text => READY.test(text ?? ''), { timeoutMs });
  if (!result.ok) throw Error(`Tab not ready: ${JSON.stringify(result.value)}`);
}

async function recordDevice(runtime, page, profileId, slug) {
  const key = await page.locator('#device-key').inputValue({ timeout: 5_000 }).catch(() => '');
  if (/^[a-f0-9]{64}$/.test(key)) {
    runtime.knownDevices.add(key);
    runtime.deviceOf.set(`${profileId}/${slug}`, key);
  }
  return key;
}

/** Navigate a page to a slug; enrollment happens automatically when the agent program runs. */
async function openSlug(world, runtime, page, profileId, slug, { enrollMs = 90_000, readyMs = 60_000 } = {}) {
  await page.goto(pageUrl(world, slug), { timeout: 60_000 });
  const known = runtime.deviceOf.has(`${profileId}/${slug}`);
  if (!known) {
    const key = await poll(() => page.locator('#device-key').inputValue({ timeout: 2_000 }), value => /^[a-f0-9]{64}$/.test(value ?? ''), { timeoutMs: 30_000 });
    if (!key.ok) throw Error('Browser device key did not appear');
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
    await page.locator('#note').fill(params.text);
    const typed = await page.locator('#note').inputValue();
    const retained = expectedRetainedText(typed);
    await page.locator('#submit').click();
    if (retained === null) {
      const refused = await poll(() => page.locator('#result').textContent(), text => /Write a note first|2,000 characters or fewer/.test(text ?? ''), { timeoutMs: 10_000 });
      const after = await page.locator('#operation-id').inputValue();
      return { refused: refused.ok, typedLength: typed.length, operationId: null,
        violations: after !== before ? [{ invariant: 'text-integrity', detail: 'An over-length or empty note created an operation', operationId: after }] : [] };
    }
    const settled = await poll(async () => ({ id: await page.locator('#operation-id').inputValue(),
      result: await page.locator('#result').textContent(), status: await page.locator('#operation-status').textContent() }),
    // Only text naming this attempt's operation ID counts: #result keeps the
    // previous outcome until the new command settles.
    value => value.id && value.id !== before && /^[0-9a-f-]{36}$/.test(value.id) && (value.result ?? '').includes(value.id)
      && !/Waiting for applied execution/.test(value.result ?? ''), { timeoutMs: 30_000 });
    const { id, result, status } = settled.value;
    const operationId = id && id !== before ? id : null;
    const saved = Boolean(operationId) && ((result ?? '').includes(operationId) && /Saved on this device as|Saved locally as|Applied: accepted/.test(result ?? '')
      || new RegExp(`${operationId}: (Saved on this device|Applied: accepted)`).test(status ?? ''));
    return { operationId, saved, retained, retainedLength: retained.length, typedLength: typed.length, result: result?.slice(0, 300), status: status?.slice(0, 300), settled: settled.ok };
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
      const reply = await world.tendril(['--page', params.slug, 'command', 'addNote', JSON.stringify({ text: params.text }), '--operation', params.operation], { timeoutMs: 60_000 });
      return { outcome: reply.outcome ?? null, operationId: reply.operationId ?? reply.reference?.operationId ?? null };
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

/** Read the rendered notes of one tab: [{ text, operationId, author (12-char prefix) }]. */
export async function readTabRows(page) {
  const rows = await page.evaluate(() => [...document.querySelectorAll('#notes li')].map(item => ({
    text: item.querySelector('p')?.textContent ?? '', meta: item.querySelector('small')?.textContent ?? '' })));
  return rows.map(row => {
    const match = /Author (\S+) · operation (\S+)/.exec(row.meta);
    return { text: row.text, author: match?.[1] ?? null, operationId: match?.[2] ?? null };
  });
}

export async function readTabState(page) {
  return page.evaluate(() => ({
    peer: document.getElementById('peer-status')?.textContent ?? null,
    data: document.getElementById('data-status')?.textContent ?? null,
    submission: document.getElementById('submission-status')?.textContent ?? null,
    connection: document.getElementById('connection-slot')?.textContent?.trim().slice(0, 200) ?? null,
    draft: document.getElementById('note')?.value ?? null,
    html: document.documentElement.outerHTML.match(/chaos-ui-v\d+/g) ?? [],
    url: location.href,
  }));
}

export async function readAgentRows(world, slug) {
  const reply = await world.tendril(['--page', slug, 'query', 'notes', 'null'], { timeoutMs: 30_000 });
  return reply.value.map(note => ({ text: note.text, author: note.author, operationId: note.operationId }));
}
