# Re-arm consumers after publishing or restarting

The running agent program (`tendril agent run`), an attached agent listener and a
browser view have separate lifetimes. The actual request worker and its host
conversation receiver also have independent lifetimes. Publishing a page does not start an agent, migrate a listener
to a new application, or wake an existing conversation. Include this checklist in
the application's handoff and supervisor runbook.

Apply listener-specific steps only when the application has a request consumer.
Inspect its declared commands and queries before invoking heartbeat, receipt or
answer checks. For an app without those capabilities, verify an ordinary declared
domain command/read and the participant's lifetime instead; report unavailable
consumer-liveness or receipt evidence explicitly. Do not add or change a signed
definition merely to satisfy this restart checklist.

## What survives, and what must start again

| Change | Retained evidence | Work to re-arm |
| --- | --- | --- |
| Publish a new UI for the **same application** | Application identity, enrolled device profiles, signed journal attempts/history, retained work checkpoints | Load the new page; recreate its views and signal subscriptions. A still-running compatible native owner/listener keeps its existing lifetime. |
| Reload or close a page | Its existing profile/storage and native participant remain independent of the document | The new document installs its views and subscriptions. Signals sent while it was absent are not replayed; query durable state. |
| Restart/replace the agent program using the **same workspace** | Shared signing identity, each page's journal, operation IDs, authority and retained attach binding | Restart every attach client, `watch`, `mcp-stdio` process and app-owned consumer; recreate their signal subscriptions. Attach clients do **not** reconnect automatically to the new program. The hub connection and every page owner reopen by themselves. |
| Change the browser/native package composition | Retained storage and identity | Rebuild and publish the signed UI, close old app tabs/owners, reopen the same profiles and restart listeners. A surviving SharedWorker keeps its old running code. |
| Rotate a native attachment credential | The stable binding's operation namespace and retained attempts | Read the replacement private credential and reconnect the affected clients. Revocation disconnects that binding; restart alone cannot restore revoked permission. |
| Revoke the agent, remove its page grant, or delete the page | Private page folders and checkpoints remain evidence for their **old** identity | The program closes that page (`revoked`, `closed`) and keeps running the others. Resolve access with the owner or intentionally provision a replacement page, then start its consumers. Old sockets, tokens and cursors do not carry to a new application ID. |

A UI release does not rewrite the signed application definition. Preserve the
same retained profile names and native owner directory when continuing an
existing application. Do not create a new signer, clear storage, or point an old
profile at a replacement application merely to make an attach error disappear.
Keep uncertain signed attempts and work/checkpoint files through the restart.

Peer participation may reconnect transient transports inside an existing live
session. That is different from replacing the session owner. The latter ends
its local attachments and requires a new attach (`attachPage`). Live signals are
disposable and have no retained cursor; request history and answers belong in
declared commands/queries when they must survive absence.

## After a republish or participant restart

For a UI-only publication, keep an already-running compatible native owner and
consumer alive. Reload and verify the new page as below. Perform the stop/start
and cursor-resume steps only for processes that are actually being restarted or
replaced; publishing UI code alone does not require a new owner incarnation.

1. Record the intended application ID, service origin, retained workspace
   and browser profile, signed publication and exact package composition. Determine whether
   this is a UI-only release, agent program restart or intentionally new application.
2. Stop the superseded consumer process and preserve its **handled** event cursor,
   pending operation IDs, exact inputs and durable work results. Keep evidence
   of uncertain external effects. Do not advance the checkpoint to the latest
   cursor just to make pending work disappear.
