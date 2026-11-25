// The native part of one page inside `tendril agent run`. The agent program passes
// a page context (page client, private records, a device with the shared signer);
// this module returns the page owner that the program's attach socket serves.
import { signTransitionRequest, verifyAuthorityBundle } from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { createDevicePairingClient } from '@tendriller/core/pairing';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { createReviewedPairingProcessor } from './pairing-native.mjs';
import { superviseParticipant } from './participant-lifecycle.mjs';

/** Pairing on the page's own owner: the shared signer signs in place and is never exported. */
export function pairingFor(context, { session, device, descriptor }) {
  const pairing = Object.freeze({ descriptor, applicationId: context.page.applicationId,
    serviceOrigin: context.service, pageOrigin: new URL(context.page.pageUrl).origin,
    authority: options => context.host.peers.application(options),
    signTransition: payload => signTransitionRequest(payload, device.identity),
    client: createDevicePairingClient({ url: context.host.base + '/peers/pairing', fetch: (url, options = {}) =>
      context.host.fetch(url, { ...options, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[context.signal, options.signal].filter(Boolean)]) }) }),
  });
  return { pairing, processPairings: createReviewedPairingProcessor({ session, pairing,
    store: { save: context.savePrivate, load: name => context.readPrivate(name, true) } }) };
}

/** Open the retained device, verify authority against the pinned descriptor and compose
 * control, peer participation, setup notices, reviewed pairing and an optional assistant. */
export async function openNativePage(context, { openApplication, assistant } = {}) {
  const { signal, report } = context;
  signal?.throwIfAborted();
  const authority = await context.host.peers.application({ signal });
  const descriptor = await context.readPrivate('descriptor.json');
  await verifyAuthorityBundle(authority, descriptor);
  const device = await context.openDevice();
  let session, lifecycle;
  try {
    session = await openApplication({ device, authority, context });
    const control = session.connectControlParticipant({ exchange: (message, options) => context.host.peers.exchange(message, options) });
    participateNativeApplication(session, { peers: context.host.peers, control });
    const { processPairings } = pairingFor(context, { session, device, descriptor });
    const owned = { session, control, processPairings };
    const optional = assistant ? await assistant({ context, session }) : {};
    lifecycle = superviseParticipant({ owned, signal: session.signal, report,
      watch: callbacks => watchApplicationSetup({ page: context.host, ...callbacks }), ...optional });
    const owner = createApplicationOwner(session, { host: control });
    const close = owner.close.bind(owner);
    // Integrations stop before the session; the signer store closes with the session.
    return Object.assign(owner, { control, close: async () => { try { await lifecycle.close(); } finally { await close(); } } });
  } catch (error) {
    try { await lifecycle?.close(); } catch {}
    if (session) await session.close(); else await device.close();
    throw error;
  }
}
