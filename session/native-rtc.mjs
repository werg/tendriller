// Node-only factory. Discovery, direct-first policy and fallback remain shared.
import { createNativePeerConnection } from '@chronolog/peer-session/webrtc-native';
import { openWebRtcConnection } from '@chronolog/peer-session/webrtc';
import { participateApplication } from './participation.mjs';

export function participateNativeApplication(session, { native, ...options }) {
  return participateApplication(session, { ...options,
    openDirectConnection: connection => openWebRtcConnection({ ...connection,
      createPeerConnection: configuration => createNativePeerConnection(configuration, native),
    }),
  });
}
