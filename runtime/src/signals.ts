import { createHostedSignalPort } from '../../contract/hosted-signals.mjs';
import type { Core } from './types';

/** Reuse the hosted page connection; no extra socket, persistent queue or stream setup. */
export function createHostedSignals(core: Pick<Core, 'application' | 'bus' | 'connected' | 'transportRequest'>) {
  return createHostedSignalPort({
    connected: () => core.connected,
    scope: () => core.application.selection.id,
    request: (message, options) => core.transportRequest(message, options),
    onMessage: listener => core.bus.on('signal', message => listener(message.signal)),
    onConnection: listener => {
      const connected = core.bus.on('connect', listener), disconnected = core.bus.on('disconnect', listener);
      return () => { connected(); disconnected(); };
    },
  });
}
