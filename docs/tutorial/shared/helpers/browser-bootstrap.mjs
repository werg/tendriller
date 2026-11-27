import { createPeersClient } from '@tendriller/core/peers';
import { createAdmission, deviceWrapKey, openPageGenesis } from '@tendriller/core/admission';

/**
 * Open or initialize a browser device's Chronolog v2 genesis and wrap key.
 * On an uninitialized page, the owner's browser creates genesis; on an initialized
 * page it pins the host's genesis and waits for an online member to admit it.
 */
export async function bootstrapBrowser({ configuration, device, imports, topics, signal }) {
  const base = new URL('_tendril/', configuration.page_url);
  if (base.origin !== globalThis.location.origin) throw Error('Open the signed page at its own authorized origin');
  const peers = createPeersClient({
    base: base.href,
    applicationId: configuration.applicationId,
    async request(path, { method = 'GET', body, signal: requestSignal } = {}) {
      const response = await fetch(new URL(path, base), {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000), ...[requestSignal].filter(Boolean)]),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok) {
        throw Object.assign(Error(value.error?.message ?? `Host request failed (${response.status})`), { code: value.error?.code, status: response.status });
      }
      return value;
    },
  });
  const wrapKey = await deviceWrapKey(device.store);
  const opened = await openPageGenesis({
    store: device.store,
    identity: device.identity,
    wrapKey,
    peers,
    applicationId: configuration.applicationId,
    imports: imports ?? configuration.imports,
    topics: topics ?? configuration.topics,
    signal,
  });
  return { ...opened, peers, wrapKey };
}

/** Start the one admission controller beside an open browser session; pass its extensions to the owner. */
export function admitBrowserSession(session, { peers, wrapKey, onEpochRotated } = {}) {
  return createAdmission(session, {
    peers,
    wrapKey,
    store: session.device.store,
    subject: 'device',
    ...(onEpochRotated ? { onEpochRotated } : {}),
  });
}
