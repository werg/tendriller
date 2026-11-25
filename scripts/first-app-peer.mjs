// Test-only qualification participant for the first-app workspace. The harness
// writes qualificationPageSource() over one page's pages/<slug>/agent.mjs in the
// private downloaded application. `tendril agent run` imports it like any page
// module: the same shared native composition (control, peer participation, setup
// notices and explicit key provisioning) runs inside the one agent program, plus a private
// JSON-lines control socket through which the harness asks for evidence.
import { once } from 'node:events';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import {describeLocalReadiness,observeLocalReadiness} from './first-app-setup-readiness.mjs';

export const QUALIFICATION_SOCKET_ENV = 'FIRST_APP_QUALIFICATION_SOCKET';
// Linux abstract addresses keep private fixture endpoints within kernel limits
// even when the required scratchpad/TMPDIR has a long pathname. No file escapes it.
export function qualificationSocketPath(directory,slug){return directory.startsWith('@')?'\0'+directory.slice(1)+'-'+slug:directory+'/'+slug+'.sock';}

export async function authenticatedTransportSnapshot(participation, peerId, session) {
  // Reliable counters come from authenticated application links, never from the
  // rendezvous controller. Transport kind is the selected live adapter's fact.
  const pending = (session??participation).diagnostics();
  const connectionRevision = (session??participation).status.connectionRevision;
  const links = (await pending).map(link=>({...link}));
  if(session){const routes=await participation.diagnostics();for(const link of links){const route=routes.find(value=>value.peerId===link.peerId);if(route?.kind)link.kind=route.kind;}}
  const browserLinks = links.filter(link => link.peerId === peerId).length;
  const otherLinks = links.length - browserLinks;
  if (otherLinks !== 0 || browserLinks > 1) throw Error('NETWORK_QUALIFICATION_UNEXPECTED_LINK_SET');
  const link = links.find(link => link.peerId === peerId);
  return { connectionRevision, browserLinks, otherLinks,
    ...(link ? Object.fromEntries(['kind', 'sentReliableBytes', 'receivedReliableBytes', 'sentLiveBytes', 'receivedLiveBytes'].map(key => [key, link[key]])) : { kind: 'unknown' }) };
}

export function authenticatedRouteMatches(value, kind, afterRevision) {
  return value.kind === kind && (afterRevision === undefined || value.connectionRevision > afterRevision);
}

export function memoryAvailableGb(read = readFileSync) {
  try {
    const value = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(read('/proc/meminfo', 'utf8'));
    const kb = value ? Number(value[1]) : NaN;
    return Number.isSafeInteger(kb) && kb >= 0 ? Math.round(kb / 1048576 * 10) / 10 : null;
  } catch { return null; }
}

/** Serialized by Playwright; intentionally contains no module-local references. */
export async function installSoakObserver() {
  await window.tendril.signals.ready();
  window.soak?.stop?.abort();
  const state = window.soak = { pieces: 0, complete: 0, replies: new Map(), stop: new AbortController() };
  void (async () => {
    for await (const signal of window.tendril.signals.subscribe({ topics: ['soak'], mode: 'all', signal: state.stop.signal })) {
      const { id, g, i, n } = signal.payload ?? {};
      if (!(typeof id === 'string' || Number.isSafeInteger(id)) || !Number.isSafeInteger(n) || n < 1 || n > 512 ||
          !Number.isSafeInteger(i) || i < 0 || i >= n) continue;
      const key = JSON.stringify([id, g ?? null]);
      let reply = state.replies.get(key);
      if (!reply) {
        if (state.replies.size >= 128) {
          const old = [...state.replies].find(([, value]) => value.complete);
          if (!old) throw Error('SOAK_REPLY_LIMIT');
          state.replies.delete(old[0]);
        }
        state.replies.set(key, reply = { n, indexes: new Set(), complete: false });
      }
      if (reply.n !== n || reply.indexes.has(i)) continue;
      reply.indexes.add(i); state.pieces++;
      if (reply.indexes.size === n && !reply.complete) { reply.complete = true; state.complete++; }
    }
  })().catch(error => { if (!state.stop.signal.aborted) state.error = error.code || error.message; });
}

export async function installStateSignalObservers() {
  await window.tendril.signals.ready();
  window.stateModes = { all: 0, latest: 0 }; window.stateModeErrors = [];
  for (const mode of ['all', 'latest']) void (async () => {
    for await (const signal of window.tendril.signals.subscribe({ topics: ['state'], mode })) { void signal; window.stateModes[mode]++; }
  })().catch(error => window.stateModeErrors.push(error.code || error.name));
}

/**
 * Optional native participant for harnesses that need a second authoring peer. It
 * uses only the tutorial's workspace shared/native-page composition, the application
 * session (`query`, `command`, `operations`, `signals`, `status`) and its separate
 * participation controller. Nothing here creates a root, an epoch key or a
 * membership: the device must already have been explicitly provisioned, and the
 * ordinary application browser never depends on this process.
 *
 * Local durability (the command resolves once signed and stored), local
 * materialization, peer retention and finality are reported as independent facts.
 * No action waits for the network or a finalizer, and there is no second queue.
 */
