// STUB — push agent replaces this.
import type { Core, Push } from "./types";
export function setupPush(_core: Core): Push { return { available: false, subscribed: async () => false, subscribe: async () => false, unsubscribe: async () => {} }; }
