import type { HostedRuntimeApi, DurableTimer, TimerDeleted, TimerMutationResult } from "../index.mjs";
declare const page: HostedRuntimeApi;

const created: TimerMutationResult<DurableTimer> = await page.timers.create({ title: "Review", due_at: 2000 });
if (created.status === "accepted") {
  const revision: number = created.value.revision;
  await page.timers.update(created.value.id, { state: "cancelled" }, { expected_revision: revision });
  const removed: TimerMutationResult<TimerDeleted> = await page.timers.remove(created.value.id, { expected_revision: revision });
  if (removed.status === "accepted") { const deleted: true = removed.value.deleted; void deleted; }
}
// @ts-expect-error an unresolved command has no accepted timer receipt.
if (created.status === "queued") created.value;
// @ts-expect-error the runtime generates and persists command IDs.
page.timers.create({ cid: "page-owned", title: "Review", due_at: 2000 });
// @ts-expect-error update requires the reviewed server revision.
page.timers.update("timer", { title: "Changed" });
// @ts-expect-error deletion also requires the reviewed server revision.
page.timers.remove("timer", {});
// @ts-expect-error revision preconditions are context, not mutable settings.
page.timers.update("timer", { expected_revision: 1 }, { expected_revision: 1 });

page.on("timer_result", result => {
  const original: string = result.command.cid;
  if (result.operation === "remove" && result.status === "accepted") {
    const receipt: TimerDeleted = result.value;
    void receipt;
  }
  if (result.operation === "update") { const revision: number = result.command.expected_revision; void revision; }
  void original;
});
page.on("timer_queue", commands => { for (const item of commands) { const queued: "queued" = item.status; void queued; } });
const pending: number = page.pendingWork().timers;
void [pending, page.timers.pending(), await page.timers.list(), await page.timers.history()];
