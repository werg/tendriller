import type { RuntimeApi, PeerRuntimeApi, HostedRuntimeApi, RuntimeConfiguration } from "@tendriller/core/contract";
export type { RuntimeConfiguration } from "@tendriller/core/contract";
/** Starts protocol support and observation. It mounts no UI and requests no permissions. */
export interface RuntimeOptions {
  application?: import("@tendriller/core/application").ApplicationBackend;
  signals?: import("@tendriller/core/signals").Signals;
}
export function startRuntime(configuration: RuntimeConfiguration & { application: { kind: "peer"; id: string } }, options?: RuntimeOptions): PeerRuntimeApi;
export function startRuntime(configuration: RuntimeConfiguration & { application: { kind: "cloudflare"; id: string } }, options?: RuntimeOptions): HostedRuntimeApi;
export function startRuntime(configuration: RuntimeConfiguration, options?: RuntimeOptions): RuntimeApi;
