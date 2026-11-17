export class SignalError extends Error {
  constructor(code, message) { super(message); this.name = 'SignalError'; this.code = code; }
}
export { connectHostedSignals, createHostedSignalPort, HOSTED_SIGNAL_PROTOCOL, SIGNAL_LIMITS } from './hosted-signals.mjs';

/** A live messaging port is independent of the page's durable application history. */
export function createSignalBinding(initial) {
  let service;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const current = () => {
    if (!service) throw new SignalError('signal_unavailable', 'Install a live signal implementation before sending or subscribing');
    return service;
  };
  const binding = Object.freeze({
    get available() { return service !== undefined; },
    ready: () => ready,
    install(value) {
      if (service) throw new SignalError('signals_already_installed', 'Reconnect within the installed signal implementation');
      if (!value || value === binding || typeof value.send !== 'function' || typeof value.subscribe !== 'function')
        throw new SignalError('invalid_signals', 'Signals must implement send and subscribe');
      service = value;
      resolveReady(value);
    },
    async send(topic, payload, options) { return current().send(topic, payload, options); },
    subscribe(options) { return current().subscribe(options); },
  });
  if (initial !== undefined) binding.install(initial);
  return binding;
}
