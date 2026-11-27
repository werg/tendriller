import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeCodexBroadcasts,
  consumeCodexRequests,
  createCodexConversationLiveness,
  runCodexQueueBridge,
} from '../../docs/tutorial/consumers/codex-queue.mjs';
import { openConsumerCheckpoint } from '../../docs/tutorial/shared/helpers/agent-consumer.mjs';
import { messageDelivery, watchAgentsPresence } from '../../docs/tutorial/shared/helpers/agent-requests.mjs';
import {
  evaluateBroadcastMatch,
  generateBroadcastKeyPair,
  signBroadcastPayload,
  verifyBroadcastSignature,
} from '../../contract/broadcasts.mjs';

const threadId = '01234567-89ab-4cde-8fab-0123456789ab';
const deviceId = '11'.repeat(32);
const author = '22'.repeat(32);
const baseOptions = { threadId, cwd: '/workspace/project', requestTopics: ['chat'], remote: 'unix://' };
const ack = id => ({ stdout: `Queued message ${id} for thread ${threadId}.\n`, stderr: '' });
const rpcError = message => Object.assign(Error('Rejected'), { code: 'CODEX_RPC_REJECTED', rpcCode: -32600, rpcMessage: message });

function rpcFor({ snapshots = [{ runtime: 'idle', status: 'completed', id: 'turn-old' }],
  steer = async params => ({ turnId: params.expectedTurnId }), fail = false } = {}) {
  const calls = [];
  let read = -1;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (fail) throw Object.assign(Error('CODEX_DAEMON_DOWN'), { code: 'CODEX_DAEMON_DOWN' });
      if (method === 'thread/read') {
        read++;
        const s = snapshots[Math.min(read, snapshots.length - 1)];
        return { thread: { id: threadId, cwd: baseOptions.cwd, status: { type: s.runtime }, canAcceptDirectInput: s.canAcceptDirectInput ?? true } };
      }
      if (method === 'thread/turns/list') {
        const s = snapshots[Math.min(read, snapshots.length - 1)];
        return { data: s.id ? [{ id: s.id, status: s.status, items: [], itemsView: 'notLoaded' }] : [] };
      }
      if (method === 'turn/steer') return steer(params);
      throw Error(`Unexpected RPC method: ${method}`);
    },
    async close() {},
  };
  return { client, calls };
}

function createMockSignalPair(agentPublicKey = deviceId) {
  const subs = { native: new Set(), browser: new Set() };
  const latest = { native: new Map(), browser: new Map() };
  let seq = 0;
  const statusListeners = { native: new Set(), browser: new Set() };
  const peers = { native: 1, browser: 1 };

  const makeSide = side => {
    const other = side === 'native' ? 'browser' : 'native';
    const stop = new AbortController();
    return {
      identity: { publicKey: side === 'native' ? agentPublicKey : '99'.repeat(32) },
      signal: stop.signal,
      get status() { return { connectedPeers: peers[side], connectionRevision: 1 }; },
      onStatus(fn) { statusListeners[side].add(fn); return () => statusListeners[side].delete(fn); },
      async authority() { return { members: [{ publicKey: agentPublicKey, reader: true, writer: true }] }; },
      signals: {
        async send(topic, payload, options = {}) {
          const frame = {
            authorId: side === 'native' ? agentPublicKey : '99'.repeat(32),
            sessionId: `${side}-session`,
            sequence: ++seq,
            topic,
            payload,
            expiresAtMs: Date.now() + (options.ttlMs ?? 30_000),
          };
          const key = `${topic}:${frame.authorId}:${options.stream?.streamId ?? ''}`;
          latest[other].set(key, frame);
          for (const listener of subs[other]) listener(frame);
        },
        async *subscribe({ topics, includeLatest = false, signal }) {
          const combined = AbortSignal.any([stop.signal, signal].filter(Boolean));
          const queue = [];
          let wake = null;
          const push = frame => {
            if (!topics.includes(frame.topic)) return;
            if (wake) { const fn = wake; wake = null; fn(frame); }
            else queue.push(frame);
          };
          if (includeLatest) {
            for (const frame of latest[side].values()) push(frame);
          }
          subs[side].add(push);
          try {
            while (!combined.aborted) {
              if (queue.length) { yield queue.shift(); continue; }
              const next = await new Promise((resolve, reject) => {
                if (combined.aborted) { reject(combined.reason); return; }
                const onAbort = () => { wake = null; reject(combined.reason); };
                wake = frame => { combined.removeEventListener('abort', onAbort); resolve(frame); };
                combined.addEventListener('abort', onAbort, { once: true });
              });
              yield next;
            }
          } finally { subs[side].delete(push); }
        },
      },
      close() { stop.abort(); },
    };
  };

  return { native: makeSide('native'), browser: makeSide('browser') };
}

