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
`sourceAttemptId` and `revision`. Provenance is copied from the verified history,
never from the application payload. Limits bound projection and batch bytes.
An event batch can be empty while its cursor advances: the native limit counts
scanned transactions. Persist the returned cursor atomically with outbound jobs.

Generation changes invalidate a native event cursor with
`APPLICATION_VIEW_RECOVERED`. The bridge does not silently rewind or invent an
event sequence. Reconcile selected history and preserve recovery evidence before
resuming. Applied events may later be excluded by explicit recovery; external
webhook acceptance is a separate fact and is not proof of application finality.

The current application definition is immutable after provisioning. Add new
assistance declarations before configuring a new application, or use an explicit
supported evolution path. Publishing new HTML does not replace a bound domain.

Run adapter checks with `node --test integrations/chatgpt/test/bridge.test.mjs`.
These contract checks do not qualify a deployed ChatGPT subscription or OAuth
flow. Native-session integration evidence is recorded separately.
