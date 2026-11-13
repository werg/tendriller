// Provider registry, keyed by the `provider` field the server returns from
// POST P_tendril/voice/session. Add a provider by implementing RealtimeProvider and
// registering it here.
import type { RealtimeProvider } from "./types";
import { openaiRealtime } from "./openai-realtime";

const providers = new Map<string, RealtimeProvider>([[openaiRealtime.name, openaiRealtime]]);

export function registerProvider(p: RealtimeProvider): void { providers.set(p.name, p); }
export function getProvider(name: string): RealtimeProvider | undefined { return providers.get(name); }
export type * from "./types";
