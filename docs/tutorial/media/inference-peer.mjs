// Run instead of `node session.mjs`: both need the same exclusive native signer.
// Set OPENAI_API_KEY privately, then: node media/inference-peer.mjs \
//   --model YOUR_IMAGE_CAPABLE_MODEL --allow-device BROWSER_PUBLIC_KEY --max-requests 1
// Enter credentials through your native environment/secret manager, not shell
// history or authored files. Launching this process explicitly opts into costs.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCliLifetime } from '../helpers/cli-lifetime.mjs';
import { openSession } from '../session.mjs';
import { servePeerInference } from './inference-service.mjs';
import { digestPattern } from './inference-protocol.mjs';

// The exported runner never owns the embedding process.
export async function runInference({ args = process.argv.slice(2), signal } = {}, { onOwned, onClosed } = {}) {
  signal?.throwIfAborted();
  const { values } = parseArgs({ args, options: { 'allow-device': { type: 'string', multiple: true },
    'max-requests': { type: 'string', default: '1' }, model: { type: 'string' }, provider: { type: 'string' },
    'max-output-tokens': { type: 'string', default: '600' } }, strict: true });
  const allowedDevices = values['allow-device'] ?? [], maxRequests = Number(values['max-requests']);
  if (!allowedDevices.length || allowedDevices.some(id => !digestPattern.test(id))) throw Error('Supply --allow-device with each explicitly authorized browser device public key.');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw Error('Supply a request budget from 1 to 100. The default is one request for this process lifetime.');
  const providerUrl = values.provider ? pathToFileURL(resolve(values.provider)).href : new URL('./provider-openai.mjs', import.meta.url).href;
  const provider = await import(providerUrl);
  if (typeof provider.createInferenceProvider !== 'function') throw Error('The chosen native provider must export createInferenceProvider(options).');
  const infer = await provider.createInferenceProvider({ model: values.model, maxOutputTokens: Number(values['max-output-tokens']) });
  let owned, service;
  try {
    owned = await openSession({ signal }); onOwned?.();
    service = servePeerInference({ session: owned.session, allowedDevices, maxRequests, infer, signal,
      onStatus: status => console.log(JSON.stringify({ inference: status })) });
    console.log(`Credential-protected inference peer: ${owned.session.identity.publicKey}`);
    console.log('Requests and suggestions are visible to application readers. Provider credentials remain in this native process.');
    console.log('Suggestions require page review and a separate declared command. Ctrl-C closes the peer; restart explicitly renews this process budget.');
    await service.done;
  } finally { try { await service?.close(); } finally { await owned?.close(); } if (owned) onClosed?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = createCliLifetime();
  try { await runInference({ signal: cli.signal }, { onOwned: cli.opened, onClosed: cli.closed }); }
  catch (error) { cli.fail(error); }
  process.exit(await cli.finish());
}
