import { rtcEndpoint, BROWSER_RTC_PROTOCOL } from './browser-rtc.mjs';
import { createOwnerLiveness } from './browser-liveness.mjs';
import { BROWSER_OWNER_PROTOCOL, checkOwnerFrame, ended } from './browser-transport.mjs';
import { CollaborationError } from './protocol.mjs';

/** Capability-only private bootstrap sideband, independent of owner RPC opening. */
export function createRootRtcEndpoint(root,{profileId,rootId}) {
  let closed=false;
  const rtc=rtcEndpoint(payload=>{if(closed)throw new CollaborationError('ENDPOINT_STALE');root.postMessage({protocol:BROWSER_RTC_PROTOCOL,profileId,rootId,payload});});
  const receive=({data})=>{if(!closed&&data?.protocol===BROWSER_RTC_PROTOCOL&&data.profileId===profileId&&data.rootId===rootId)rtc.dispatchEvent(new MessageEvent('message',{data:data.payload}));};
  root.addEventListener('message',receive);
  rtc.dispose=()=>{if(closed)return;closed=true;root.removeEventListener('message',receive);rtc.dispatchEvent(new Event('close'));};
  return rtc;
}

/** Private SharedWorker root lease; observation expiry never releases the owner's Web Lock. */
export function createSharedRootEndpoint(root, { profileId, rootId, ownerInstanceId, livenessTimeoutMs = 15000, requestTimeoutMs = 30000, onReplaced, rtc:providedRtc } = {}) {
  if (!Number.isFinite(livenessTimeoutMs) || livenessTimeoutMs < 100 || livenessTimeoutMs > 120000) throw new CollaborationError('OWNER_CONFIGURATION_INVALID');
  const liveness = createOwnerLiveness({ livenessTimeoutMs, requestTimeoutMs });
  const rtc = providedRtc ?? createRootRtcEndpoint(root,{profileId,rootId});
  const pending = new Map(); let local, remote, pulseTimer, paused = false, pauseEpoch = 0, disposed = false, closing;
  const request = (action, timeoutMs = livenessTimeoutMs) => {
    if (disposed) return Promise.reject(new CollaborationError('ENDPOINT_STALE'));
    if (pending.size >= 4) return Promise.reject(new CollaborationError('OWNER_BUSY'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new CollaborationError('OWNER_UNREACHABLE')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { root.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: `root.${action}`, profileId, ownerInstanceId, rootId, id }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  const fail = code => {
    if (disposed || closing) return;
    try { local?.postMessage(ended(code)); } catch { /* The page may already have detached. */ }
    try { onReplaced?.({ previous: ownerInstanceId, reason: code }); } catch { /* Observation is not ownership. */ }
    void close();
  };
  const receive = ({ data }) => {
    if (disposed) return;
    if (data?.protocol !== BROWSER_OWNER_PROTOCOL) return;
    if (data.type === 'failure' && data.code === 'OWNER_UNREACHABLE') { fail('OWNER_UNREACHABLE'); return; }
    if (data.rootId !== rootId || data.ownerInstanceId !== ownerInstanceId) return;
    if (data.type === 'root.ended') { fail(data.code ?? 'ENDPOINT_STALE'); return; }
    const waiter = pending.get(data.id); if (!waiter) return;
    if (data.type !== 'root.result' && data.type !== 'failure') return;
    clearTimeout(waiter.timer); pending.delete(data.id);
    if (data.type === 'failure') waiter.reject(new CollaborationError(data.code ?? 'OWNER_UNREACHABLE', data.message));
    else { liveness.authenticated(); waiter.resolve(); }
  };
  const pulse = async () => {
    clearTimeout(pulseTimer); if (disposed || closing || paused) return;
    const remaining = liveness.deadline() - performance.now();
    if (remaining <= 0) { fail('OWNER_UNREACHABLE'); return; }
    try { await request('ping', Math.min(livenessTimeoutMs, remaining)); }
    catch {
      if (disposed || closing || paused) return;
      const left = liveness.deadline() - performance.now();
      if (left <= 0) { fail('OWNER_UNREACHABLE'); return; }
      pulseTimer = setTimeout(pulse, Math.min(left, Math.max(50, Math.min(5000, livenessTimeoutMs / 3))));
      pulseTimer.unref?.(); return;
    }
    if (!disposed && !closing && !paused) {
      pulseTimer = setTimeout(pulse, Math.max(50, Math.min(5000, livenessTimeoutMs / 3))); pulseTimer.unref?.();
    }
  };
  function close() {
    if (closing) return closing;
    clearTimeout(pulseTimer); liveness.clear();
    closing = (async () => {
      try { await request('detach', Math.min(1000, livenessTimeoutMs)); } catch { /* A dead worker cannot retain the local facade. */ }
      finally {
        disposed = true; rtc.dispose(); root.removeEventListener('message', receive);
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new CollaborationError('ENDPOINT_STALE')); }
        pending.clear(); local?.close(); remote?.close(); root.close?.();
      }
    })(); return closing;
  }
  root.addEventListener('message', receive); void pulse();
  return { rtc, postMessage(frame) {
    if (disposed || closing || local || !frame?.port || typeof frame.port.postMessage !== 'function') throw new CollaborationError('OWNER_HANDSHAKE_INVALID');
    checkOwnerFrame(frame.handshake);
    const wire = new MessageChannel(); local = frame.port; remote = wire.port1;
    local.addEventListener('message', ({ data }) => {
      if (disposed || closing) return;
      try { checkOwnerFrame(data); remote.postMessage(data); } catch { fail('OWNER_MESSAGE_LIMIT'); }
    }); local.start();
    remote.addEventListener('message', ({ data }) => {
      if (disposed) return;
      try { checkOwnerFrame(data); liveness.authenticated(); local.postMessage(data); if (data?.ended) void close(); }
      catch { fail('OWNER_MESSAGE_LIMIT'); }
    }); remote.start();
    root.postMessage({ ...frame, port: wire.port2 }, [wire.port2]);
  }, addEventListener() {}, removeEventListener() {},
  bindRequestSource: session => liveness.bind(session),
  park() {
    if (disposed || closing) throw new CollaborationError('ENDPOINT_STALE');
    paused = true; pauseEpoch++; clearTimeout(pulseTimer);
    // A freeze event cannot await an acknowledgement. The private root port
    // scopes this one-way pause; only a fresh resume reply rearms liveness.
    root.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'root.suspend', profileId, ownerInstanceId, rootId, id: crypto.randomUUID() });
  },
  async suspend() {
    if (disposed || closing) throw new CollaborationError('ENDPOINT_STALE');
    paused = true; pauseEpoch++; clearTimeout(pulseTimer);
    // Missing a suspension acknowledgement cannot prove an owner is dead.
    await request('suspend');
  },
  async resume() {
    if (disposed || closing) throw new CollaborationError('ENDPOINT_STALE');
    const epoch = pauseEpoch;
    try { await request('resume'); if(epoch !== pauseEpoch)return; paused = false; void pulse(); }
    catch (error) { paused = false; fail('OWNER_UNREACHABLE'); throw error; }
  },
  relinquish() {
    if (disposed) return;
    try { root.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'root.detach', profileId, ownerInstanceId, rootId, id: crypto.randomUUID() }); }
    catch { /* The root lease still bounds a lost pagehide message. */ }
  }, close };
}
