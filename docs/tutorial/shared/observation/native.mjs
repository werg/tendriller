import { pathToFileURL } from 'node:url';
import { serveObservations } from './receiver.mjs';
import { whenConnected } from '../helpers/signal-request.mjs';
import { createCliLifetime } from '../cli-lifetime.mjs';

// Attach to the page owner inside the running `tendril agent run`. This module never
// creates another signer. `attach({ signal })` returns { session, detach }.
export async function runObservationReceiver({
  attach, allowedDevices, requestSource, signal,
  onState = value => console.log(JSON.stringify(value)),
  onOpened = () => {},
  onClosed = () => {},
}) {
  if (typeof attach !== 'function') throw Error('Supply the page attachment; start npm run agent first.');
  const attached = await attach({ signal });
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
      if (!['--page', '--allow', '--request'].includes(args[index]) || !args[index + 1] || values.has(args[index])) {
        throw Error('Usage: node shared/observation/native.mjs --page SLUG --allow DEVICE_ID[,DEVICE_ID] [--request simulated|location]');
      }
      values.set(args[index], args[index + 1]);
    }
    if (!values.has('--page') || !values.has('--allow')
      || (values.has('--request') && !['simulated', 'location'].includes(values.get('--request')))) {
      throw Error('Supply --page, --allow, and an optional --request simulated|location.');
    }
    const [{ attachPage }, { workspace }] = await Promise.all([import('@tendriller/tools/workspace'), import('../local.mjs')]);
    const selected = await workspace();
    await runObservationReceiver({
      attach: options => attachPage(selected, values.get('--page'), options),
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
