import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { describeLocalReadiness, observeLocalReadiness } from './first-app-setup-readiness.mjs';

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

/** Optional Linux diagnostic: unavailable is not zero and cannot fail a run. */
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
 * uses only the tutorial's public bootstrap (`openSession`), the application
 * session (`query`, `command`, `operations`, `signals`, `status`) and its separate
 * participation controller. Nothing here creates a root, an epoch key or a
 * membership: the device must already have been explicitly provisioned, and the
 * ordinary application browser never depends on this process.
 *
 * Local durability (the command resolves once signed and stored), local
 * materialization, peer retention and finality are reported as independent facts.
 * No action waits for the network or a finalizer, and there is no second queue.
 */
export function nativeTestPeerSource({ evidenceBase64, browserPublicKey, transportModule, networkQualification = false }) {
  return `import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {openSession} from './session.mjs';
import {servePeerInference} from './media/inference-service.mjs';
import {serveSignalRequests, sendPieces} from './helpers/signal-request.mjs';
${transportModule ? `import {closeLocalTransport} from ${JSON.stringify(transportModule)};` : 'const closeLocalTransport = async () => {};'}
const describeLocalReadiness = ${describeLocalReadiness.toString()};
const observeLocalReadiness = ${observeLocalReadiness.toString()};
const owned = await openSession(), {session,supervisor} = owned;
// The participation controller is separate from the session's authored history.
const participation = owned.participation ?? session.participation;
const localReadiness = observeLocalReadiness(session);
const expectedEvidence = new Uint8Array(Buffer.from(${JSON.stringify(evidenceBase64)}, 'base64'));
let inference, input, closing, inferenceCalls = 0, inferenceSource = null, requestTask, requestFailure;
const requestsStopped = new AbortController(), stopObserving = [];
const close = () => closing ??= (async () => {
  const errors = [];
  requestsStopped.abort();
  for (const stop of stopObserving.splice(0)) { try { stop(); } catch (error) { errors.push(error); } }
  await requestTask;
  if(requestFailure) errors.push(requestFailure);
  try { await inference?.close(); } catch (error) { errors.push(error); }
  try { await owned.close(); } catch (error) { errors.push(error); }
  // The local fixture owns its custom HTTP/WebSocket dispatcher separately from
  // the application. It must drain only after the real owner closes its sockets.
  try { await closeLocalTransport(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Native test participant cleanup failed: ' + errors.map(error => error.message).join('; '));
})();
// Independent per-operation facts, never one collapsed "applied" flag.
const facts = operation => {
  const value = operation.inspect(), m = value.materialized;
  return {operationId:operation.operationId, proposalId:operation.id, stored:value.stored, pending:value.pending,
    materialized:m === null ? null : {outcome:m.outcome, rejectionCode:m.rejectionCode, failingStatementIndex:m.failingStatementIndex, revision:m.revision},
    retainedBy:value.retained.map(evidence => evidence.signer), finalized:value.finalized, excluded:value.excluded};
};
try {
  inference = servePeerInference({session, allowedDevices: [${JSON.stringify(browserPublicKey)}], maxRequests: ${networkQualification ? 20 : 2},
    async infer({bytes, mediaType, source, signal}) {
      signal.throwIfAborted(); assert.deepEqual(bytes, expectedEvidence); assert.equal(mediaType, 'image/png');
      inferenceCalls++; inferenceSource = source;
      return {text: 'Suggested fixture observation'};
    },
  });
  // Every participation change, with its peer set, so the harness can count churn.
  const participationLog = [];
  // Session status transitions for failure diagnosis.
  const statusLog = [];
  stopObserving.push(session.onStatus(status => { const last = statusLog.at(-1);
    if (statusLog.length < 500 && (!last || last.phase !== status.phase || last.database !== status.database || last.canAuthor !== status.canAuthor))
      statusLog.push({at:Date.now(),phase:status.phase,database:status.database,canAuthor:status.canAuthor}); }));
  if (participation) stopObserving.push(participation.onStatus(status => { if (participationLog.length < 5000) participationLog.push({at:Date.now(),phase:status.phase,peers:[...status.connectedPeers].sort(),error:status.error}); }));
  requestTask = serveSignalRequests(session, { signal: requestsStopped.signal, handle: async (q, input) => {
    if (q !== 'rows') throw Object.assign(Error('Unknown request'), { code: 'unknown' });
    assert.ok(Number.isSafeInteger(input?.count) && input.count >= 0 && input.count <= 1024);
    assert.ok(Number.isSafeInteger(input?.width) && input.width >= 0 && input.width <= 4096);
    return { rows: Array.from({ length: input.count }, (_value, index) => ({ index, label: 'row "' + index + '"', text: 'x'.repeat(input.width) })) };
  } }).catch(error => { requestFailure=Object.assign(Error('Signal reply service failed'), {code:error?.code || 'SIGNAL_REQUEST_FAILED'}); });
  console.log(JSON.stringify({ready:true,publicKey:session.identity.publicKey,ownerInstanceId:supervisor.ownerInstanceId}));
  input = createInterface({input:process.stdin});
  for await (const line of input) {
    const request=JSON.parse(line);
    try {
      let result;
      if(request.action==='query') result=await session.query('notes',null);
      ${networkQualification ? `else if(request.action==='transport-snapshot' || request.action==='transport-wait') {
        assert.ok(participation, 'The participation controller is required for transport evidence');
        const snapshot=()=>(${authenticatedTransportSnapshot.toString()})(participation,${JSON.stringify(browserPublicKey)});
        if(request.action==='transport-snapshot') result=await snapshot();
        else {
          assert.ok(['direct','relay','unknown'].includes(request.kind));
          assert.ok(request.afterRevision===undefined || Number.isSafeInteger(request.afterRevision) && request.afterRevision>=0);
          result=await new Promise((resolve,reject)=>{
            let stopped=false,checking=false,again=false,revision=-1;
            let remove=()=>{};
            const finish=(error,value)=>{if(stopped)return;stopped=true;clearTimeout(timer);remove();error?reject(error):resolve(value);};
            const check=async()=>{
              if(stopped)return;
              if(checking){again=true;return;}
              checking=true;
              try{const value=await snapshot();if((${authenticatedRouteMatches.toString()})(value,request.kind,request.afterRevision))finish(null,value);}
              catch(error){finish(error);}
              finally{checking=false;if(again){again=false;void check();}}
            };
            const timer=setTimeout(()=>finish(Error('NETWORK_QUALIFICATION_ROUTE_TIMEOUT')),55000);
            remove=participation.onStatus(status=>{if(status.connectionRevision!==revision){revision=status.connectionRevision;void check();}});
          });
        }
      }` : ''}
      else if(request.action==='local-ready') {
        // Local storage/key prerequisites only: never peers, the host or a finalizer.
        const before=localReadiness.snapshot(),started=performance.now();
        const after=await localReadiness.wait({signal:session.signal});
        result={before,after,elapsedMs:performance.now()-started};
      }
      else if(request.action==='diagnostics') result={status:session.status,participation:participation?.status ?? null,readiness:localReadiness.snapshot(),statusLog,
        signalRequests:{state:requestFailure?'failed':requestsStopped.signal.aborted?'closed':'running',code:requestFailure?.code ?? null}};
      else if(request.action==='participation-log') result={entries:participationLog.splice(0),current:participation ? {phase:participation.status.phase,peers:[...participation.status.connectedPeers].sort()} : null};
      else if(request.action==='signal-state') {
        // Periodic state updates, as a dashboard sends them.
        for(let index=0;index<request.count;index++){ await session.signals.send('state',{index,at:Date.now()},{ttlMs:30000}); await new Promise(r=>setTimeout(r,request.intervalMs)); }
        result={sent:request.count};
      }
      else if(request.action==='signal-burst') {
        // A reply larger than one signal, using the starter's bounded retrying sender.
        const failures=[], started=Date.now(), pieceMs=[];
        const generation=crypto.randomUUID();
        // Event-loop lag beside the sends tells a stalled process from a stalled transport.
        let lagMax=0, tick=Date.now(); const lag=setInterval(()=>{ const now=Date.now(); lagMax=Math.max(lagMax, now-tick-50); tick=now; },50);
        // Sent as an app sends a reply (the starter's retrying piece sender); retries are reported.
        let retries=0;
        try { for(let index=0;index<request.pieces;index++){
          const pieceStarted=Date.now();
          try{retries+=await sendPieces(session,request.topic,[{id:request.id,g:generation,i:index,n:request.pieces,z:'x'.repeat(request.bytes)}],{signal:requestsStopped.signal});}
          catch(error){failures.push(error.code||error.message);}
          pieceMs.push(Date.now()-pieceStarted);
        } } finally { clearInterval(lag); }
        result={sent:request.pieces-failures.length,failures,retries,ms:Date.now()-started,pieceMs,eventLoopLagMaxMs:lagMax,participation:participation?.status.phase ?? null};
      }
      else if(request.action==='inference-status') result={...inference.snapshot(), calls:inferenceCalls, source:inferenceSource};
      else if(request.action==='command') {
        // Resolves once the signed operation is stored locally. The caller's operation ID is the idempotency key.
        // The note ID defaults to the operation ID so a retried request addresses the same note, never a second one.
        const operation=await session.command('putNote',{noteId:request.noteId ?? request.operationId,text:request.text},{operationId:request.operationId});
        // Local materialization is observed separately; retention and finality are reported as they are, not awaited.
        await operation.materialized({signal:AbortSignal.timeout(30000)});
        result=facts(operation);
      }
      else if(request.action==='operation-facts') {
        const operation=session.operations.get(request.proposalId);
        result=operation ? facts(operation) : null;
      }
      else if(request.action==='operation-retry') {
        // Re-offers the original signed attempt. It never re-signs or retimestamps.
        result=facts(await session.operations.retry(request.proposalId));
      }
      else if(request.action==='close') {
        await close();
        console.log(JSON.stringify({id:request.id,closed:true,resources:process.getActiveResourcesInfo()}));
        break;
      }
      else throw Error('Unknown test action');
      console.log(JSON.stringify({id:request.id,result}));
    } catch(error) {console.log(JSON.stringify({id:request.id,error:error.message})); if(request.action==='close') break;}
  }
} finally { input?.close(); await close(); }
`;
}