const waitUntil = async (fn, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 15));
  }
  assert.ok(fn(), 'condition did not become true before timeout');
};

// ───────────────────────────────────────────────────────────────────────────
// Issue #145: Stale checkpoint lock recovery (reboot, crash, reused PID, live contenders, uncertain admission, startup wait)
// ───────────────────────────────────────────────────────────────────────────

test('#145 recovers stale locks after reboot, dead process, and reused PID while blocking live contenders and preserving uncertain admissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lock-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'page.json');
  const lockDir = path + '.lock';
  const scope = { threadId, cwd: baseOptions.cwd, page: 'p1' };

  // 1. Reboot recovery (different bootId), preserving checkpoint contents untouched.
  const first = await openConsumerCheckpoint(path, {
    scope,
    _lockEnv: { pid: () => 4001, hostname: () => 'box-a', readBootId: async () => 'boot-1', readProcessStart: async () => '100', isPidAlive: () => true },
  });
  await first.save({ version: 1, cursor: null, pending: { eventKeys: ['a'.repeat(64)], cursor: null, requests: [] }, delivered: [] });
  // Simulate abrupt reboot (do NOT call first.close() — lock stays on disk with boot-1).

  const recovered = [];
  const afterReboot = await openConsumerCheckpoint(path, {
    scope,
    onRecoveredStaleLock: info => recovered.push(info),
    _lockEnv: { pid: () => 4001, hostname: () => 'box-a', readBootId: async () => 'boot-2', readProcessStart: async () => '100', isPidAlive: () => true },
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].reason, 'reboot');
  assert.ok(afterReboot.read().pending, 'checkpoint contents must be preserved intact across stale-lock recovery');

  // 2. Live contender on the SAME boot, SAME PID+startTime must fail closed with AGENT_CONSUMER_LOCKED.
  await assert.rejects(openConsumerCheckpoint(path, {
    scope,
    _lockEnv: { pid: () => 4002, hostname: () => 'box-a', readBootId: async () => 'boot-2', readProcessStart: async pid => pid === 4001 ? '100' : '200', isPidAlive: () => true },
  }), { code: 'AGENT_CONSUMER_LOCKED' });
  await afterReboot.close();

  // 3. Reused PID (PID 5000 is alive, but its /proc/<pid>/stat starttime changed from 100 -> 999) recovers safely!
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
    pid: 5000, token: 'tok-old', hostname: 'box-a', bootId: 'boot-2', processStart: '100', startedAt: new Date().toISOString(),
  }));
  const reusedRec = [];
  const afterReuse = await openConsumerCheckpoint(path, {
    scope,
    onRecoveredStaleLock: info => reusedRec.push(info),
    _lockEnv: { pid: () => 6000, hostname: () => 'box-a', readBootId: async () => 'boot-2', readProcessStart: async pid => pid === 5000 ? '999' : '1200', isPidAlive: () => true },
  });
  assert.equal(reusedRec[0].reason, 'pid_reused');
  await afterReuse.close();

  // 4. Dead process (isPidAlive false) recovers safely!
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
    pid: 7777, token: 'tok-dead', hostname: 'box-a', bootId: 'boot-2', processStart: '555', startedAt: new Date().toISOString(),
  }));
  const deadRec = [];
  const afterCrash = await openConsumerCheckpoint(path, {
    scope,
    onRecoveredStaleLock: info => deadRec.push(info),
    _lockEnv: { pid: () => 8888, hostname: () => 'box-a', readBootId: async () => 'boot-2', readProcessStart: async () => '600', isPidAlive: pid => pid !== 7777 },
  });
  assert.equal(deadRec[0].reason, 'process_dead');
  await afterCrash.close();

  // 5. Different host cannot steal lock -> fails closed visibly.
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
    pid: 7777, token: 'tok-remote', hostname: 'other-box', bootId: 'boot-x', processStart: '1', startedAt: new Date().toISOString(),
  }));
  await assert.rejects(openConsumerCheckpoint(path, {
    scope,
    _lockEnv: { pid: () => 8888, hostname: () => 'box-a', readBootId: async () => 'boot-2', readProcessStart: async () => '600', isPidAlive: () => false },
  }), { code: 'AGENT_CONSUMER_LOCKED', reason: 'different_host' });
  await rm(lockDir, { recursive: true, force: true });
});

