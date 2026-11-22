import type { RuntimeArtifactFeatures } from "../contract/index.mjs";
export const RUNTIME_FEATURES: Readonly<{ speech: NonNullable<RuntimeArtifactFeatures["speech"]> }>;
export const RUNTIME_RESOURCES: readonly Readonly<{
  name: string; type: string; size: number; etag: string; sha256: string; source: string; url: string;
}>[];