3. Start the workspace's agent program (`npm run agent`), then check `tendril
   --page <slug> self` and `doctor`. Verify the expected application, signer,
   definition and new owner incarnation. An unavailable agent program is a
   failure, not permission to open the page device under a second signer.
4. Start a new listener against that owner. Recreate app-owned signal listeners,
   event readers, query views and any local stdio MCP process. An account-linked
   assistant provider also needs its own running participant component and the
   existing approved binding; do not assume an unrelated local listener migrated.
5. Resume retained events with the last **handled** cursor and unchanged topic
   filters, or rebuild the declared inbox query. Inspect a rejected/stale cursor
   or recovery notice instead of silently starting at the end. Work can be
   delivered again after a crash; use stable request references and idempotency.
6. For a request consumer with declared liveness support, announce its new run
   after its first successful read. Bind ephemeral presence and optional lifecycle
   checkpoints to the actual worker, not its native owner or event forwarder.
   Stop presence on worker failure, and advertise only the topics that worker
   handles. Match the consumer and topic as well as peer identity in the browser;
   connectivity alone is insufficient. Report missing liveness support instead
   of inventing a command. Do not resume periodic durable heartbeats.
7. Load the intended signed UI with the retained browser profile. Verify a small
   declared domain command/read and persistence after reload. For apps with a
   request consumer and receipt/answer support, also send a real request and
   observe those facts on the originating item. Stop only the request worker
   while the native owner stays connected: its presence must become stopped/stale
   and new requests must remain awaiting acknowledgement. An unrelated worker
   must not refresh the assistant indicator. Confirm owner loss fails its watch.
8. Report which owner and consumer processes must remain running, where their
   private checkpoints live, how to restart them, and the verified publication.
   For an existing conversation, qualify the actual host admission mechanism
   with active-turn injection for Codex, then idle wake and a second request
   after the first turn ends using
   [same-conversation delivery](CONVERSATION_DELIVERY.md). A busy thread requires
   steering; a queue that waits for it to finish is not active delivery. Retain one handled
   checkpoint per page and the same private thread binding; neither an owner
   restart nor a one-shot waiter recreates that host receiver automatically.

## Native event reads and captured-view lifetime

Use `session.changes({ signal })` to learn that data may have changed, then
`await session.readView()` to capture one applied revision. Read events with
`await view.readEvents(...)` and always `await view.release()` in `finally`.
There is no session-level `readEvents()` or captured-view `close()`. Awaiting
the release works for both an in-process native session and an attached facade.

The following function runs against the selected public session API. Pass the
existing native session or `attached.session` returned by `attachPage`
(`@tendriller/tools/workspace`); it never opens a second signer. For Shared Notes use
`topics: ['note']`; for the request pattern use its unchanged declared topics.

```js
// native-event-consumer-example
export async function consumeNativeEvents(session, { topics, loadCursor, commitBatch, signal }) {
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([session.signal, stopped.signal, ...[signal].filter(Boolean)]);
  const selectedTopics = [...topics]; // Keep checkpoint scope stable for this run.
  const review = evidence => Object.assign(
    Error('Selected history changed. Review recovery and reconcile handled work before resuming.'),
    evidence,
  );
  // Stop a batch in progress as well as the next change notification.
  const offRecovery = session.onRecovery(recovery => stopped.abort(review({ recovery })));
  try {
    let cursor = await loadCursor(); // Last durably HANDLED cursor, or undefined for a deliberate first scan.
    for await (const change of session.changes({ signal: lifetime })) {
      lifetime.throwIfAborted();
      if (change.kind === 'recovery') throw review({ revision: change.revision, recovery: change.recovery });
      const view = await session.readView();
      try {
        for (;;) {
          lifetime.throwIfAborted();
          const batch = await view.readEvents({ topics: selectedTopics, limit: 64,
            ...(cursor === undefined ? {} : { cursor }) });
          lifetime.throwIfAborted();
          if (batch.hasMore && batch.cursor === cursor) throw Error('Event cursor did not advance.');
          // Application-owned local transaction: durable results/handled identities
          // and this batch.cursor commit together. Roll back on failure/cancellation.
          await commitBatch(batch, { signal: lifetime });
          lifetime.throwIfAborted();
          cursor = batch.cursor;
          if (!batch.hasMore) break;
        }
      } finally { await view.release(); }
    }
    lifetime.throwIfAborted();
    throw Error('Event observation ended. Inspect the owner before restarting this consumer.');
  } finally { offRecovery(); }
}
```

`loadCursor` and `commitBatch` are adapters to the application's existing durable
consumer store, not extra Chronolog methods. `commitBatch` must preserve stable
event/request identities and atomically save its results with the handled cursor;
it must honor the supplied signal before committing. A failed or cancelled batch
does not advance the function's cursor. If cancellation or recovery races an
already completed commit, its retained receipts and checkpoint remain evidence
for reconciliation. Do not replace these adapters with an in-memory set or a
stdout watermark. Keep this local transaction bounded; external effects require
their original provider idempotency reference and receipt reconciliation.

Changes include an initial observation and coalesce later invalidations; they
are not an event replay stream. Pagination above reads one captured revision.
A long-lived view does not update when another peer writes: release it and capture
another after the next invalidation. Ordinary errors and cancellation release
the current view; an unexpected stream end is a consumer failure. The caller
still owns its native session or attachment lifetime and closes/detaches it in
its own `finally`.

On `APPLICATION_VIEW_RECOVERED`, a recovery notification, or uncertain cursor
continuity, stop and follow [recovered-cursor review](#review-a-recovered-cursor-before-resuming).
Inspect `await session.inspectRecovery()` and the error's available evidence,
retain handled-work receipts, and resume only after a deliberate rescan and
reconciliation. Do not clear or translate a cursor automatically. For delivery
to a separate service, the public `forwardSessionEvents` helper already supplies
the bounded event-forwarding loop; its `EVENT_FORWARDER_REVIEW_RECOVERY` stop
uses the same recovery guide. Neither pattern promises exactly-once external
effects or infers continuity from a control-change label.

## Review a recovered cursor before resuming

Pairing or another control transition can select a new generation even when
the visible records appear unchanged. A generation-bound cursor can then fail
with `APPLICATION_VIEW_RECOVERED`. A live event forwarder halts with
`EVENT_FORWARDER_REVIEW_RECOVERY`; starting one with a stale checkpoint can
surface the reader's `APPLICATION_VIEW_RECOVERED` instead. Neither the CLI nor
the forwarder rewrites the cursor or silently skips to the newest event.

The error carries the current `revision` and, when verified evidence is
available, `recovery: { reason, adopted, unknownLoss }`.
`adopted` is the verified history point; `reason` can be `null` for an older
notice. The entire `recovery` can also be `null`. Missing evidence is not
proof of continuity, and `reason: 'control-change'` alone does not establish
that every previously observed event was adopted.

1. Stop work from the superseded view. Retain the old **handled** cursor, pending
   signed operations and durable effect receipts. Record the error evidence.
2. Inspect the selected revision and recovery. Rebuild the application's
   declared inbox query, or deliberately open a fresh coherent view and rescan
   its selected history using the same topic filters. Keep this rescan separate
   from claiming the old cursor translated safely.
3. Reconcile work by the application's stable request/operation references.
   Commit a new handled checkpoint only with durable results. For external
   effects, reuse the original provider idempotency reference or inspect its
   existing receipt; an uncertain result is not permission to repeat the effect.

Use the application's durable inbox/result records or an existing bounded
checkpoint/effect journal for this reconciliation. A process-local set of
every event ID is neither durable recovery evidence nor a bounded solution.
If the selected history lost work, represent that loss explicitly rather than
claiming a complete replay. Automatic cross-generation continuation requires
separate verified prefix-continuity proof and is not supplied by this recipe.

## Runnable worker and current CLI

The starter's `consumers/request-worker.mjs` attaches to an already declared
request-pattern application and runs the real handler with worker-owned presence,
durable receipt/answer inputs and a scoped handled checkpoint. Start it with
`--echo` for a harmless receipt/answer check or `--handler` for an implemented
application handler; see the [runnable consumer](AGENT_REQUESTS.md#run-a-supervised-consumer-with-a-handled-checkpoint).
`shared/helpers/agent-consumer.mjs` exposes `consumeNativeEvents` and
`openConsumerCheckpoint` for adapting the same pattern. The owner stays alive
when the worker stops. Neither this worker nor the CLI below wakes an ended
conversation without its separately established host receiver.

## Supervise the current CLI

The maintained CLI is the `tendril` binary from the selected host's exact tools
archive. Keep the agent program running separately and attach to one page with `--page`:

```sh
# Query invalidations; useful when the consumer re-reads a declared query.
npx tendril --page notes watch

