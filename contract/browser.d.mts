import type { RuntimeApi } from "./index.mjs";
declare global { interface Window { tendril: RuntimeApi } }
export {};
