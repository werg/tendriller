# Bounded collaboration reads

The immutable journal is the source of admitted task and conversation facts. Reads
project current task state and page historical evidence separately, so a long
conversation or repeated claim handoffs cannot make task inspection unusable.
The existing admission triggers, signed-attempt references and command version
checks apply unchanged.

## Public queries

Every query is part of `createCollaborationDefinition()` and is available through
`session.query(name, input)`. Its normal outer response is `{revision, value}`.

| Query | Input | Value |
| --- | --- | --- |
| `collab.tasks` | Optional `creator`, `eligibleSigner`, `state`, `limit`, `cursor` | `tasks`, current `claims`, `acceptedResults` summaries, `page` |
| `collab.results` | Optional `taskId`, `slotId`, `disposition`, `limit`, `cursor` | Full result evidence and `page` |
| `collab.thread` | Required `threadId`; optional `limit`, `cursor` | Messages from that thread and `page` |
| `collab.messages` | Optional `threadId`, `limit`, `cursor` | Messages and `page` |
| `collab.task` | `taskId` | Current `task`, `claims`, `acceptedResults`, an initial `results` page and `resultsPage` |
| `collab.interaction` | `interactionId` | The same task inspection under its original interaction identity |
| `collab.snapshot` | `null` | Bounded previews of tasks, claims, results and messages, with `pages.tasks`, `pages.results`, `pages.messages` |

`state` is `all`, `open` or `closed`. A task is closed for this filter when a cancel
or finalize fact exists. An accepted contribution can still await explicit parent
finalization. `eligibleSigner` selects frozen eligible recipients and current
claimants or handoff assignees, including a new assignee outside the original set.
Discovery is an observation; only the guarded claim command can admit execution.

Accepted-result summaries contain every accepted slot's full result identity,
claim fence, disposition, outcome and verified operation reference, without its
content. This allows a current card or reviewer to recognize completed work even
when the initial historical evidence page does not contain that result. Read full
content and all late, superseded, cancelled or review-required evidence through
`collab.results`; no result is deleted or reclassified by pagination.

Task inspection selects the request, terminal control facts, latest claim/handoff
per slot, that claim's acknowledgement, and accepted-result references. Old claims
and conversation messages do not enter this projection. `task.version` still counts
**every admitted row for that task**, including its historical claims and messages,
so an expected-version command retains its original concurrency guard.

## Continuation and captured readers

Every page includes:

```js
{
  nextCursor: null, // Opaque string when another page exists.
  hasMore: false,
  total: 0,        // All matching records in this captured view.
  returned: 0,
  limit: 16,
  revision: {}     // The complete captured PeerRevision.
}
```

Pages use ascending immutable journal sequence and keyset continuation. A cursor
binds the query, filters, application, history, generation and complete captured
revision. Changing any of those produces `CURSOR_RESET_REQUIRED`; it does not
silently skip to a different history. The requested limit can change between
pages. Cursors are read positions, not execution capabilities or provenance proofs.

A normal `session.query()` captures a fresh view for each call. Use the maintained
`captureCollaborationReader(session)` helper, or `client.capture()`, when a list
must finish paging while other participants continue writing:

```js
const reader = await client.capture();
try {
  let cursor;
  do {
    const options = { state: 'open', eligibleSigner: session.deviceId, limit: 8 };
    if (cursor) options.cursor = cursor;
    const { value } = await reader.tasks(options);
    renderTaskPage(value.tasks, value.claims, value.acceptedResults);
    cursor = value.page.nextCursor;
  } while (cursor);
} finally {
  await reader.close();
}
```

The reader owns one public captured view. It supports native and attached Worker
sessions without consumer SQL or copied definition internals. Close it when the
view is no longer displayed or before refreshing to a new revision. Recovery or
loss of that attachment can invalidate it; capture a new reader and explicitly
restart the displayed query. Do not retain one captured reader per historical page.

`reader.inspect(taskId)` exposes the initial result page. Continue it on that same
reader using `reader.results({taskId, cursor: value.resultsPage.nextCursor})`.
Thread continuations stay scoped to `reader.thread({threadId, cursor})` and cannot
be reused for the all-thread `messages` query.

## Bounds and authority

Task pages default to eight tasks and permit at most 32. Evidence pages default
to 16 results or 20 messages and permit at most 64. Current-task groups have a
384 KiB data budget; result and message pages each have a 128 KiB data budget.
A page may contain fewer records than its requested limit and still have more.
The continuation always starts after its last included record. Inner raw SQL reads
fetch at most eight journal records at a time, so a captured Worker view does not
first construct an oversized transport response before applying the outer budget.

Pages also account for the facade's structured-clone costs: primitive values,
UTF-8 property names and array indexes count even when their JSON representation
is short. Task pages reserve at most 28,000 nodes and 512 KiB under that accounting;
each evidence page reserves 14,000 nodes and 192 KiB. The three snapshot sections
together leave 9,536 nodes and 128 KiB for cursors, revisions and the outer response
within the owner's 65,536-node / 1 MiB frame. Dense legal arrays therefore shorten
a page without losing its next item or making a named query fail at transport.
Individual task inspection uses the same task budget plus one evidence page.

The legacy snapshot is an explicitly incomplete preview when any subsection has
`hasMore: true`. Its three continuations lead to `tasks`, `results` and `messages`
respectively. A growing journal no longer fails at an arbitrary 10,000-row total.
Applications should use the task and thread queries for their displayed scopes.

Captured-reader creation probes its raw-query authority and releases the captured
view immediately if access is denied. An events-only attachment cannot issue SQL.
An attachment restricted to approved named queries cannot turn a captured view
into unrestricted SQL; use its approved named queries instead. An unrestricted
query-only attachment can capture SQL without receiving the separate events grant.
Releasing a view remains permitted cleanup after any read denial.

## Raw-program admission and readable history

The SQL schema enforces the payload shape required by the public projections,
including for a writer submitting a raw change program. JSON-bearing fields are
encoded JSON strings with their declared byte bounds; an object-valued `input`,
`content` or `source` cannot be admitted and later break `JSON.parse` during a read.
The row envelope and each decoded JSON document allow at most 4,096 nodes and 24
nested levels, matching command preparation, and reject nonfinite numeric atoms.
Required projected fields also retain their declared scalar types and bounds.

Duplicate object keys are rejected at every depth because SQLite and JavaScript
otherwise select different occurrences. Validation uses decoded key identities
and actual tree-parent relationships, so punctuation within a legitimate key does
not create false nesting. Every encoded document has its own unique validation
identity, including when the surrounding invalid envelope repeats a field.
Failures report `collab_json_fields`, `collab_json_structure` or `collab_envelope`
through the deterministic assertion outcome. The malformed attempt cannot add a
row, change a current claim or poison another participant's next read.
