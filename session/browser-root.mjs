import { rtcEndpoint, BROWSER_RTC_PROTOCOL } from './browser-rtc.mjs';
import { createOwnerLiveness } from './browser-liveness.mjs';
import { BROWSER_OWNER_PROTOCOL, checkOwnerFrame, ended } from './browser-transport.mjs';
import { SessionError } from '@chronolog/peer-session/browser';
const APPLICATION_OWNER_PROTOCOL = 'chronolog/authored-session/owner/v1';

/** Capability-only private bootstrap sideband, independent of owner RPC opening. */
export function createRootRtcEndpoint(root,{profileId,rootId}) {
  let closed=false;
  const rtc=rtcEndpoint(payload=>{if(closed)throw new SessionError('ENDPOINT_STALE');root.postMessage({protocol:BROWSER_RTC_PROTOCOL,profileId,rootId,payload});});
  const receive=({data})=>{if(!closed&&data?.protocol===BROWSER_RTC_PROTOCOL&&data.profileId===profileId&&data.rootId===rootId)rtc.dispatchEvent(new MessageEvent('message',{data:data.payload}));};
  root.addEventListener('message',receive);
  rtc.dispose=()=>{if(closed)return;closed=true;root.removeEventListener('message',receive);rtc.dispatchEvent(new Event('close'));};
  return rtc;
}

