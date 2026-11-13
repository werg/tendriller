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
