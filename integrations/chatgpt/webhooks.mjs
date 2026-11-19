import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { callbackUrl, publicAddress } from './webhook-data.mjs';
import { fail } from './common.mjs';
export * from './webhook-data.mjs';

// Supplying this lookup directly to https.request validates the addresses at
// socket creation and dials those exact addresses, preserving TLS hostname/SNI.
export function publicLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    Promise.resolve().then(() => resolve(hostname, { all: true, verbatim: true })).then(addresses => {
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !publicAddress(item.address)))
        fail('CALLBACK_ADDRESS_BLOCKED', 'Callback destination must have only public addresses');
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(error => callback(error));
  };
}

export function createPublicWebhookTransport({ resolve, requestImpl = request, timeoutMs = 10000, maxResponseBytes = 8192 } = {}) {
  const checkedLookup = publicLookup(resolve);
  return async function send(url, { body, headers, signal, prepareWrite, beforeWrite } = {}) {
    const target = new URL(callbackUrl(url));
    if (typeof body !== 'string' || Buffer.byteLength(body) > 262144)
      fail('EVENT_TOO_LARGE', 'Webhook body must be a string of at most 256 KiB');
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const req = requestImpl(target, { method: 'POST', agent: false,
        lookup: checkedLookup, rejectUnauthorized: true, signal: combined,
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, response => {
        response.on('error', reject);
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy(); req.destroy();
          reject(Object.assign(Error('Webhook redirects are not allowed'), { code: 'CALLBACK_REDIRECT' }));
          return;
        }
        let bytes = 0; const chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            response.destroy(); reject(Object.assign(Error('Webhook response exceeds limit'), { code: 'CALLBACK_RESPONSE_TOO_LARGE' }));
          } else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => resolveResult({ status, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      // Wait for authenticated TLS before checking the native selection and
      // handing the event bytes to Node. DNS/connect must not queue an old event.
      if (!beforeWrite) req.end(body);
      else req.once('socket', socket => socket.once('secureConnect', async () => {
        try {
          combined.throwIfAborted();
          if (prepareWrite) await prepareWrite();
          combined.throwIfAborted();
          beforeWrite();
          req.end(body);
        } catch (error) { req.destroy(error); reject(error); }
      }));
    });
  };
}
