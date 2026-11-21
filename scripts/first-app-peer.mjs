import { once } from 'node:events';
import { readFileSync } from 'node:fs';

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

/** The test participant owns the complete bootstrap, including its supervisor. */
export function nativeTestPeerSource({ evidenceBase64, browserDeviceId, transportModule, networkQualification = false }) {
  return `import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {openSession} from './session.mjs';
import {superviseParticipant} from './helpers/participant-lifecycle.mjs';
import {servePeerInference} from './media/inference-service.mjs';
import {serveSignalRequests, sendPieces} from './helpers/signal-request.mjs';
${transportModule ? `import {closeLocalTransport} from ${JSON.stringify(transportModule)};` : 'const closeLocalTransport = async () => {};'}
const owned = await openSession(), {session,supervisor} = owned;
const expectedEvidence = new Uint8Array(Buffer.from(${JSON.stringify(evidenceBase64)}, 'base64'));
const lifecycleLog = [];
let pairings, pairingStatus = null, inference, input, closing, inferenceCalls = 0, inferenceSource = null, requestTask, requestFailure;
const requestsStopped = new AbortController();
const close = () => closing ??= (async () => {
  const errors = [];
  requestsStopped.abort();
  await requestTask;
  if(requestFailure) errors.push(requestFailure);
  try { await pairings?.close(); } catch (error) { errors.push(error); }
  try { await inference?.close(); } catch (error) { errors.push(error); }
  try { await owned.close(); } catch (error) { errors.push(error); }
  // The local fixture owns its custom HTTP/WebSocket dispatcher separately from
  // the application. It must drain only after the real owner closes its sockets.
  try { await closeLocalTransport(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Native test participant cleanup failed: ' + errors.map(error => error.message).join('; '));
})();
try {
  pairings = superviseParticipant({owned,watch:owned.watchSetup,
    report:(value) => { if(value.pairing) pairingStatus={state:value.pairing.state,code:value.pairing.code ?? null};
      if (lifecycleLog.length < 200) lifecycleLog.push({at:Date.now(),...(value.pairing ? {pairing:value.pairing.state,pairingId:value.pairing.pairingId ?? null} : {state:value.state ?? null,setup:value.setup ?? null})}); }});
  inference = servePeerInference({session, allowedDevices: [${JSON.stringify(browserDeviceId)}], maxRequests: ${networkQualification ? 20 : 2},
    async infer({bytes, mediaType, source, signal}) {
      signal.throwIfAborted(); assert.deepEqual(bytes, expectedEvidence); assert.equal(mediaType, 'image/png');
      inferenceCalls++; inferenceSource = source;
      return {text: 'Suggested fixture observation'};
    },
  });
  // Every participation change, with its peer set, so the harness can count churn.
  const participationLog = [];
  // Application status transitions (phase, generation, database) for failure diagnosis.
  const statusLog = [];
  session.onStatus?.(status => { const last = statusLog.at(-1);
    if (statusLog.length < 500 && (!last || last.phase !== status.phase || last.generation !== status.generation || last.database !== status.database))
      statusLog.push({at:Date.now(),phase:status.phase,generation:status.generation,database:status.database}); });
  session.participation.onStatus(status => { if (participationLog.length < 5000) participationLog.push({at:Date.now(),phase:status.phase,peers:[...status.connectedPeers].sort(),error:status.error}); });
  requestTask = serveSignalRequests(session, { signal: requestsStopped.signal, handle: async (q, input) => {
    if (q !== 'rows') throw Object.assign(Error('Unknown request'), { code: 'unknown' });
    assert.ok(Number.isSafeInteger(input?.count) && input.count >= 0 && input.count <= 1024);
    assert.ok(Number.isSafeInteger(input?.width) && input.width >= 0 && input.width <= 4096);
    return { rows: Array.from({ length: input.count }, (_value, index) => ({ index, label: 'row "' + index + '"', text: 'x'.repeat(input.width) })) };
  } }).catch(error => { requestFailure=Object.assign(Error('Signal reply service failed'), {code:error?.code || 'SIGNAL_REQUEST_FAILED'}); });
  console.log(JSON.stringify({ready:true,deviceId:session.deviceId,ownerInstanceId:supervisor.ownerInstanceId}));
  input = createInterface({input:process.stdin});
  for await (const line of input) {
    const request=JSON.parse(line);
    try {
      let result;
      if(request.action==='query') result=await session.query('notes',null);
      ${networkQualification ? `else if(request.action==='transport-snapshot' || request.action==='transport-wait') {
        const snapshot=async()=>{
          const links=await session.participation.diagnostics();
          const link=links.find(link=>link.peerId===${JSON.stringify(browserDeviceId)});
          return {connectionRevision:session.participation.status.connectionRevision,
            ...(link?Object.fromEntries(['kind','sentReliableBytes','receivedReliableBytes','sentLiveBytes','receivedLiveBytes'].map(key=>[key,link[key]])):{kind:'unknown'})};
        };
        if(request.action==='transport-snapshot') result=await snapshot();
        else {
          assert.ok(['direct','relay','unknown'].includes(request.kind));
          result=await new Promise((resolve,reject)=>{
            let stopped=false,checking=false,again=false,revision=-1;
            let remove=()=>{};
            const finish=(error,value)=>{if(stopped)return;stopped=true;clearTimeout(timer);remove();error?reject(error):resolve(value);};
            const check=async()=>{
              if(stopped)return;
              if(checking){again=true;return;}
              checking=true;
              try{const value=await snapshot();if(value.kind===request.kind)finish(null,value);}
              catch(error){finish(error);}
              finally{checking=false;if(again){again=false;void check();}}
            };
            const timer=setTimeout(()=>finish(Error('NETWORK_QUALIFICATION_ROUTE_TIMEOUT')),55000);
            remove=session.participation.onStatus(status=>{if(status.connectionRevision!==revision){revision=status.connectionRevision;void check();}});
          });
        }
      }` : ''}
      else if(request.action==='diagnostics') result={status:session.status,participation:session.participation.status,pairing:pairingStatus,statusLog,lifecycleLog,
        signalRequests:{state:requestFailure?'failed':requestsStopped.signal.aborted?'closed':'running',code:requestFailure?.code ?? null}};
      else if(request.action==='participation-log') result={entries:participationLog.splice(0),current:{phase:session.participation.status.phase,peers:[...session.participation.status.connectedPeers].sort()}};
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
        result={sent:request.pieces-failures.length,failures,retries,ms:Date.now()-started,pieceMs,eventLoopLagMaxMs:lagMax,participation:session.participation.status.phase};
      }
      else if(request.action==='ordering-pause') result={pause:await session.orderingPause()};
      else if(request.action==='pairing-process') result=await owned.processPairings();
      else if(request.action==='inference-status') result={...inference.snapshot(), calls:inferenceCalls, source:inferenceSource};
      else if(request.action==='command') {
        const before=await session.query('notes',null);
        const operation=await session.command('addNote',{text:request.text},{operationId:request.operationId,basedOn:before.revision});
        result=await operation.applied({signal:AbortSignal.timeout(30000)});
      } else if(request.action==='close') {
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
