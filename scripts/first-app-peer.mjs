// Test-only qualification participant for the first-app workspace. The harness
// writes qualificationPageSource() over one page's pages/<slug>/agent.mjs in the
// private downloaded application. `tendril agent run` imports it like any page
// module: the same shared native composition (control, peer participation, setup
// notices, reviewed pairing) runs inside the one agent program, plus a private
// JSON-lines control socket through which the harness asks for evidence.
import { once } from 'node:events';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { observeSetupReadiness } from './first-app-setup-readiness.mjs';

export const QUALIFICATION_SOCKET_ENV = 'FIRST_APP_QUALIFICATION_SOCKET';

export async function authenticatedTransportSnapshot(participation, peerId) {
  const pending = participation.diagnostics();
  const connectionRevision = participation.status.connectionRevision;
  const links = await pending;
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
import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeApplication } from '@chronolog/peer-session/native';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { pairingFor } from '../../shared/native-page.mjs';
import { superviseParticipant } from '../../shared/participant-lifecycle.mjs';
import { servePeerInference } from '../../shared/media/inference-service.mjs';
import { serveSignalRequests } from '../../shared/helpers/signal-request.mjs';
import { definition } from './domain.mjs';

export { definition };
const expectedEvidence = new Uint8Array(Buffer.from(${JSON.stringify(evidenceBase64)}, 'base64'));
const observeSetupReadiness = ${observeSetupReadiness.toString()};

export async function openPage(context) {
  const { signal, report } = context;
  const socketDirectory = process.env.${QUALIFICATION_SOCKET_ENV};
  if (!socketDirectory) throw Error('The private qualification page needs ${QUALIFICATION_SOCKET_ENV}.');
  const authority = await context.host.peers.application({ signal });
  const descriptor = await context.readPrivate('descriptor.json');
  await verifyAuthorityBundle(authority, descriptor);
  const device = await context.openDevice();
  const lifecycleLog = [], participationLog = [], statusLog = [], qualifications = [], actions = Object.create(null);
  let session, lifecycle, owner, server, inference, inferenceCalls = 0, inferenceSource = null, pairingStatus = null;
  let requestTask, requestFailure, closing;
  const requestsStopped = new AbortController();
  const socketPath = socketDirectory + '/' + context.page.slug + '.sock';
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
    try { await lifecycle?.close(); } catch (error) { errors.push(error); }
    if (owner) { try { await ownerClose(); } catch (error) { errors.push(error); } }
    else if (session) { try { await session.close(); } catch (error) { errors.push(error); } }
    else { try { await device.close(); } catch (error) { errors.push(error); } }
    await rm(socketPath, { force: true });
    if (errors.length) throw new AggregateError(errors, 'Qualification page cleanup failed: ' + errors.map(error => error.message).join('; '));
  })();
  let ownerClose;
  try {
    session = await openNativeApplication({ device, definition, authority,
      signals: { limits: { maxQueuedSignals: 1024, maxQueuedBytes: 8 * 1024 * 1024 } } });
    const control = session.connectControlParticipant({ exchange: (message, options) => context.host.peers.exchange(message, options) });
    participateNativeApplication(session, { peers: context.host.peers, control });
    const { processPairings } = pairingFor(context, { session, device, descriptor });
    const setupReadiness = observeSetupReadiness({ processPairings,
      watchSetup: callbacks => watchApplicationSetup({ page: context.host, ...callbacks }) });
    lifecycle = superviseParticipant({ owned: { session, control, processPairings: options => setupReadiness.processPairings(options) },
      signal: session.signal, watch: callbacks => setupReadiness.watch(callbacks),
      report(value) {
        if (value.pairing) pairingStatus = { state: value.pairing.state, code: value.pairing.code ?? null };
        if (lifecycleLog.length < 200) lifecycleLog.push({ at: Date.now(), ...(value.pairing ? { pairing: value.pairing.state, pairingId: value.pairing.pairingId ?? null } : { state: value.state ?? null, setup: value.setup ?? null }) });
        report(value);
      } });
    owner = createApplicationOwner(session, { host: control });
    ownerClose = owner.close.bind(owner);
    const owned = { session, slug: context.page.slug, ownerInstanceId: () => owner.ownerInstanceId };
    for (const create of [${qualificationSources.map(source => '(' + source + ')').join(',')}]) {
      const qualification = await create(owned); qualifications.push(qualification);
      for (const [action, handler] of Object.entries(qualification.actions)) {
        assert.ok(!Object.hasOwn(actions, action)); actions[action] = handler;
      }
    }
    session.onStatus?.(status => { const last = statusLog.at(-1);
      if (statusLog.length < 500 && (!last || last.phase !== status.phase || last.generation !== status.generation || last.database !== status.database))
        statusLog.push({ at: Date.now(), phase: status.phase, generation: status.generation, database: status.database }); });
    session.participation.onStatus(status => { if (participationLog.length < 5000) participationLog.push({ at: Date.now(), phase: status.phase, peers: [...status.connectedPeers].sort(), error: status.error }); });
    requestTask = serveSignalRequests(session, { signal: requestsStopped.signal, handle: async (q, input) => {
      if (q !== 'rows') throw Object.assign(Error('Unknown request'), { code: 'unknown' });
      assert.ok(Number.isSafeInteger(input?.count) && input.count >= 0 && input.count <= 1024);
      assert.ok(Number.isSafeInteger(input?.width) && input.width >= 0 && input.width <= 4096);
      return { rows: Array.from({ length: input.count }, (_value, index) => ({ index, label: 'row "' + index + '"', text: 'x'.repeat(input.width) })) };
    } }).catch(error => { requestFailure = Object.assign(Error('Signal reply service failed'), { code: error?.code || 'SIGNAL_REQUEST_FAILED' }); });
    let browserDeviceId = null;
    const snapshot = () => (${authenticatedTransportSnapshot.toString()})(session.participation, browserDeviceId);
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
        case 'self': return { deviceId: session.deviceId, ownerInstanceId: owner.ownerInstanceId };
        case 'query': return session.query('notes', null);
        case 'command': {
          const before = await session.query('notes', null);
          const operation = await session.command('addNote', { text: request.text }, { operationId: request.operationId, basedOn: before.revision });
          return operation.applied({ signal: AbortSignal.timeout(30000) });
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
            remove = session.participation.onStatus(status => { if (status.connectionRevision !== revision) { revision = status.connectionRevision; void check(); } });
            void check();
          });
        }
        case 'setup-ready': {
          const before = setupReadiness.snapshot(), started = performance.now();
          const after = await setupReadiness.wait({ signal: session.signal });
          return { before, after, elapsedMs: performance.now() - started };
        }
        case 'diagnostics': return { status: session.status, participation: session.participation.status, pairing: pairingStatus,
          setupReadiness: setupReadiness.snapshot(), statusLog, lifecycleLog,
          signalRequests: { state: requestFailure ? 'failed' : requestsStopped.signal.aborted ? 'closed' : 'running', code: requestFailure?.code ?? null } };
        case 'participation-log': return { entries: participationLog.splice(0),
          current: { phase: session.participation.status.phase, peers: [...session.participation.status.connectedPeers].sort() } };
        case 'inference-status': return { ...(inference?.snapshot() ?? {}), calls: inferenceCalls, source: inferenceSource };
        default: throw Error('Unknown test action');
      }
    }
    await rm(socketPath, { force: true });
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
    return Object.assign(owner, { control, close });
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
