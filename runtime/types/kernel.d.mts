import type { RuntimeApi, RuntimeConfiguration } from "@tendriller/core/contract";
export type { RuntimeConfiguration } from "@tendriller/core/contract";
/** One installed application backend and its live signals. Starts no transport or permissions. */
export interface RuntimeOptions {
  application?: import("@tendriller/core/application").ApplicationBackend;
  signals?: import("@tendriller/core/signals").Signals;
}
export function startRuntime(configuration: RuntimeConfiguration, options?: RuntimeOptions): RuntimeApi;