# Retained event batches with an opaque cursor on every emitted batch.
npx tendril --page notes watch --events \
  --topics '["agent/request"]'

# On restart, pass the last cursor durably committed with handled work.
npx tendril --page notes watch --events \
  --topics '["agent/request"]' --cursor "$HANDLED_CURSOR"

# Or explicitly fetch one batch from that same checkpoint.
npx tendril --page notes events \
  --topics '["agent/request"]' --cursor "$HANDLED_CURSOR"

# Without --page, one combined stream covers every initialized page; its
# --cursor is a JSON object of page id to cursor.
npx tendril watch --events --cursor '{"PAGE_ID":"'"$HANDLED_CURSOR"'"}'
```

Plain `watch` preserves its coalesced change output; it is not a journal event
replay. The explicit `--events` mode reads retained batches and exposes a cursor.
A delivered cursor is an observation watermark, **not** acknowledgment of work.
Commit a handled cursor only after the related work/receipt/answer has a durable
outcome. A supervisor's last stdout line or failure diagnostic alone is not such
a checkpoint.

An unexpected stream end, lost/revoked owner or failed initial attachment exits
nonzero with its cause and available progress. The running watch's explicit
`--timeout` or SIGINT/SIGTERM ends normally after cleanup; a cleanup/output failure
remains a failure. `--timeout` is in seconds. No timeout means a long-lived watch.
See [CLI watch details](tools/CLI.md) for output and error fields.

Use a bounded supervisor restart policy, for example `Restart=on-failure` with
`RestartSec=3`, `StartLimitIntervalSec=120` and `StartLimitBurst=6` in an existing
user service. Once exhausted, surface the failure and require the real cause to
be resolved. Do not blindly retry revoked permission or a removed application.
A deliberately bounded watch (`--timeout 120`) exits successfully at its deadline;
its supervisor must schedule another invocation if continued observation was
intended. Do not combine that deadline with restart-on-failure and assume it
will stay armed forever.

The [request lifecycle pattern](AGENT_REQUESTS.md) adds durable receipts and
answers, worker-owned ephemeral presence and optional startup/stop checkpoints.
The page can verify its intended handler actually resumed without a periodic
durable heartbeat or a misleading indication from the still-connected owner.
