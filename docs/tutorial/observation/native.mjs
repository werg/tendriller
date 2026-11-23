import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { serveObservations } from './receiver.mjs';
import { whenConnected } from '../helpers/signal-request.mjs';
import { createCliLifetime } from '../helpers/cli-lifetime.mjs';

// Attach to the already-running owner. This module never creates another signer.
export async function runObservationReceiver({
  sessionModule, allowedDevices, requestSource, signal,
  onState = value => console.log(JSON.stringify(value)),
  onOpened = () => {},
  onClosed = () => {},
}) {
  const bootstrap = await import(pathToFileURL(resolve(sessionModule)).href);
  if (typeof bootstrap.attachSession !== 'function') {
    throw Error('The session module must export attachSession; run the retained native peer first.');
  }
  const attached = await bootstrap.attachSession({ signal });
  onOpened();
  let receiver;
  try {
    receiver = serveObservations({ session: attached.session, allowedDevices, signal, onState });
    if (requestSource) {
      for (const peer of allowedDevices) {
        const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)].filter(Boolean));
        await whenConnected(attached.session, peer, { signal: waitSignal });
        await receiver.requestObservation(peer, requestSource);
      }
    }
    await receiver.done;
  } finally {
    try { await receiver?.close(); }
    finally {
      await attached.detach();
      onClosed();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = createCliLifetime();
  try {
    const args = process.argv.slice(2), values = new Map();
    for (let index = 0; index < args.length; index += 2) {
      if (!['--session', '--allow', '--request'].includes(args[index]) || !args[index + 1] || values.has(args[index])) {
        throw Error('Usage: node observation/native.mjs --session ./session.mjs --allow DEVICE_ID[,DEVICE_ID] [--request simulated|location]');
      }
      values.set(args[index], args[index + 1]);
    }
    if (!values.has('--session') || !values.has('--allow')
      || (values.has('--request') && !['simulated', 'location'].includes(values.get('--request')))) {
      throw Error('Supply --session, --allow, and an optional --request simulated|location.');
    }
    await runObservationReceiver({
      sessionModule: values.get('--session'),
      allowedDevices: values.get('--allow').split(','),
      requestSource: values.get('--request'),
      signal: cli.signal,
      onOpened: cli.opened,
      onClosed: cli.closed,
    });
  } catch (error) {
    cli.fail(error);
  }
  process.exit(await cli.finish());
}
