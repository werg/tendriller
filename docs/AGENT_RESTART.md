# Re-arm consumers after publishing or restarting

A running native participant, an attached agent listener and a browser view have
separate lifetimes. Publishing a page does not start an agent, migrate a listener
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
| Restart/replace the native owner process using the **same retained profile** | Signing identity, journal, operation IDs, authority and retained native bindings | Restart every attach client, `watch`, `mcp-stdio` process and app-owned consumer; recreate their signal subscriptions. Attach clients do **not** reconnect automatically to the new owner. |
| Upgrade the browser/native package composition | Retained storage and identity, when following the matching migration procedure | Upgrade both sides, publish the signed UI, close old app tabs/owners, reopen the same profiles and restart listeners. A surviving SharedWorker keeps its old running code. |
| Rotate a native attachment credential | The stable binding's operation namespace and retained attempts | Read the replacement private credential and reconnect the affected clients. Revocation disconnects that binding; restart alone cannot restore revoked permission. |
| Revoke host access or replace/delete the application | Private old profiles/checkpoints remain evidence for their **old** identity | Resolve access or intentionally provision the replacement, then enroll/start its consumers. Old sockets, tokens and cursors do not migrate to a new application ID. |

A UI release does not rewrite the signed application definition. Preserve the
same retained profile names and native owner directory when continuing an
existing application. Do not create a new signer, clear storage, or point an old
profile at a replacement application merely to make an attach error disappear.
Keep uncertain signed attempts and work/checkpoint files through the restart.
See [package migration](MIGRATION_RC16_RC17.md) for a deliberate composition or
host-storage cutover.

Peer participation may reconnect transient transports inside an existing live
session. That is different from replacing the session owner. The latter ends
its local attachments and requires a new `attachSession` call. Live signals are
disposable and have no retained cursor; request history and answers belong in
declared commands/queries when they must survive absence.

## After a republish or participant restart

1. Record the intended application ID, service origin, retained native/browser
   profile, signed publication and exact package composition. Determine whether
   this is a UI-only release, owner restart or intentionally new application.
2. Stop the superseded consumer process and preserve its **handled** event cursor,
   pending operation IDs, exact inputs and durable work results. Keep evidence
   of uncertain external effects. Do not advance the checkpoint to the latest
   cursor just to make pending work disappear.
3. Start the retained owner, then check `tendril --session ./session.mjs --mode
   attach self` and `doctor`. Verify the expected application, signer, definition
   and new owner incarnation. An unavailable owner is a failure, not permission
   to fall back to `--mode own` under a second signer.
4. Start a new listener against that owner. Recreate app-owned signal listeners,
   event readers, query views and any local stdio MCP process. An account-linked
   assistant provider also needs its own running participant component and the
   existing approved binding; do not assume an unrelated local listener migrated.
5. Resume retained events with the last **handled** cursor and unchanged topic
   filters, or rebuild the declared inbox query. Inspect a rejected/stale cursor
   or revision-bound cursor error instead of silently starting at the end. Work can be
   delivered again after a crash; use stable request references and idempotency.
6. For a request consumer with declared liveness support, announce its new run
   after its first successful read. Stop heartbeats on consumer failure. Verify
   its role, topics, start time and recent check-in; peer connectivity alone is
   insufficient. Report missing liveness support instead of inventing a command.
7. Load the intended signed UI with the retained browser profile. Verify a small
   declared domain command/read and persistence after reload. For apps with a
   request consumer and receipt/answer support, also send a real request and
   observe those facts on the originating item. Where heartbeat support exists,
   confirm a stopped listener becomes stale. Confirm owner loss fails its watch.
8. Report which owner and consumer processes must remain running, where their
   private checkpoints live, how to restart them, and the verified publication.
   Do not claim future wake of a conversation unless that host explicitly
   supports and has established it.

## Supervise the current CLI

The maintained CLI is the `tendril` binary from the selected host's exact tools
archive. Keep the owner running separately and attach:

```sh
# Query invalidations; useful when the consumer re-reads a declared query.
npx tendril --session ./session.mjs --mode attach watch

# Retained event batches with an opaque cursor on every emitted batch.
npx tendril --session ./session.mjs --mode attach watch --events \
  --topics '["agent/request"]'

# On restart, pass the last cursor durably committed with handled work.
npx tendril --session ./session.mjs --mode attach watch --events \
  --topics '["agent/request"]' --cursor "$HANDLED_CURSOR"

# Or explicitly fetch one batch from that same checkpoint.
npx tendril --session ./session.mjs --mode attach events \
  --topics '["agent/request"]' --cursor "$HANDLED_CURSOR"
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

## Retired bridge binaries (rc.8 to rc.17)

[The common-session tooling change](https://github.com/werg/tendriller/commit/ecf3851957d8089075fa95ff19c4eb3b08941363)
removed the old host event/socket bridge architecture and these eight executable
entries. Current tools ship only `tendril` and `tendril-preview`.

| Removed binary | Current route and behavioral difference |
| --- | --- |
| `tendril-wait` | `tendril --session APP --mode attach watch` for query invalidations, or `watch --events` for retained event batches. Owner failure exits nonzero; there is no old agent-socket reconnect loop. |
| `tendril-events` | `tendril ... events --cursor CURSOR`, or `watch --events`. Keep a consumer-owned handled cursor; old numeric pending/ack checkpoints and host wake probes are not compatible. |
| `tendril-watch` | `tendril ... watch` / `watch --events`. Output is the documented change/batch stream, not old count-only wake notifications. |
| `codex-bridge` | For direct tools, configure `tendril ... mcp-stdio`; for asynchronous work, run a supervised application consumer over retained events. There is no replacement that queues a model turn in an existing Codex conversation. |
| `claude-channel` | Use the public session or `tendril ... mcp-stdio` for supported direct tools, plus an explicitly supported agent host for future work. No drop-in conversation-channel/wake adapter is shipped. |
| `hermes-bridge` | Use a native consumer or the public stdio MCP interface where that agent supports it. Model process lifetime and wake belong to that host. |
| `openclaw-bridge` | Use a native consumer or the public stdio MCP interface where that agent supports it. No old bridge checkpoint/socket migration is implicit. |
| `tendril-stream` | Send disposable telemetry through the owned session's signals, and record durable observations with declared commands. The old standalone host collector/configuration is not shipped or automatically converted. |

`agent-socket.mjs` was an internal helper, not another binary. Old `TENDRIL_API`
and `TENDRIL_TOKEN` values do not configure the current application's owned
session; use its bootstrap module and retained credentials.

The rc.8 `tendril-wait` retry loop can run indefinitely and hides the reason an
upgrade failed. It has been removed, not patched in the immutable rc.8 archive.
Stop that obsolete listener, migrate the application/package composition, and
start the supported fail-fast session watch. Merely copying its old `.mjs` file
into an rc.17 installation keeps the defective old transport. Historical scripts
that must be retained as evidence should not be treated as active consumers.

The [request lifecycle pattern](AGENT_REQUESTS.md) adds durable receipts, answers
and last-seen consumer announcements so a page can verify that its intended
listener actually resumed.
