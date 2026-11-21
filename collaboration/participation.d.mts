import type { ApplicationSession, ApplicationParticipation, ApplicationParticipationOptions, FramedPeerConnection } from '@chronolog/peer-session';
import type { PeersClient, PeerRendezvous } from '../contract/peers.mjs';
export { PEER_TRANSPORT_POLICY } from '../contract/transport-policy.mjs';
export interface ApplicationTransportOptions {
  peers: PeersClient;
  control: ApplicationParticipationOptions['control'];
  openDirectConnection:(options:{role:'offerer'|'answerer';signaling:PeerRendezvous;signal:AbortSignal;configuration:RTCConfiguration;timeoutMs:number})=>Promise<FramedPeerConnection>;
  configuration?:RTCConfiguration;
  directTimeoutMs?:number;
  connections?:ApplicationParticipationOptions['connections'];
  recovery?:ApplicationParticipationOptions['recovery'];
  /** Raw transport selection, before session peer authentication completes. No payloads or addresses. */
  onTransport?:(event:Readonly<{peerId:string;kind:'direct'|'relay';reason?:'direct_failed'|'direct_timeout'}>)=>void;
}
export declare function participateApplication(session:Pick<ApplicationSession,'deviceId'|'participate'>,options:ApplicationTransportOptions):ApplicationParticipation;
