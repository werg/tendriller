// STUB — voice agent replaces this.
import type { Core, Voice } from "../types";
export function createVoice(_core: Core): Voice { return { expose: () => () => {}, start: async () => {}, stop() {}, state: "unavailable", handleUtterance: async () => false }; }
