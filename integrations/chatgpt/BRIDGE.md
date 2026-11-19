# Enrolled native bridge

`bridge.mjs` adapts a real `@chronolog/peer-session/native` application session.
It is independent of Tendriller's filtered control/publication host. The caller
must authorize its account and egress consent before invoking this bridge.
The bridge additionally refreshes signed native authority through the owned
control participant and enforces explicit declared query/command allowlists.
An unavailable authority refresh fails closed; cached grants do not authorize
remote reads. This intentionally differs from a user's local offline access.

```js
import { createSessionBridge } from './bridge.mjs';
import { openSession } from './my-enrolled-application/session.mjs';

const bridge = createSessionBridge({ applications: [{
  id: applicationId, label: 'Kitchen', openSession,
  allowedQueries: ['assistanceStatus'],
  allowedCommands: ['requestAssistance', 'replyToAssistance'],
  eventTopics: ['assistant'],
  eventProjection(event, { revision }) {
    if (event.payload.type !== 'help.requested') return null;
    return { name: 'assistant.help_requested', data: {
      request_id: event.payload.requestId,
      selected_generation: revision.generation,
    } };
  },
}] });
```

`openSession({signal})` returns `{session, control}` and resumes a dedicated
enrolled device. Adapt the complete native bootstrap in
[`docs/tutorial/session.mjs`](../../docs/tutorial/session.mjs). Each bridge device
needs an explicit reader grant and, for writes, a writer grant. The current
Chronolog grant contract has no topic-limited reader: the reader can access
application history. Topic filters and projections minimize exported data;
they do not reduce that native grant. Publisher, administrator, recovery and
coordinator rights are separate and are not required by this adapter.

`createNativeSessionOpener({host,definition,devicePath,pinnedDescriptor,
openDirectConnection?})` provides that composition when those application inputs
already exist. It imports only public packages, verifies the pinned descriptor,
resumes the device, attaches the control participant and installs the maintained
peer introduction adapter. With no native RTC opener, its explicit direct failure
uses the adapter's existing encrypted WebSocket fallback. It does not create or
enroll a device, mint grants, export a signer, choose recovery or supply new epoch
keys. Keep an enrolled reader reachable for a fresh reader's key acquisition.
The optional `loadModules` dependency loader exists for exact public artifact
composition/testing; never expose module loading or paths as remote tool input.

## API

`listApplications()` reads only configured IDs/labels and opens no session.
Filter it by account and consent before returning it remotely. `getStatus(id)`
reports the real native device, session and participation status.
`describeApplication(id)` returns only allowlisted declared schemas.
`query(id,name,input)` returns the native `{revision,value}`.
`command(id,name,input,{operationId,basedOn?})` returns the saved/current native
operation state immediately; it does not imply application or retained sharing.
`operation(id,operationId)` reads that same device's retained operation state.
Use a stable caller-owned operation ID and native revision object for exact
retries. Cancellation or a lost HTTP reply never authorizes a new operation ID.
`close()` aborts owned lifetimes and closes all opened native sessions.

`readEvents(id,{cursor?,limit?})` captures and releases a native read view and
returns `{applicationId,revision,cursor,hasMore,events}`. Each projected event has
`name`, `data`, `sourceEventId`, `sourceOperationId`, `sourceAuthor`,
`sourceAttemptId` and `revision`, plus `sourceTimestampMs` when the native author
timestamp is representable. This timestamp is authenticated author metadata,
not a trusted server wall clock or proof of when a remote action completed.
Provenance is copied from the verified history,
never from the application payload. Limits bound projection and batch bytes.
An event batch can be empty while its cursor advances: the native limit counts
scanned transactions. Persist the returned cursor atomically with outbound jobs.

Generation changes invalidate a native event cursor with
`APPLICATION_VIEW_RECOVERED`. The bridge does not silently rewind or invent an
event sequence. Reconcile selected history and preserve recovery evidence before
resuming. Applied events may later be excluded by explicit recovery; external
webhook acceptance is a separate fact and is not proof of application finality.

`observe(id,{cursor?,signal?})` yields `kind: 'events'` batches with explicit pull
backpressure. Finish the atomic outbox/cursor transaction before requesting the
next batch. A native recovery yields one `kind: 'recovery'` notice with
`resetRequired: true`, then ends the iterator. Record that notice and reconcile
outbound jobs before explicitly restarting the observer. Neither a process
restart nor a recovery silently clears its checkpoint. Supply a shutdown signal
to stop a waiting observer. No extra transport or coordinator retry loop exists.

`getEvent(id,sourceEventId,{maxBatches?})` scans one coherent selected history and
returns the real permitted source event plus its current projected summary. It
returns `null` only after a complete scan; `BRIDGE_EVENT_SCAN_LIMIT` means absence
was not established within the budget. The default budget scans 4,096 native
transactions. Only an allowlisted topic with a non-null projection is exposed.
The event details contain application data and require the caller's corresponding
read/egress permission, separately from permission to send a summary.
`verifySource(id,sourceEventId,sourceRevision)` returns `selected` plus the actual
current revision, allowing an inherited event that remains in selected history.
Call it before sending/retrying a durable notification. Recovery during an
asynchronous projection is detected before returning an excluded generation.

The current application definition is immutable after provisioning. Add new
assistance declarations before configuring a new application, or use an explicit
supported evolution path. Publishing new HTML does not replace a bound domain.

Run adapter checks with `node --test integrations/chatgpt/test/bridge.test.mjs`.
These contract checks do not qualify a deployed ChatGPT subscription or OAuth
flow. Native-session integration evidence is recorded separately.

The same test file contains an opt-in real two-device native scenario. Build the
exact public session archive as described in [Build an app](../../docs/BUILD_AN_APP.md),
then set `CHRONOLOG_SESSION_PACKAGE` to its extracted package directory:

```sh
CHRONOLOG_SESSION_PACKAGE=/absolute/chronolog-source/artifacts/peer-session/package \
  node --test integrations/chatgpt/test/bridge.test.mjs
```

It exercises actual native SQLite stores, signed authority and attempts,
authenticated peer exchange, cross-device reads, exact retry, device reopen,
selected-history recovery, excluded source detection and retained ancestor
events. It uses a synthetic signed control registry and in-process framed peer
transport; it does not qualify a deployed host, Internet relay/RTC, OAuth or a
ChatGPT model run. The check is explicitly skipped when no package is supplied.
