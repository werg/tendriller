import type { Env as TendrilEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends TendrilEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index");
      durableNamespaces: "Tendril";
    }
  }
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: import("cloudflare:test").D1Migration[];
  }
}
