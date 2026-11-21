// Test-only local Chromium statistics observation. No application or host I/O.
export async function readBrowserRtcEvidence() {
  const result = [];
  const type = value => ['host', 'srflx', 'prflx', 'relay'].includes(value) ? value : 'unknown';
  const bytes = value => Number.isFinite(value) && value >= 0 ? value : 0;
  for (const peer of globalThis.__firstAppRtcPeers ?? []) {
    const stats = await peer.getStats();
    for (const row of stats.values()) if (row.type === 'candidate-pair' && row.state === 'succeeded' && result.length < 32) {
      result.push({ local: type(stats.get(row.localCandidateId)?.candidateType),
        remote: type(stats.get(row.remoteCandidateId)?.candidateType),
        bytesSent: bytes(row.bytesSent), bytesReceived: bytes(row.bytesReceived) });
    }
  }
  return result;
}

export function hasNonTurnTraffic(routes) {
  const known = new Set(['host', 'srflx', 'prflx']);
  return routes.some(route => known.has(route.local) && known.has(route.remote) &&
    Number.isFinite(route.bytesSent) && route.bytesSent > 0 &&
    Number.isFinite(route.bytesReceived) && route.bytesReceived > 0);
}

export async function observeRtcTraffic(read, { timeoutMs = 5000, intervalMs = 100,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > timeoutMs) throw Error('Invalid RTC statistics observation bound');
  const started = performance.now();
  const evidence = { initial: [], final: [], attempts: 0, elapsedMs: 0,
    timeoutMs, completed: false, timedOut: false,
    scope: 'test-only getStats after the measured command; no application traffic' };
  const timeout = Error('RTC_STATISTICS_OBSERVATION_TIMEOUT');
  try {
    for (let attempt = 0; attempt <= Math.ceil(timeoutMs / intervalMs); attempt++) {
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) break;
      let timer;
      let routes;
      evidence.attempts++;
      try {
        routes = await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeout), remaining);
        })]);
      } catch (error) {
        if (error === timeout) break;
        throw error;
      } finally { clearTimeout(timer); }
      if (evidence.attempts === 1) evidence.initial = routes;
      evidence.final = routes;
      if (hasNonTurnTraffic(routes)) { evidence.completed = true; break; }
      const delay = Math.min(intervalMs, timeoutMs - (performance.now() - started));
      if (delay > 0) await pause(delay);
    }
    evidence.timedOut = !evidence.completed;
    return evidence;
  } catch (error) {
    evidence.diagnosticFailed = true;
    error.rtcObservation = evidence;
    throw error;
  } finally { evidence.elapsedMs = performance.now() - started; }
}
