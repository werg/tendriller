// Tendriller Worker entry: routes requests; the Tendril Durable Object owns all per-tendril logic.
import type { Env } from "./env";
import { route } from "./router";
import { abuseEmail } from "./abuse/mail";
import { reconcileSuspensions } from "./abuse/reconcile";

export { Tendril } from "./tendril";
export { Admission } from "./admission";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return route(req, env);
  },
  email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    return abuseEmail(message, env);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(reconcileSuspensions(env));
  },
} satisfies ExportedHandler<Env>;
