import { BridgeError } from './bridge.mjs';

/** Resume an explicitly enrolled native device with the maintained transports. */
export function createNativeSessionOpener({ host, definition, devicePath, pinnedDescriptor,
  openDirectConnection = async () => { throw new BridgeError('BRIDGE_NATIVE_RTC_NOT_CONFIGURED'); },
  loadModules = async () => {
    const [peer, native, websocket, peers] = await Promise.all([
      import('@chronolog/peer-session'), import('@chronolog/peer-session/native'),
      import('@chronolog/peer-session/websocket'), import('@tendriller/core/peers'),
    ]);
    return { peer, native, websocket, peers };
  } } = {}) {
  if (typeof devicePath !== 'string' || !devicePath || devicePath.length > 4096) throw new BridgeError('BRIDGE_INPUT_INVALID', 'Invalid existing native device path');
  if (!host?.peers || typeof host.peers.application !== 'function' || typeof host.peers.exchange !== 'function'
    || !definition || !pinnedDescriptor || typeof openDirectConnection !== 'function' || typeof loadModules !== 'function') {
    throw new BridgeError('BRIDGE_CONFIGURATION_INVALID', 'Native bootstrap requires a configured host, definition, pinned descriptor and existing enrolled device');
  }
  const pinned = structuredClone(pinnedDescriptor);
  return async function openSession({ signal } = {}) {
    signal?.throwIfAborted();
    const { peer, native, websocket, peers } = await loadModules();
    const authority = await host.peers.application({ signal });
    await peer.verifyAuthorityBundle(authority, pinned);
    signal?.throwIfAborted();
    // No create:true, exported browser signer, plaintext epoch key or fallback
    // identity. Explicit enrollment and first key acquisition happen separately.
    const device = await native.openNativeDevice({ path: devicePath });
    let session;
    try {
      session = await native.openNativeApplication({ device, definition, authority });
      const control = session.connectControlParticipant({ exchange: (message, options) => host.peers.exchange(message, options) });
      await session.participate({ control, ...peers.createPeerIntroductions({ peers: host.peers, identity: session.deviceId,
        openDirectConnection,
        openRelayConnection: ({ relay, signal }) => websocket.openWebSocketConnection(relay, { ready: relay.ready, signal }),
      }) });
      signal?.throwIfAborted();
      return { session, control };
    } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
  };
}
