// Tendriller Worker entry: routes requests; the Tendril Durable Object owns all per-tendril logic.
import type { Env } from "./env";
import { route } from "./router";

export { Tendril } from "./tendril";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return route(req, env);
  },
} satisfies ExportedHandler<Env>;
