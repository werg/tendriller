import type { RuntimeApi, RuntimeConfiguration } from "@tendriller/core/contract";
export type { RuntimeConfiguration } from "@tendriller/core/contract";
/** Starts protocol support and observation. It mounts no UI and requests no permissions. */
export function startRuntime(configuration: RuntimeConfiguration, options?: { application?: import("@tendriller/core/application").ApplicationBackend }): RuntimeApi;
