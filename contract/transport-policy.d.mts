/** Frozen shipping defaults; STUN discovers addresses and carries no application data. */
export declare const PEER_TRANSPORT_POLICY: Readonly<{
  directTimeoutMs: 5000;
  configuration: Readonly<RTCConfiguration>;
}>;

/** Merge host-minted TURN iceServers with the canonical STUN default. */
export declare function mergeIceServers(hostIceServers?: readonly RTCIceServer[] | null): RTCIceServer[];