/** Private SharedWorker root lease; observation expiry never releases the owner's Web Lock. */
export function createSharedRootEndpoint(root, { profileId, rootId, ownerInstanceId, livenessTimeoutMs = 15000, requestTimeoutMs = 30000, onReplaced, rtc:providedRtc } = {}) {
  if (!Number.isFinite(livenessTimeoutMs) || livenessTimeoutMs < 100 || livenessTimeoutMs > 120000) throw new SessionError('OWNER_CONFIGURATION_INVALID');
  const liveness = createOwnerLiveness({ livenessTimeoutMs, requestTimeoutMs });
  const rtc = providedRtc ?? createRootRtcEndpoint(root,{profileId,rootId});
  const pending = new Map(), events = new EventTarget(); let attachment, pulseTimer, paused = false, pauseEpoch = 0, disposed = false, closing;
  const request = (action, timeoutMs = livenessTimeoutMs) => {
    if (disposed) return Promise.reject(new SessionError('ENDPOINT_STALE'));
    if (pending.size >= 4) return Promise.reject(new SessionError('OWNER_BUSY'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new SessionError('OWNER_UNREACHABLE')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { root.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: `root.${action}`, profileId, ownerInstanceId, rootId, id }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  const fail = code => {
    if (disposed || closing) return;
    try { events.dispatchEvent(new MessageEvent('message', { data: ended(code, attachment) })); } catch { /* The page may already have detached. */ }
    try { onReplaced?.({ previous: ownerInstanceId, reason: code }); } catch { /* Observation is not ownership. */ }
    void close();
  };
  const receive = ({ data }) => {
    if (disposed) return;
    if (data?.protocol === APPLICATION_OWNER_PROTOCOL) {
      if (data.attachment !== attachment || !['response', 'notice'].includes(data.kind)) return;
      try { checkOwnerFrame(data); liveness.authenticated(); events.dispatchEvent(new MessageEvent('message', { data })); }
      catch { fail('OWNER_MESSAGE_LIMIT'); }
      return;
    }
    if (data?.protocol !== BROWSER_OWNER_PROTOCOL) return;
    if (data.type === 'failure' && data.code === 'OWNER_UNREACHABLE') { fail('OWNER_UNREACHABLE'); return; }
    if (data.rootId !== rootId || data.ownerInstanceId !== ownerInstanceId) return;
    if (data.type === 'root.ended') { fail(data.code ?? 'ENDPOINT_STALE'); return; }
    const waiter = pending.get(data.id); if (!waiter) return;
    if (data.type !== 'root.result' && data.type !== 'failure') return;
    clearTimeout(waiter.timer); pending.delete(data.id);
    if (data.type === 'failure') waiter.reject(new SessionError(data.code ?? 'OWNER_UNREACHABLE', data.message));
    else { liveness.authenticated(); waiter.resolve(); }
  };
  const pulse = async () => {
    clearTimeout(pulseTimer); if (disposed || closing || paused) return;
    const epoch = pauseEpoch;
    const remaining = liveness.deadline() - performance.now();
    if (remaining <= 0) { fail('OWNER_UNREACHABLE'); return; }
    try { await request('ping', Math.min(livenessTimeoutMs, remaining)); }
    catch {
      if (disposed || closing || paused || epoch !== pauseEpoch) return;
      const left = liveness.deadline() - performance.now();
      if (left <= 0) { fail('OWNER_UNREACHABLE'); return; }
      pulseTimer = setTimeout(pulse, Math.min(left, Math.max(50, Math.min(5000, livenessTimeoutMs / 3))));
      pulseTimer.unref?.(); return;
    }
    if (!disposed && !closing && !paused && epoch === pauseEpoch) {
      pulseTimer = setTimeout(pulse, Math.max(50, Math.min(5000, livenessTimeoutMs / 3))); pulseTimer.unref?.();
    }
  };
  function close() {
    if (closing) return closing;
    clearTimeout(pulseTimer); liveness.clear();
    closing = (async () => {
      try { await request('detach', Math.min(1000, livenessTimeoutMs)); } catch { /* A dead worker cannot retain the local facade. */ }
      finally {
        disposed = true; rtc.dispose(); root.removeEventListener('message', receive); root.removeEventListener('close', physicalClosed); root.removeEventListener('messageerror', physicalClosed);
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new SessionError('ENDPOINT_STALE')); }
        pending.clear(); root.close?.();
      }
    })();
    if (attachment !== undefined) events.dispatchEvent(new MessageEvent('message', { data: ended('ENDPOINT_STALE', attachment) }));
    return closing;
  }
  const physicalClosed = () => fail('OWNER_UNREACHABLE');
  root.addEventListener('message', receive); root.addEventListener('close', physicalClosed); root.addEventListener('messageerror', physicalClosed); void pulse();
  return { rtc, postMessage(frame) {
    if (disposed || closing || frame?.protocol !== APPLICATION_OWNER_PROTOCOL || !['request', 'cancel'].includes(frame.kind) || typeof frame.attachment !== 'string') throw new SessionError('OWNER_HANDSHAKE_INVALID');
    checkOwnerFrame(frame);
    if (attachment === undefined) { if (frame.kind !== 'request' || frame.method !== 'hello') throw new SessionError('OWNER_HANDSHAKE_INVALID'); attachment = frame.attachment; }
    if (frame.attachment !== attachment) throw new SessionError('ENDPOINT_STALE');
    root.postMessage(frame);
  }, addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args),
  bindRequestSource: session => liveness.bind(session),
  park({frozen=false}={}) {
    if (disposed || closing) throw new SessionError('ENDPOINT_STALE');
    paused = true; pauseEpoch++; clearTimeout(pulseTimer);
    // A freeze event cannot await an acknowledgement. The private root port
    // scopes this one-way pause; only a fresh resume reply rearms liveness.
    root.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'root.park', frozen, profileId, ownerInstanceId, rootId, id: crypto.randomUUID() });
  },
  async suspend() {
    if (disposed || closing) throw new SessionError('ENDPOINT_STALE');
    paused = true; pauseEpoch++; clearTimeout(pulseTimer);
    // Missing a suspension acknowledgement cannot prove an owner is dead.
    await request('suspend');
  },
  async resume() {
    if (disposed || closing) throw new SessionError('ENDPOINT_STALE');
    const epoch = pauseEpoch;
    try { await request('resume'); if(epoch !== pauseEpoch)return; paused = false; void pulse(); }
    catch (error) { if(epoch !== pauseEpoch)return; paused = false; fail('OWNER_UNREACHABLE'); throw error; }
  },
  relinquish() {
    if (disposed) return;
    try { root.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'root.detach', profileId, ownerInstanceId, rootId, id: crypto.randomUUID() }); }
    catch { /* The active lease or parked document-witness sweep reclaims a lost detach. */ }
  }, close };
}
