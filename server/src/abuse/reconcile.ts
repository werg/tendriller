import type { Env } from "../env";

/** Retries account suspension or restoration until each Durable Object confirms it. */
export async function reconcileSuspensions(env: Env): Promise<void> {
  const pending = await env.ACCOUNTS.prepare("SELECT tendril_id, action FROM suspension_queue ORDER BY queued_at, tendril_id LIMIT 100")
    .all<{ tendril_id: string; action: "disable" | "restore" }>();
  for (const { tendril_id: id, action } of pending.results) {
    try {
      // D1 account suspension is the admission authority; retain each page's
      // independent held state so a reversed suspension can restore active pages.
      const stub = env.TENDRIL.get(env.TENDRIL.idFromName(id));
      const response = await stub.fetch(new Request("https://tendril.internal/abuse/state", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled: action === "disable" }),
      }));
      if (!response.ok) throw new Error(`Tendril ${id} returned ${response.status}`);
      await env.ACCOUNTS.prepare("DELETE FROM suspension_queue WHERE tendril_id = ? AND action = ?").bind(id, action).run();
    } catch (error) { console.error("Suspension reconciliation will retry", id, error); }
  }
}
