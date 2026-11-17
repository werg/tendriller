import type { RuntimeApi, PeerRuntimeApi, HostedRuntimeApi, HostServices } from '../index.mjs';

declare const runtime: RuntimeApi;
const host: HostServices = runtime.host;
void host.peers.discover();
runtime.on('sensors', status => { const active: string[] = status.active; void active; });
runtime.on('application_ready', () => {});
if (runtime.kind === 'cloudflare') {
  const hosted: HostedRuntimeApi = runtime;
  void hosted.state.apply([]);
  hosted.on('state_result', result => { const id: string = result.cid; void id; });
  const connected: boolean = hosted.connected;
  void connected;
} else {
  const peer: PeerRuntimeApi = runtime;
  void peer.application.ready();
  void peer.signals.ready();
  const name: string = peer.device.name;
  // @ts-expect-error A peer session owns its actual connection and replication state.
  peer.connected;
  // @ts-expect-error There is no hosted outbox on a peer runtime.
  peer.pendingWork();
  // @ts-expect-error Hosted state is absent rather than a throw-only adapter.
  peer.state;
  // @ts-expect-error Device labels do not imply application or account authority.
  peer.device.role;
  // @ts-expect-error Peer runtime events do not invent a hosted data subscription.
  peer.on('state_result', () => {});
  // @ts-expect-error Hosted health deferral has no role in a local peer UI.
  peer.ready.manual();
  void name;
}
// @ts-expect-error The explicit host group has no top-level compatibility alias.
runtime.peers;
// @ts-expect-error Select the hosted capability before invoking hosted application methods.
runtime.send({ value: 1 });
