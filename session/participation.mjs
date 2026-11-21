import { createPeerIntroductions } from '../contract/introductions.mjs';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';

import { PEER_TRANSPORT_POLICY } from '../contract/transport-policy.mjs';
export { PEER_TRANSPORT_POLICY };

/** Platform adapters supply only RTC mechanics. The owned session controls
 * discovery, authentication, connection budgets, fallback and recovery. */
export function participateApplication(session, { peers, control, openDirectConnection,
  configuration = PEER_TRANSPORT_POLICY.configuration,
  directTimeoutMs = PEER_TRANSPORT_POLICY.directTimeoutMs, connections, recovery, onTransport } = {}) {
  if (typeof session?.participate !== 'function' || typeof openDirectConnection !== 'function')
    throw Object.assign(Error('Use the native participant or browser-owner RTC adapter.'), { code: 'PEER_TRANSPORT_REQUIRED' });
  if (onTransport !== undefined && typeof onTransport !== 'function') throw TypeError('onTransport must be a function');
  const adapter = createPeerIntroductions({ peers, identity: session.deviceId, directTimeoutMs,
    openDirectConnection: options => openDirectConnection({ ...options, configuration, timeoutMs: directTimeoutMs }),
    openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
    ...(onTransport ? { onTransport } : {}),
  });
  return session.participate({ control, ...adapter,
    ...(connections ? { connections } : {}), ...(recovery ? { recovery } : {}),
  });
}
