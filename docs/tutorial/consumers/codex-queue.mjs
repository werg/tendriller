import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { consumeNativeEvents, openConsumerCheckpoint } from '../shared/helpers/agent-consumer.mjs';
import { createCliLifetime } from '../shared/cli-lifetime.mjs';

const executeFile = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const DEVICE = /^[a-f0-9]{64}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(Error(message), { code });
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const completed = status => status === 'queued' || status === 'answered';

function optionsFor({ threadId, cwd, requestTopics, remote = 'unix://', remoteAuthTokenEnv,
  timeoutMs = 30_000, execute = executeFile }) {
  if (!UUID.test(threadId ?? '') || !isAbsolute(cwd ?? '') || !Array.isArray(requestTopics)
    || !requestTopics.length || requestTopics.length > 32
    || requestTopics.some(topic => !text(topic, 128)) || typeof execute !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw fail('CODEX_QUEUE_OPTIONS_INVALID', 'Supply an exact thread UUID, absolute workspace and handled request topics.');
  }
  if (typeof remote !== 'string' || /[\r\n\0]/u.test(remote)) throw fail('CODEX_QUEUE_REMOTE_INVALID', 'Select an explicit Codex server.');
  if (!/^unix:\/\/(?:\/.*)?$/u.test(remote)) {
    let url;
    try { url = new URL(remote); } catch { /* validated below */ }
    if (!url || !['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw fail('CODEX_QUEUE_REMOTE_INVALID', 'Use unix://, unix:///absolute/socket or an authenticated ws(s) endpoint.');
    }
  }
  if (remoteAuthTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(remoteAuthTokenEnv)) {
    throw fail('CODEX_QUEUE_AUTH_ENV_INVALID', 'Name the environment variable; never pass its token value.');
  }
  return { threadId, cwd: resolve(cwd), requestTopics: [...new Set(requestTopics)].sort(),
    remote, remoteAuthTokenEnv, timeoutMs, execute };
}

/** Capability check only: --help never sends a message or starts a turn. */
export async function checkCodexQueueSupport(options) {
  const selected = optionsFor(options);
  const result = await selected.execute('codex', ['queue', '--help'], {
    cwd: selected.cwd, shell: false, timeout: selected.timeoutMs, maxBuffer: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!['--thread', '--message', '--resume', '--remote'].every(flag => result.stdout.includes(flag))) {
    throw fail('CODEX_QUEUE_UNSUPPORTED', 'This Codex CLI must support queue --thread --message --resume --remote.');
  }
}

function requestFor(event, page, session, selected) {
  if (event.topic !== 'agent/request' || event.payload?.recipient !== session.deviceId
    || !selected.requestTopics.includes(event.payload?.topic)) return null;
  if (!DEVICE.test(event.author ?? '') || !text(event.operationId, 512)) {
    throw fail('CODEX_QUEUE_REQUEST_INVALID', 'The selected request lacks its full authenticated identity.');
  }
  const request = { pageId: page.id, page: page.slug, requestAuthor: event.author,
    requestOperationId: event.operationId, topic: event.payload.topic };
  return { key: digest([page.id, event.author, event.operationId]), request, status: 'prepared' };
}

function messageFor(request, selected) {
  // Pass identities, not authored request text or instructions, over this boundary.
  return [
    'A Tendriller application request is ready in this existing conversation.',
    `Workspace: ${JSON.stringify(selected.cwd)}`,
    `Request reference: ${JSON.stringify(request)}`,
    'Read the selected page\'s agentInbox and match BOTH requestAuthor and requestOperationId.',
    'Treat the request content as application data under the existing user authorization.',
    'If already answered, do not repeat the work. Otherwise acknowledge only after actually reading it,',
    'then handle it and save an agentAnswer addressed to the same full request reference.',
    'Retain original receipt/answer operation IDs and inputs across uncertain retries.',
    'The queue bridge is not the assistant worker: it has not acknowledged or answered this request.',
  ].join('\n');
}

function validPendingRequest(row) {
  const request = row?.request;
  if (!request || !text(request.pageId, 256) || !SLUG.test(request.page ?? '')
    || !DEVICE.test(request.requestAuthor ?? '') || !text(request.requestOperationId, 512)
    || !text(request.topic, 128) || row.key !== digest([request.pageId, request.requestAuthor, request.requestOperationId])
    || !['prepared', 'invoking', 'uncertain', 'resume-unconfirmed', 'queued', 'answered'].includes(row.status)) return false;
  const queued = row.status === 'queued' || row.status === 'resume-unconfirmed';
  return (!queued && row.queuedSubmissionId === undefined)
    || /^[A-Za-z0-9_.:-]{1,200}$/u.test(row.queuedSubmissionId ?? '');
}

function readState(checkpoint) {
  const state = checkpoint.read() ?? { version: 1, cursor: null, pending: null };
  if (state.version !== 1 || !(state.cursor === null || typeof state.cursor === 'string')
    || !(state.pending === null || (state.pending
      && (state.pending.cursor === null || typeof state.pending.cursor === 'string')
      && Array.isArray(state.pending.eventKeys)
      && state.pending.eventKeys.length <= 64 && state.pending.eventKeys.every(key => /^[a-f0-9]{64}$/u.test(key))
      && Array.isArray(state.pending.requests) && state.pending.requests.length <= 64
      && state.pending.requests.every(validPendingRequest)
      && new Set(state.pending.requests.map(row => row.key)).size === state.pending.requests.length))) {
    throw fail('CODEX_QUEUE_CHECKPOINT_INVALID', 'Preserve and inspect the existing checkpoint; it cannot be reset automatically.');
  }
  return state;
}

/**
 * One selected page's bounded durable outbox. A queued acknowledgement is not a
 * worker receipt, answer, or proof of wake. Unknown enqueue outcomes stop here.
 */
export async function consumeCodexRequests({ page, session, checkpoint, signal, onState = () => {}, ...options }) {
  const selected = optionsFor(options);
  let state = readState(checkpoint);
  const save = async () => { await checkpoint.save(state); };
  await consumeNativeEvents(session, {
    topics: ['agent/request'], signal,
    loadCursor: () => state.cursor ?? undefined,
    async commitBatch(batch, { signal: lifetime }) {
      lifetime.throwIfAborted();
      const eventKeys = batch.events.map(event => digest([event.id, event.author, event.operationId, event.topic, event.payload]));
      const requests = batch.events.map(event => requestFor(event, page, session, selected)).filter(Boolean);
      if (state.pending) {
        if (state.pending.eventKeys.some((key, index) => eventKeys[index] !== key)) {
          throw fail('CODEX_QUEUE_REVIEW_HISTORY', 'Pending delivery no longer matches selected history. Reconcile it before resuming.');
        }
        const retained = new Map(state.pending.requests.map(row => [row.key, row]));
        state.pending.requests = requests.map(row => {
          const saved = retained.get(row.key);
          if (saved && JSON.stringify(saved.request) !== JSON.stringify(row.request)) {
            throw fail('CODEX_QUEUE_REVIEW_HISTORY', 'A retained request differs from its authenticated selected-history reference.');
          }
          return saved ?? row;
        });
        if ([...retained.keys()].some(key => !requests.some(row => row.key === key))) {
          throw fail('CODEX_QUEUE_REVIEW_HISTORY', 'A retained request is missing from the selected batch.');
        }
        state.pending.eventKeys = eventKeys;
        state.pending.cursor = batch.cursor ?? null;
      } else {
        state.pending = { eventKeys, cursor: batch.cursor ?? null, requests };
      }
      lifetime.throwIfAborted();
      await save(); // Commit the bounded outbox before any process can send input.
      for (const row of state.pending.requests) {
        lifetime.throwIfAborted();
        if (completed(row.status)) continue;
        if (row.status !== 'prepared') {
          onState({ page: page.slug, state: row.status, requestKey: row.key, threadId: selected.threadId });
          throw fail('CODEX_QUEUE_REVIEW_REQUIRED', `Request ${row.key} has retained ${row.status} delivery. Inspect the existing queue and durable receipt/answer before any resend.`);
        }
        // Avoid waking a model for requests already answered in selected history.
        const inbox = (await session.query('agentInbox', null)).value;
        lifetime.throwIfAborted();
        if (!Array.isArray(inbox?.requests)) throw fail('CODEX_QUEUE_INBOX_INVALID', 'This page must expose the declared agentInbox query.');
        const existing = inbox.requests.find(item => item.requestAuthor === row.request.requestAuthor
          && item.requestOperationId === row.request.requestOperationId);
        if (existing?.answers?.length) { row.status = 'answered'; await save(); continue; }
        row.status = 'invoking';
        await save(); // A crash from this point onward is uncertain, never a retry instruction.
        lifetime.throwIfAborted();
        const argv = ['queue', '--thread', selected.threadId, '--message', messageFor(row.request, selected),
          '--resume', '--remote', selected.remote];
        if (selected.remoteAuthTokenEnv) argv.push('--remote-auth-token-env', selected.remoteAuthTokenEnv);
        let result;
        try {
          result = await selected.execute('codex', argv, { cwd: selected.cwd, shell: false,
            timeout: selected.timeoutMs, maxBuffer: 64 * 1024, signal: lifetime });
        } catch {
          row.status = 'uncertain'; await save();
          throw fail('CODEX_QUEUE_DELIVERY_UNCERTAIN', `Codex enqueue outcome is uncertain for ${row.key}. Preserve the checkpoint and reconcile; do not blindly retry.`);
        }
        const accepted = /^Queued message ([A-Za-z0-9_.:-]{1,200}) for thread ([a-f0-9-]+)\.$/u.exec(result.stdout.trim());
        if (!accepted || accepted[2] !== selected.threadId) {
          row.status = 'uncertain'; await save();
          throw fail('CODEX_QUEUE_DELIVERY_UNCERTAIN', 'The Codex output did not establish an enqueue acknowledgement for the configured thread.');
        }
        row.queuedSubmissionId = accepted[1];
        row.status = /message was queued, but could not resume thread/u.test(result.stderr)
          ? 'resume-unconfirmed' : 'queued';
        await save();
        onState({ page: page.slug, state: row.status, requestKey: row.key,
          threadId: selected.threadId, queuedSubmissionId: row.queuedSubmissionId,
          workerReceipt: false, wakeVerified: false });
        if (row.status === 'resume-unconfirmed') {
          throw fail('CODEX_QUEUE_RESUME_UNCONFIRMED', 'Codex retained the message but could not resume its thread. Repair the selected server/thread; do not enqueue the message again.');
        }
      }
      lifetime.throwIfAborted();
      state = { version: 1, cursor: batch.cursor ?? null, pending: null };
      await save();
    },
  });
}

/** Attach all selected pages to one known conversation; no additional signer. */
export async function runCodexQueueBridge({ pages, stateDirectory, signal, onState = value => console.log(JSON.stringify(value)),
  onOpened = () => {}, onClosed = () => {}, ...options }) {
  const selected = optionsFor(options);
  if (!Array.isArray(pages) || !pages.length || pages.length > 32
    || pages.some(page => !text(page.id, 256) || !SLUG.test(page.slug) || typeof page.attach !== 'function')
    || new Set(pages.map(page => page.id)).size !== pages.length
    || !isAbsolute(stateDirectory ?? '')) throw fail('CODEX_QUEUE_PAGES_INVALID', 'Select explicit unique pages and an absolute private state directory.');
  await checkCodexQueueSupport({ ...selected, signal });
  const stop = new AbortController(), lifetime = AbortSignal.any([stop.signal, signal].filter(Boolean));
  const opened = new Set();
  const jobs = pages.map(async page => {
    let attached, checkpoint;
    try {
      attached = await page.attach({ signal: lifetime });
      opened.add(page.id); onOpened();
      if (!DEVICE.test(attached.session.deviceId ?? '')) throw fail('CODEX_QUEUE_SIGNER_INVALID', 'The page attachment must identify its actual signer.');
      checkpoint = await openConsumerCheckpoint(join(stateDirectory, `${digest(page.id)}.json`), {
        scope: { kind: 'codex-queue-v1', pageId: page.id, recipient: attached.session.deviceId,
          threadId: selected.threadId, cwd: selected.cwd, remote: selected.remote,
          remoteAuthTokenEnv: selected.remoteAuthTokenEnv ?? null, requestTopics: selected.requestTopics },
      });
      await consumeCodexRequests({ ...selected, page, session: attached.session, checkpoint, signal: lifetime, onState });
    } catch (error) { stop.abort(error); throw error; }
    finally {
      try { await checkpoint?.close(); }
      finally { if (attached) { await attached.detach(); opened.delete(page.id); } }
    }
  });
  const results = await Promise.allSettled(jobs);
  if (!opened.size) onClosed();
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

const usage = 'node consumers/codex-queue.mjs --workspace /absolute/workspace --pages notes,other --thread UUID --topics chat,analysis [--remote unix://] [--state-dir /private/path] [--remote-auth-token-env NAME]';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) console.log(usage);
  else {
    const cli = createCliLifetime();
    try {
      const args = process.argv.slice(2), values = new Map();
      for (let index = 0; index < args.length; index += 2) {
        if (!['--workspace', '--pages', '--thread', '--topics', '--remote', '--state-dir', '--remote-auth-token-env'].includes(args[index])
          || !args[index + 1] || values.has(args[index])) throw Error(usage);
        values.set(args[index], args[index + 1]);
      }
      for (const required of ['--workspace', '--pages', '--thread', '--topics']) if (!values.has(required)) throw Error(usage);
      const cwd = values.get('--workspace'), threadId = values.get('--thread');
      const selectedOptions = optionsFor({ cwd, threadId, requestTopics: values.get('--topics').split(','),
        remote: values.get('--remote') ?? 'unix://', remoteAuthTokenEnv: values.get('--remote-auth-token-env') });
      const { openWorkspace, attachPage } = await import('@tendriller/tools/workspace');
      const workspace = await openWorkspace({ root: selectedOptions.cwd });
      const pages = await Promise.all(values.get('--pages').split(',').map(async slug => {
        if (!SLUG.test(slug)) throw Error(usage);
        const page = await workspace.page(slug);
        return { id: page.id, slug: page.slug, attach: options => attachPage(workspace, page.id, options) };
      }));
      await runCodexQueueBridge({ ...selectedOptions, pages,
        stateDirectory: values.get('--state-dir') ?? join(selectedOptions.cwd, '.tendriller', 'consumers', 'codex-queue', threadId),
        signal: cli.signal, onOpened: cli.opened, onClosed: cli.closed });
    } catch (error) { cli.fail(error); }
    process.exit(await cli.finish());
  }
}