test('#145 stale-lock recovery after crash mid-uncertain admission still stops with CODEX_QUEUE_REVIEW_REQUIRED without resending', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lock-uncertain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'cp.json');
  const scope = { threadId, cwd: baseOptions.cwd, page: 'page-one' };
  const page = { id: 'page-one', slug: 'notes', roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }) };
  const reqEvent = { id: 'op-unc', author, operationId: 'op-unc', topic: 'agent/message', payload: { channel: 'chat', to: [deviceId], text: 'hi' } };
  const makeSession = () => ({
    identity: { publicKey: deviceId },
    signal: new AbortController().signal,
    async *changes() {},
    async readView() { return { async readEvents() { return { events: [reqEvent], cursor: 'c1', hasMore: false }; }, async release() {} }; },
    async query() { return { value: { messages: [], activity: [], receipts: {} } }; },
  });

  // First process crashes with uncertain admission and leaves .lock behind (no close()).
  const cp1 = await openConsumerCheckpoint(path, {
    scope,
    _lockEnv: { pid: () => 1111, hostname: () => 'host-1', readBootId: async () => 'boot-1', readProcessStart: async () => '10', isPidAlive: () => true },
  });
  let execCalls = 0;
  await assert.rejects(consumeCodexRequests({
    ...baseOptions, page, session: makeSession(), checkpoint: cp1, roster: page.roster,
    connect: async () => rpcFor().client,
    execute: async () => { execCalls++; throw Error('process killed mid-enqueue'); },
  }), { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(execCalls, 1);

  // After reboot, new process automatically recovers the stale lock, BUT MUST stop for reconciliation!
  const cp2 = await openConsumerCheckpoint(path, {
    scope,
    _lockEnv: { pid: () => 2222, hostname: () => 'host-1', readBootId: async () => 'boot-2', readProcessStart: async () => '20', isPidAlive: () => true },
  });
  try {
    await assert.rejects(consumeCodexRequests({
      ...baseOptions, page, session: makeSession(), checkpoint: cp2, roster: page.roster,
      connect: async () => rpcFor().client,
      execute: async () => { execCalls++; return ack('never'); },
    }), { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
    assert.equal(execCalls, 1, 'must never blindly resend uncertain admission after stale-lock recovery');
  } finally {
    await cp2.close();
  }
});

test('#145 runCodexQueueBridge waits for page owner startup (SUPERVISOR_PAGE_UNAVAILABLE) before attaching', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-wait-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let attempts = 0;
  const states = [];
  const cancel = new AbortController();
  const session = {
    identity: { publicKey: deviceId },
    signal: new AbortController().signal,
    describe: () => ({ queries: ['agentFeed'], commands: ['agentMessage', 'agentReceipt'] }),
    async *changes({ signal }) {
      signal.throwIfAborted();
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async readView() { return { async readEvents() { return { events: [], cursor: 'c0', hasMore: false }; }, async release() {} }; },
    async query() { return { value: { messages: [], activity: [], receipts: {} } }; },
  };
  const page = {
    id: 'page-boot',
    slug: 'notes',
    roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }),
    async attach() {
      attempts++;
      if (attempts < 3) throw Object.assign(Error('Opening page'), { code: 'SUPERVISOR_PAGE_UNAVAILABLE' });
      return { session, async detach() {} };
    },
  };
  await assert.rejects(runCodexQueueBridge({
    ...baseOptions,
    pages: [page],
    stateDirectory: dir,
    attachWaitMs: 2_000,
    attachRetryMs: 20,
    signal: cancel.signal,
    connect: async () => rpcFor().client,
    execute: async (_bin, argv) => argv.includes('--help') ? { stdout: '--thread --message --resume --remote', stderr: '' } : ack('q1'),
    onState: s => {
      states.push(s);
      if (s.state === 'request_protocol_ready') cancel.abort(Error('done'));
    },
  }), /done/);
  assert.equal(attempts, 3);
  assert.ok(states.some(s => s.state === 'waiting_for_owner' && s.code === 'SUPERVISOR_PAGE_UNAVAILABLE'));
  assert.ok(states.some(s => s.state === 'request_protocol_ready'));
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #144: Wake the existing agent conversation for applicable Tendriller broadcasts
// ───────────────────────────────────────────────────────────────────────────

test('#144 wakes active and idle conversation for verified matching broadcasts (including info), rejects invalid/expired, preserves interruption, and deduplicates across multi-page agents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'broadcast-wake-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyPair = await generateBroadcastKeyPair({ kid: 'bk_test' });
  const issuer = 'https://tendriller.test';
  const makeSigned = async (id, seq, overrides = {}) => signBroadcastPayload({
    schema_version: 1,
    id,
    seq,
    issuer,
    kind: 'announcement',
    severity: 'info',
    audiences: ['agents'],
    title: `Notice ${seq}`,
    summary: `Summary for ${id}`,
    body: 'Full body details.',
    docs_url: 'https://tendriller.test/changelog.md',
    action: null,
    match: null,
    dismissible: true,
    created_at: Date.now() - 1000,
    expires_at: Date.now() + 3600_000,
    superseded_by: null,
    ...overrides,
  }, keyPair.privateJwk);

  const infoBc = await makeSigned('bc_' + 'a'.repeat(26), 1, { severity: 'info', title: 'Info notice' });
  const urgentBc = await makeSigned('bc_' + 'b'.repeat(26), 2, { kind: 'security', severity: 'urgent', title: 'Urgent patch' });
  const expiredBc = await makeSigned('bc_' + 'c'.repeat(26), 3, { expires_at: Date.now() - 5000 });
  const wrongAudienceBc = await makeSigned('bc_' + 'd'.repeat(26), 4, { audiences: ['page_owners'] });
  const nonMatchingVersionBc = await makeSigned('bc_' + 'e'.repeat(26), 5, { match: { core_release: '<0.2.0' } });
  const tamperedBc = {
    payload: { ...(await makeSigned('bc_' + 'f'.repeat(26), 6)).payload, title: 'TAMPERED' },
    signature: infoBc.signature,
  };

  // 1. Active turn -> steers with turn/steer; idle turn -> queues with --resume; invalid/expired/mismatched rejected/skipped.
  const cpPath = join(dir, 'broadcasts.json');
  const scope = { kind: 'codex-broadcasts-v1', threadId, cwd: baseOptions.cwd };
  const cp = await openConsumerCheckpoint(cpPath, { scope });
  try {

  const steered = [];
  const queued = [];
  const states = [];
  let rpcCount = 0;

  await consumeCodexBroadcasts({
    ...baseOptions,
    checkpoint: cp,
    verifySignature: verifyBroadcastSignature,
    evaluateMatch: evaluateBroadcastMatch,
    broadcastSource: {
      async read() {
        return {
          issuer,
          keys: [keyPair.publicJwk],
          versions: { core: '0.3.0-rc.17' },
          acknowledged: [],
          broadcasts: [infoBc, urgentBc, expiredBc, wrongAudienceBc, nonMatchingVersionBc, tamperedBc],
        };
      },
    },
    connect: async () => {
      rpcCount++;
      // First broadcast sees active turn -> steer; second sees idle -> queue --resume.
      const snapshots = rpcCount === 1
        ? [{ runtime: 'active', status: 'inProgress', id: 'turn-live-1' }]
        : [{ runtime: 'idle', status: 'completed', id: 'turn-live-1' }];
      return rpcFor({
        snapshots,
        steer: async params => { steered.push(params); return { turnId: params.expectedTurnId }; },
      }).client;
    },
    execute: async (_bin, argv) => { queued.push(argv); return ack(`q-${queued.length}`); },
    onState: s => states.push(s),
  });

  assert.equal(steered.length, 1, 'active turn must be steered for informational broadcast too');
  assert.match(steered[0].input[0].text, /\[INFO\]/);
  assert.match(steered[0].input[0].text, new RegExp(infoBc.payload.id));
  assert.equal(queued.length, 1, 'idle turn must queue with --resume for second broadcast');
  assert.ok(queued[0].includes('--resume'));
  assert.match(queued[0][queued[0].indexOf('--message') + 1], /\[URGENT\]/);
  assert.ok(states.some(s => s.state === 'broadcast_rejected' && s.broadcastId === tamperedBc.payload.id));
  assert.ok(states.filter(s => s.state === 'steered' || s.state === 'queued').every(s =>
    s.broadcastAcknowledged === false && s.workerReceipt === false && s.wakeVerified === false));

  // Re-running with same broadcasts does not duplicate either broadcast!
  await consumeCodexBroadcasts({
    ...baseOptions,
    checkpoint: cp,
    verifySignature: verifyBroadcastSignature,
    evaluateMatch: evaluateBroadcastMatch,
    broadcastSource: {
      async read() {
        return { issuer, keys: [keyPair.publicJwk], versions: { core: '0.3.0-rc.17' }, acknowledged: [], broadcasts: [infoBc, urgentBc] };
      },
    },
    connect: async () => { throw Error('Must not connect when all broadcasts are already delivered'); },
    execute: async () => { throw Error('Must not queue duplicates'); },
  });

  // 2. Explicit user interruption -> queues WITHOUT --resume; active-turn race falls back safely; uncertain stops for review!
  const interruptedBc = await makeSigned('bc_' + 'g'.repeat(26), 7, { title: 'Interrupted test' });
  const queuedInterrupted = [];
  await consumeCodexBroadcasts({
    ...baseOptions,
    checkpoint: cp,
    verifySignature: verifyBroadcastSignature,
    evaluateMatch: evaluateBroadcastMatch,
    broadcastSource: {
      async read() {
        return { issuer, keys: [keyPair.publicJwk], versions: { core: '0.3.0-rc.17' }, acknowledged: [], broadcasts: [interruptedBc] };
      },
    },
    connect: async () => rpcFor({ snapshots: [{ runtime: 'idle', status: 'interrupted', id: 'turn-stop' }] }).client,
    execute: async (_bin, argv) => { queuedInterrupted.push(argv); return ack('q-int'); },
  });
  assert.equal(queuedInterrupted.length, 1);
  assert.equal(queuedInterrupted[0].includes('--resume'), false, 'must preserve interrupted conversation stop (omit --resume)');

  // 3. Active-turn race (no active turn to steer -> re-reads idle -> queues cleanly)
  const raceBc = await makeSigned('bc_' + 'h'.repeat(26), 8, { title: 'Race test' });
  const queuedRace = [];
  await consumeCodexBroadcasts({
    ...baseOptions,
    checkpoint: cp,
    verifySignature: verifyBroadcastSignature,
    evaluateMatch: evaluateBroadcastMatch,
    broadcastSource: {
      async read() {
        return { issuer, keys: [keyPair.publicJwk], versions: { core: '0.3.0-rc.17' }, acknowledged: [], broadcasts: [raceBc] };
      },
    },
    connect: async () => rpcFor({
      snapshots: [
        { runtime: 'active', status: 'inProgress', id: 'turn-race' },
        { runtime: 'idle', status: 'completed', id: 'turn-race' },
      ],
      steer: async () => { throw rpcError('no active turn to steer'); },
    }).client,
    execute: async (_bin, argv) => { queuedRace.push(argv); return ack('q-race'); },
  });
  assert.equal(queuedRace.length, 1);
  assert.ok(queuedRace[0].includes('--resume'));

  // 4. Uncertain delivery persists pending and stops with CODEX_QUEUE_REVIEW_REQUIRED on restart.
  const uncBc = await makeSigned('bc_' + 'i'.repeat(26), 9, { title: 'Uncertain broadcast' });
  await assert.rejects(consumeCodexBroadcasts({
    ...baseOptions,
    checkpoint: cp,
    verifySignature: verifyBroadcastSignature,
    evaluateMatch: evaluateBroadcastMatch,
    broadcastSource: {
      async read() {
        return { issuer, keys: [keyPair.publicJwk], versions: { core: '0.3.0-rc.17' }, acknowledged: [], broadcasts: [uncBc] };
      },
    },
    connect: async () => rpcFor().client,
    execute: async () => { throw Error('timeout'); },
  }), { code: 'CODEX_QUEUE_DELIVERY_UNCERTAIN' });
  await assert.rejects(consumeCodexBroadcasts({
    ...baseOptions,
    checkpoint: cp,
    verifySignature: verifyBroadcastSignature,
    evaluateMatch: evaluateBroadcastMatch,
    broadcastSource: {
      async read() {
        return { issuer, keys: [keyPair.publicJwk], versions: { core: '0.3.0-rc.17' }, acknowledged: [], broadcasts: [uncBc] };
      },
    },
    connect: async () => rpcFor().client,
    execute: async () => ack('never'),
  }), { code: 'CODEX_QUEUE_REVIEW_REQUIRED' });
  } finally {
    await cp.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #149: Conversation-owned liveness across multiple pages, failure expiry, and honest status
// ───────────────────────────────────────────────────────────────────────────

test('#149 one conversation liveness probe covers multiple pages, tracks active/idle/resumed/paused turns, expires on receiver failure while owner stays connected, and never fabricates receipts', async t => {
  const pageA = createMockSignalPair(deviceId);
  const pageB = createMockSignalPair(deviceId);
  const watcherA = watchAgentsPresence(pageA.browser, { staleAfterMs: 5_000 });
  const watcherB = watchAgentsPresence(pageB.browser, { staleAfterMs: 5_000 });
  t.after(() => {
    watcherA.close(); watcherB.close();
    pageA.native.close(); pageA.browser.close();
    pageB.native.close(); pageB.browser.close();
  });

  // Before any worker/conversation presence signal, enrolled signer is 'unknown', NOT 'offline'!
  await waitUntil(() => watcherA.snapshot()[deviceId]?.state === 'unknown');
  assert.equal(watcherA.snapshot()[deviceId].state, 'unknown');

  let currentMode = { runtime: 'idle', status: 'completed', id: 'turn-1', fail: false };
  const liveness = createCodexConversationLiveness({
    ...baseOptions,
    sessions: [
      { page: { id: 'page-a', slug: 'notes' }, session: pageA.native },
      { page: { id: 'page-b', slug: 'inventory' }, session: pageB.native },
    ],
    handle: 'atlas',
    isPrimary: true,
    probeIntervalMs: 60_000,
    ttlMs: 15_000,
    connect: async () => rpcFor({ snapshots: [currentMode], fail: currentMode.fail }).client,
  });
  t.after(() => liveness.close());

  // 1. Idle conversation -> both pages see online + idleWakeReachable: true
  await waitUntil(() => watcherA.snapshot()[deviceId]?.state === 'online' && watcherB.snapshot()[deviceId]?.state === 'online');
  assert.equal(watcherA.snapshot()[deviceId].route, 'same-conversation');
  assert.equal(watcherA.snapshot()[deviceId].idleWakeReachable, true);
  assert.equal(watcherB.snapshot()[deviceId].idleWakeReachable, true);

  // 2. Active turn -> both pages see busy
  currentMode = { runtime: 'active', status: 'inProgress', id: 'turn-2', fail: false };
  await liveness.probe();
  await waitUntil(() => watcherA.snapshot()[deviceId]?.state === 'busy' && watcherB.snapshot()[deviceId]?.state === 'busy');

  // 3. Queued user request not yet read stays 'delivered' (liveness never infers seen/answered!)
  const userMsg = { author, operationId: 'user-q-1', channel: 'chat', to: [], text: 'Are you there?' };
  assert.equal(messageDelivery(userMsg, { messages: [userMsg], activity: [], receipts: {} }), 'delivered');

  // 4. Resumed turn finishes -> back to online (listening)
  currentMode = { runtime: 'idle', status: 'completed', id: 'turn-2', fail: false };
  await liveness.probe();
  await waitUntil(() => watcherA.snapshot()[deviceId]?.state === 'online' && watcherB.snapshot()[deviceId]?.state === 'online');

  // 5. Receiver/worker failure while BOTH page owners and the bridge stay connected -> immediately stops!
  currentMode = { runtime: 'idle', status: 'completed', id: 'turn-2', fail: true };
  await liveness.probe();
  await waitUntil(() => watcherA.snapshot()[deviceId]?.state === 'stopped' && watcherB.snapshot()[deviceId]?.state === 'stopped');
  assert.equal(pageA.native.status.connectedPeers, 1, 'native owner is still connected while worker liveness is stopped');
  assert.equal(pageB.native.status.connectedPeers, 1);

  // 6. Receiver recovers -> resumed turn announces busy again
  currentMode = { runtime: 'active', status: 'inProgress', id: 'turn-3', fail: false };
  await liveness.probe();
  await waitUntil(() => watcherA.snapshot()[deviceId]?.state === 'busy' && watcherB.snapshot()[deviceId]?.state === 'busy');
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #150: Subdirectory app workspace (--thread-cwd) & immediate startup route failure
// ───────────────────────────────────────────────────────────────────────────

test('#150 supports parent --thread-cwd for subdirectory app workspace (active steering, idle queueing, retained prepared/uncertain states) and rejects unrelated or mismatched cwds immediately at startup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'thread-cwd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parentDir = '/workspace/agent';
  const subWorkspace = '/workspace/agent/v2';

  const makeRpc = ({ threadCwd = parentDir, snapshots = [{ runtime: 'idle', status: 'completed', id: 'turn-1' }], steer } = {}) => {
    let idx = -1;
    return {
      async request(method, params) {
        if (method === 'thread/read') {
          idx++;
          const s = snapshots[Math.min(idx, snapshots.length - 1)];
          return { thread: { id: threadId, cwd: threadCwd, status: { type: s.runtime }, canAcceptDirectInput: true } };
        }
        if (method === 'thread/turns/list') {
          const s = snapshots[Math.min(idx, snapshots.length - 1)];
          return { data: s.id ? [{ id: s.id, status: s.status, items: [], itemsView: 'notLoaded' }] : [] };
        }
        if (method === 'turn/steer') return steer ? steer(params) : { turnId: params.expectedTurnId };
        throw Error(`Unexpected RPC method: ${method}`);
      },
      async close() {},
    };
  };

  // 1. Unrelated --thread-cwd (not a parent of --workspace) is rejected immediately with CODEX_QUEUE_OPTIONS_INVALID.
  const dummyPage = {
    id: 'page-sub',
    slug: 'notes',
    roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }),
    attach: async () => { throw Error('Must fail option validation before attach'); },
  };
  await assert.rejects(runCodexQueueBridge({
    ...baseOptions,
    cwd: subWorkspace,
    threadCwd: '/unrelated/root',
    pages: [dummyPage],
    stateDirectory: join(dir, 'unrelated'),
    connect: async () => makeRpc({ threadCwd: '/unrelated/root' }),
    execute: async () => ({ stdout: '--thread --message --resume --remote', stderr: '' }),
  }), { code: 'CODEX_QUEUE_OPTIONS_INVALID' });

  // 2. Mismatched daemon thread.cwd fails IMMEDIATELY at startup before onOpened() or waiting for first message!
  let openedCalled = false;
  const failStates = [];
  await assert.rejects(runCodexQueueBridge({
    ...baseOptions,
    cwd: subWorkspace,
    // Omit threadCwd so bridge expects subWorkspace, while daemon reports parentDir.
    pages: [dummyPage],
    stateDirectory: join(dir, 'mismatch'),
    connect: async () => makeRpc({ threadCwd: parentDir }),
    execute: async () => ({ stdout: '--thread --message --resume --remote', stderr: '' }),
    onOpened: () => { openedCalled = true; },
    onState: s => failStates.push(s),
  }), { code: 'CODEX_QUEUE_THREAD_UNAVAILABLE' });
  assert.equal(openedCalled, false, 'must fail startup route preflight before reporting ready');
  assert.ok(failStates.some(s => s.state === 'conversation_route_failed' && s.code === 'CODEX_QUEUE_THREAD_UNAVAILABLE'));

  // 3. Valid parent --thread-cwd + subdirectory --workspace: startup emits conversation_route_ready,
  //    active turn steers with subWorkspace in notice, idle turn queues with cwd=parentDir and subWorkspace in notice.
  const steered = [];
  const queued = [];
  const req1 = { id: 'op-sub-1', author, operationId: 'op-sub-1', topic: 'agent/message', payload: { channel: 'chat', to: [deviceId], text: 'active msg' } };
  const req2 = { id: 'op-sub-2', author, operationId: 'op-sub-2', topic: 'agent/message', payload: { channel: 'chat', to: [deviceId], text: 'idle msg' } };
  const makePageSession = (events, answers = []) => ({
    identity: { publicKey: deviceId },
    signal: new AbortController().signal,
    describe: () => ({ queries: ['agentFeed'], commands: ['agentMessage', 'agentReceipt'] }),
    async *changes({ signal }) {
      signal.throwIfAborted();
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async readView() { return { async readEvents({ cursor }) { return { events: cursor ? [] : events, cursor: 'c-sub', hasMore: false }; }, async release() {} }; },
    async query() { return { value: { messages: answers, activity: [], receipts: {} } }; },
  });

  const cancel = new AbortController();
  const okStates = [];
  let connectCount = 0;
  await assert.rejects(runCodexQueueBridge({
    ...baseOptions,
    cwd: subWorkspace,
    threadCwd: parentDir,
    pages: [{
      id: 'page-sub',
      slug: 'notes',
      roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }),
      attach: async () => ({ session: makePageSession([req1, req2]), async detach() {} }),
    }],
    stateDirectory: join(dir, 'valid'),
    signal: cancel.signal,
    connect: async () => {
      connectCount++;
      // 1 = startup preflight (idle), 2 = req1 (active steer), 3 = req2 (idle queue)
      const snapshots = connectCount === 2
        ? [{ runtime: 'active', status: 'inProgress', id: 'turn-active-sub' }]
        : [{ runtime: 'idle', status: 'completed', id: 'turn-active-sub' }];
      return makeRpc({
        threadCwd: parentDir,
        snapshots,
        steer: async params => { steered.push(params); return { turnId: params.expectedTurnId }; },
      });
    },
    execute: async (_bin, argv, execOpts) => {
      if (argv.includes('--help')) return { stdout: '--thread --message --resume --remote', stderr: '' };
      queued.push({ argv, cwd: execOpts.cwd });
      return ack('q-sub-2');
    },
    onState: s => {
      okStates.push(s);
      if (s.state === 'queued') cancel.abort(Error('sub-done'));
    },
  }), /sub-done/);

  assert.ok(okStates.some(s => s.state === 'conversation_route_ready' && s.threadCwd === parentDir && s.workspace === subWorkspace));
  assert.equal(steered.length, 1, 'active turn steered in parent conversation');
  assert.match(steered[0].input[0].text, /"\/workspace\/agent\/v2"/, 'notice names subdirectory workspace');
  assert.equal(queued.length, 1, 'idle turn queued in parent conversation');
  assert.equal(queued[0].cwd, parentDir, 'codex queue executes with parent thread cwd');
  assert.match(queued[0].argv[queued[0].argv.indexOf('--message') + 1], /"\/workspace\/agent\/v2"/);

  // 4. Retained prepared (now answered) checkpoint from before adding --thread-cwd is recognized as answered and NOT redelivered!
  const migDir = join(dir, 'migration-preserved');
  const cpPath = join(migDir, 'migrated.json');
  const scope = { kind: 'codex-queue-v2', pageId: 'page-mig', recipient: deviceId, threadId, cwd: subWorkspace, remote: 'unix://', remoteAuthTokenEnv: null, requestTopics: ['chat'] };
  const cpBefore = await openConsumerCheckpoint(cpPath, { scope });
  const reqMig = { id: 'op-mig-1', author, operationId: 'op-mig-1', topic: 'agent/message', payload: { channel: 'chat', to: [deviceId], text: 'before thread-cwd' } };
  await assert.rejects(consumeCodexRequests({
    ...baseOptions,
    cwd: subWorkspace,
    page: { id: 'page-mig', slug: 'notes', roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }) },
    session: makePageSession([reqMig]),
    checkpoint: cpBefore,
    roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }),
    connect: async () => makeRpc({ threadCwd: parentDir }), // Fails with CODEX_QUEUE_THREAD_UNAVAILABLE before delivery!
    execute: async () => { throw Error('must not queue'); },
  }), { code: 'CODEX_QUEUE_THREAD_UNAVAILABLE' });
  assert.equal(cpBefore.read().pending.requests[0].status, 'prepared', 'request stays safely prepared');
  await cpBefore.close();

  // Reopen with --thread-cwd added and the manual reply present in agentFeed -> recognized as answered, zero redelivery!
  const cpAfter = await openConsumerCheckpoint(cpPath, { scope });
  try {
    const manualReply = { author: deviceId, operationId: 'reply-mig-1', inReplyTo: { author, operationId: 'op-mig-1' } };
    const cancel2 = new AbortController();
    let deliveredAfter = 0;
    const doneSession = {
      ...makePageSession([reqMig], [manualReply]),
      async *changes() {},
    };
    await assert.rejects(consumeCodexRequests({
      ...baseOptions,
      cwd: subWorkspace,
      threadCwd: parentDir,
      page: { id: 'page-mig', slug: 'notes', roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }) },
      session: doneSession,
      checkpoint: cpAfter,
      roster: async () => ({ primary_agent_id: null, is_primary: false, agents: [] }),
      signal: cancel2.signal,
      connect: async () => { deliveredAfter++; return makeRpc({ threadCwd: parentDir }); },
      execute: async () => { deliveredAfter++; return ack('never'); },
    }), /AGENT_CONSUMER_STREAM_ENDED/);
    assert.equal(deliveredAfter, 0, 'answered retained request must not be redelivered');
    assert.equal(cpAfter.read().pending, null);
  } finally {
    await cpAfter.close();
  }
});
