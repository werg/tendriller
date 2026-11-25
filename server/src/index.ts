// Tendriller Worker entry: routes requests; the Tendril Durable Object owns all per-tendril logic.
import type { Env } from "./env";
import { route } from "./router";
import { reconcileSuspensions } from "./abuse/reconcile";

import { Tendril } from "./tendril";
export { Tendril };
export { Admission } from "./admission";
export { AgentHub } from "./agent-hub";
// Storage revision 12 runs in fresh namespaces of the deployed Workers. The
// unrevisioned names stay exported only so retired namespaces remain inert.
export { Tendril as TendrilS12 };
export { Admission as AdmissionS12 } from "./admission";
export { AgentHub as AgentHubS12 } from "./agent-hub";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(req, env, ctx);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(reconcileSuspensions(env));
  },
} satisfies ExportedHandler<Env>;
