import type { RuntimeApi, PublicationManifest, RuntimeArtifactFeatures } from "@tendriller/core/contract";
export interface RuntimeConfiguration {
  id: string; base: string; version: number; ws: string;
  features: RuntimeArtifactFeatures & { push: boolean; vapid: string | null; shared_by: string };
  publication?: PublicationManifest; preview?: boolean;
}
/** Starts protocol support and observation. It mounts no UI and requests no permissions. */
export function startRuntime(configuration: RuntimeConfiguration): RuntimeApi;
