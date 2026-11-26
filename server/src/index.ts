// Tendriller Worker entry: routes requests; the Tendril Durable Object owns all per-tendril logic.
import type { Env } from "./env";
import { route } from "./router";
import { reconcileSuspensions } from "./abuse/reconcile";
import { reconcileBillingAndUsage } from "./billing/usage-sync";

import { Tendril } from "./tendril";
export { Tendril };
export { Admission } from "./admission";
export { AgentHub } from "./agent-hub";
// Storage revision 14 runs in fresh namespaces of the deployed Workers. Earlier
// names stay exported only so retired namespaces remain inert.
export { Tendril as TendrilS13 };
export { Admission as AdmissionS13 } from "./admission";
export { AgentHub as AgentHubS13 } from "./agent-hub";
export { Tendril as TendrilS14 };
export { Admission as AdmissionS14 } from "./admission";
export { AgentHub as AgentHubS14 } from "./agent-hub";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(req, env, ctx);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(Promise.all([reconcileSuspensions(env), reconcileBillingAndUsage(env)]));
  },
} satisfies ExportedHandler<Env>;
