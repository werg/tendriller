import { once } from 'node:events';

/** The test participant owns the complete bootstrap, including its supervisor. */
export function nativeTestPeerSource({ evidenceBase64, browserDeviceId, transportModule }) {
  return `import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {openSession} from './session.mjs';
import {superviseParticipant} from './helpers/participant-lifecycle.mjs';
import {servePeerInference} from './media/inference-service.mjs';
import {serveSignalRequests} from './helpers/signal-request.mjs';
${transportModule ? `import {closeLocalTransport} from ${JSON.stringify(transportModule)};` : 'const closeLocalTransport = async () => {};'}
const owned = await openSession(), {session,supervisor} = owned;
const expectedEvidence = new Uint8Array(Buffer.from(${JSON.stringify(evidenceBase64)}, 'base64'));
let pairings, pairingStatus = null, inference, input, closing, inferenceCalls = 0, inferenceSource = null;
const close = () => closing ??= (async () => {
  const errors = [];
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
    report:({pairing}) => { if(pairing) pairingStatus={state:pairing.state,code:pairing.code ?? null}; }});
  inference = servePeerInference({session, allowedDevices: [${JSON.stringify(browserDeviceId)}], maxRequests: 2,
    async infer({bytes, mediaType, source, signal}) {
      signal.throwIfAborted(); assert.deepEqual(bytes, expectedEvidence); assert.equal(mediaType, 'image/png');
      inferenceCalls++; inferenceSource = source;
      return {text: 'Suggested fixture observation'};
    },
  });
  // Every participation change, with its peer set, so the harness can count churn.
  const participationLog = [];
  session.participation.onStatus(status => { if (participationLog.length < 5000) participationLog.push({at:Date.now(),phase:status.phase,peers:[...status.connectedPeers].sort(),error:status.error}); });
  const requestsStopped = new AbortController();
  void serveSignalRequests(session, { signal: requestsStopped.signal, handle: async (q, input) => {
    if (q !== 'rows') throw Object.assign(Error('Unknown request'), { code: 'unknown' });
    return { rows: Array.from({ length: input.count }, (_value, index) => ({ index, label: 'row "' + index + '"', text: 'x'.repeat(input.width) })) };
  } }).catch(() => {});
  console.log(JSON.stringify({ready:true,deviceId:session.deviceId,ownerInstanceId:supervisor.ownerInstanceId}));
  input = createInterface({input:process.stdin});
  for await (const line of input) {
    const request=JSON.parse(line);
    try {
      let result;
      if(request.action==='query') result=await session.query('notes',null);
      else if(request.action==='diagnostics') result={status:session.status,participation:session.participation.status,pairing:pairingStatus};
      else if(request.action==='participation-log') result={entries:participationLog.splice(0),current:{phase:session.participation.status.phase,peers:[...session.participation.status.connectedPeers].sort()}};
      else if(request.action==='signal-state') {
        // Periodic state updates, as a dashboard sends them.
        for(let index=0;index<request.count;index++){ await session.signals.send('state',{index,at:Date.now()},{ttlMs:30000}); await new Promise(r=>setTimeout(r,request.intervalMs)); }
        result={sent:request.count};
      }
      else if(request.action==='signal-burst') {
        // A reply larger than one signal, sent piece by piece as an app would: each send awaited, none retried.
        const failures=[], started=Date.now();
        for(let index=0;index<request.pieces;index++){
          try{await session.signals.send(request.topic,{id:request.id,i:index,n:request.pieces,z:'x'.repeat(request.bytes)},{ttlMs:30000});}
          catch(error){failures.push(error.code||error.message);}
        }
        result={sent:request.pieces-failures.length,failures,ms:Date.now()-started};
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
