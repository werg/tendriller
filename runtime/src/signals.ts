import { connectHostedSignals, createHostedSignals, SignalError, type HostedSignalConnectionOptions, type HostedSignals } from '../../contract/signals.mjs';

/** Page-owned live connection. It shares authentication, never durable transport. */
export function createHostedPageSignals(options: Pick<HostedSignalConnectionOptions, 'api' | 'socket'>) {
  let live: HostedSignals | undefined, opening: AbortController | undefined, suspended = false;
  // Keep the public validation and cancellation contract while no socket is ready.
  const unavailable = createHostedSignals({ connected: () => false, send: () => false,
    onMessage: () => () => {}, onDisconnect: () => () => {} });
  const connect = () => {
    if (suspended || opening || live?.connected) return;
    live?.close(); live = undefined;
    const current = new AbortController(); opening = current;
    void connectHostedSignals({ ...options, signal: current.signal }).then(service => {
      if (opening === current && !suspended) live = service;
      else service.close();
    }).catch(() => { /* Fresh calls report disconnection; no live intent waits here. */ })
      .finally(() => { if (opening === current) opening = undefined; });
  };
  connect();
  return {
    get connected() { return live?.connected === true; },
    async send(...args: Parameters<HostedSignals['send']>) {
      if (live?.connected) return live.send(...args);
      try { return await unavailable.send(...args); }
      catch (error) { if (error instanceof SignalError && error.code === 'signal_disconnected') connect(); throw error; }
    },
    subscribe(...args: Parameters<HostedSignals['subscribe']>) {
      if (live?.connected) return live.subscribe(...args);
      try { return unavailable.subscribe(...args); }
      catch (error) { if (error instanceof SignalError && error.code === 'signal_disconnected') connect(); throw error; }
    },
    suspend() { suspended = true; opening?.abort(); opening = undefined; live?.close(); live = undefined; },
    resume() { suspended = false; connect(); },
  };
}