const closures = new WeakMap();

/** Forced termination cleans up a failed test; it must never qualify shutdown. */
export function closeTestPeer(peer, { timeoutMs = 5_000 } = {}) {
  let closing = closures.get(peer.child);
  if (closing) return closing;
  closing = close(peer, timeoutMs);
  closures.set(peer.child, closing);
  return closing;
}

async function close(peer, timeoutMs) {
  const child = peer.child;
  const exited = child.exitCode !== null || child.signalCode !== null;
  const ended = exited ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'close');
  void ended.catch(() => {});
  let timer, acknowledgment;
  try {
    if (exited) throw Error('Native peer exited before owned shutdown was acknowledged.');
    const graceful = (async () => {
      const reply = await peer.request('close', {}, timeoutMs);
      if (reply?.closed !== true) throw Error('Native peer did not acknowledge owned shutdown.');
      acknowledgment = reply;
      child.stdin.end();
      const [code, signal] = await ended;
      if (code !== 0 || signal !== null) throw Error(`Native peer shutdown failed (exit ${code}, signal ${signal}).`);
      return { exitCode: code, signal };
    })();
    return await Promise.race([graceful, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Native peer did not exit after owned cleanup before the shutdown deadline. ' +
        (acknowledgment ? 'Shutdown acknowledged; active resource kinds: ' + JSON.stringify(acknowledgment.resources ?? [])
          : 'The owned participant has not acknowledged shutdown.'))), timeoutMs);
    })]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await ended.catch(() => {}); } finally { clearTimeout(killTimer); }
    }
    throw error;
  } finally { clearTimeout(timer); }
}