/**
 * Source of a page module (pages/<slug>/agent.mjs) for the private test workspace.
 * `qualificationSources` are serialized `async owned => ({ actions, close })`
 * factories. `owned` is { session, slug, ownerInstanceId() }.
 */
export function qualificationPageSource({ evidenceBase64, networkQualification = false, qualificationSources = [] }) {
  return `// Private first-app qualification page module, written by the test harness.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import {openNativePage} from '../../shared/native-page.mjs';
import { servePeerInference } from '../../shared/media/inference-service.mjs';
import { serveSignalRequests } from '../../shared/helpers/signal-request.mjs';
import { definition } from './domain.mjs';

export { definition };
const expectedEvidence = new Uint8Array(Buffer.from(${JSON.stringify(evidenceBase64)}, 'base64'));
const describeLocalReadiness = ${describeLocalReadiness.toString()};
const observeLocalReadiness = ${observeLocalReadiness.toString()};

export async function openPage(context) {
  const { signal, report } = context;
  const socketDirectory = process.env.${QUALIFICATION_SOCKET_ENV};
  if (!socketDirectory) throw Error('The private qualification page needs ${QUALIFICATION_SOCKET_ENV}.');

  const lifecycleLog = [], participationLog = [], statusLog = [], qualifications = [], actions = Object.create(null);
  let session, owner, server, inference, inferenceCalls = 0, inferenceSource = null;
  let requestTask, requestFailure, closing;
  const requestsStopped = new AbortController();
  const socketPath = (${qualificationSocketPath.toString()})(socketDirectory,context.page.slug);
  const close = () => closing ??= (async () => {
    const errors = [];
    requestsStopped.abort();
    try { await new Promise(resolve => server ? server.close(() => resolve()) : resolve()); } catch (error) { errors.push(error); }
    for (const qualification of qualifications.toReversed()) {
      try { await qualification.close?.(); } catch (error) { errors.push(error); }
    }
    await requestTask;
    if (requestFailure) errors.push(requestFailure);
    try { await inference?.close(); } catch (error) { errors.push(error); }
    if (owner) { try { await ownerClose(); } catch (error) { errors.push(error); } }
    else if (session) { try { await session.close(); } catch (error) { errors.push(error); } }
    if(!socketPath.startsWith('\\0'))await rm(socketPath, { force: true });
    if (errors.length) throw new AggregateError(errors, 'Qualification page cleanup failed: ' + errors.map(error => error.message).join('; '));
  })();
  let ownerClose;
  try {
    owner=await openNativePage(context,{definition});session=owner.session;
    const setupReadiness=observeLocalReadiness(session);
    ownerClose=owner.close.bind(owner);
    const owned = { session, slug: context.page.slug, ownerInstanceId: () => owner.ownerInstanceId };
    for (const create of [${qualificationSources.map(source => '(' + source + ')').join(',')}]) {
      const qualification = await create(owned); qualifications.push(qualification);
      for (const [action, handler] of Object.entries(qualification.actions)) {
        assert.ok(!Object.hasOwn(actions, action)); actions[action] = handler;
      }
    }
    session.onStatus?.(status => { const last = statusLog.at(-1);
      if (statusLog.length < 500 && (!last || last.phase !== status.phase || last.canAuthor !== status.canAuthor || last.database !== status.database))
        statusLog.push({ at: Date.now(), phase: status.phase, canAuthor: status.canAuthor, database: status.database }); });
    owner.participation.onStatus(status => { if (participationLog.length < 5000) participationLog.push({ at: Date.now(), phase: status.phase, peers: [...status.connectedPeers].sort(), error: status.error }); });
    requestTask = serveSignalRequests(session, { signal: requestsStopped.signal, handle: async (q, input) => {
      if (q !== 'rows') throw Object.assign(Error('Unknown request'), { code: 'unknown' });
      assert.ok(Number.isSafeInteger(input?.count) && input.count >= 0 && input.count <= 1024);
      assert.ok(Number.isSafeInteger(input?.width) && input.width >= 0 && input.width <= 4096);
      return { rows: Array.from({ length: input.count }, (_value, index) => ({ index, label: 'row "' + index + '"', text: 'x'.repeat(input.width) })) };
    } }).catch(error => { requestFailure = Object.assign(Error('Signal reply service failed'), { code: error?.code || 'SIGNAL_REQUEST_FAILED' }); });
    let browserDeviceId = null;
    const snapshot = () => (${authenticatedTransportSnapshot.toString()})(owner.participation, browserDeviceId, session);
    async function handle(request) {
      if (Object.hasOwn(actions, request.action)) return actions[request.action](request);
      switch (request.action) {
        case 'configure':
          // The harness learns the enrolled browser key after the agent program started.
          assert.match(request.browserDeviceId, /^[a-f0-9]{64}$/);
          if (browserDeviceId === request.browserDeviceId) return { configured: true };
          assert.equal(browserDeviceId, null, 'One qualified browser device per agent program lifetime.');
          browserDeviceId = request.browserDeviceId;
          inference = servePeerInference({ session, allowedDevices: [browserDeviceId], maxRequests: ${networkQualification ? 20 : 2},
            async infer({ bytes, mediaType, source, signal }) {
              signal.throwIfAborted(); assert.deepEqual(bytes, expectedEvidence); assert.equal(mediaType, 'image/png');
              inferenceCalls++; inferenceSource = source;
              return { text: 'Suggested fixture observation' };
            } });
          return { configured: true };
        case 'self': return { publicKey: session.identity.publicKey, ownerInstanceId: owner.ownerInstanceId };
        case 'query': return session.query('notes', null);
        case 'operation': {const operation=await session.operations.get(request.operationId);return operation?operation.inspect():null;}
        case 'command': {
          const operation = await session.command('putNote', {noteId:request.noteId??request.operationId,text:request.text}, {operationId:request.operationId});
          return operation.materialized({ signal: AbortSignal.timeout(30000) });
        }
        case 'transport-snapshot': return snapshot();
        case 'transport-wait': {
          assert.ok(['direct', 'relay', 'unknown'].includes(request.kind));
          assert.ok(request.afterRevision === undefined || Number.isSafeInteger(request.afterRevision) && request.afterRevision >= 0);
          const matches = ${authenticatedRouteMatches.toString()};
          return new Promise((resolve, reject) => {
            let stopped = false, checking = false, again = false, revision = -1, remove = () => {};
            const finish = (error, value) => { if (stopped) return; stopped = true; clearTimeout(timer); remove(); error ? reject(error) : resolve(value); };
            const check = async () => {
              if (stopped) return;
              if (checking) { again = true; return; }
              checking = true;
              try { const value = await snapshot(); if (matches(value, request.kind, request.afterRevision)) finish(null, value); }
              catch (error) { finish(error); }
              finally { checking = false; if (again) { again = false; void check(); } }
            };
            const timer = setTimeout(() => finish(Error('NETWORK_QUALIFICATION_ROUTE_TIMEOUT')), 55000);
            remove = session.onStatus(status => { if (status.connectionRevision !== revision) { revision = status.connectionRevision; void check(); } });
            void check();
          });
        }
        case 'setup-ready': {
          const before = setupReadiness.snapshot(), started = performance.now();
          const after = await setupReadiness.wait({ signal: session.signal });
          return { before, after, elapsedMs: performance.now() - started };
        }
        case 'diagnostics': return { status: session.status, participation: owner.participation.status,
          setupReadiness: setupReadiness.snapshot(), statusLog, lifecycleLog,
          signalRequests: { state: requestFailure ? 'failed' : requestsStopped.signal.aborted ? 'closed' : 'running', code: requestFailure?.code ?? null } };
        case 'participation-log': return { entries: participationLog.splice(0),
          current: { phase: owner.participation.status.phase, peers: [...owner.participation.status.connectedPeers].sort() } };
        case 'inference-status': return { ...(inference?.snapshot() ?? {}), calls: inferenceCalls, source: inferenceSource };
        default: throw Error('Unknown test action');
      }
    }
    if(!socketPath.startsWith('\\0'))await rm(socketPath, { force: true });
    server = createServer(socket => {
      socket.on('error', () => {});
      createInterface({ input: socket }).on('line', line => {
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        void handle(request).then(result => ({ id: request.id, result }), error => ({ id: request.id, error: error?.message ?? String(error) }))
          .then(reply => { if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\\n'); });
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
    return Object.assign(owner, { close });
  } catch (error) {
    try { await close(); } catch {}
    throw error;
  }
}
`;
}

/** The harness side: one bounded request per connection, so agent restarts need no reconnect logic. */
export function connectQualificationPeer(socketPath) {
  let sequence = 0;
  return {
    async request(action, input = {}, timeoutMs = 40_000) {
      const socket = connect(socketPath), id = ++sequence;
      socket.on('error', () => {}); // once() below rejects with the connection error.
      let timer, lines;
      try {
        await once(socket, 'connect');
        lines = createInterface({ input: socket });
        lines.on('error', () => {});
        socket.write(JSON.stringify({ id, action, ...input }) + '\n');
        const reply = await Promise.race([
          (async () => { for await (const line of lines) { const value = JSON.parse(line); if (value.id === id) return value; } throw Error(`Qualification participant closed during ${action}.`); })(),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error(`Qualification ${action} timed out.`)), timeoutMs); }),
        ]);
        if (reply.error) throw Error(reply.error);
        return reply.result;
      } finally { clearTimeout(timer); lines?.close(); socket.destroy(); }
    },
  };
}
