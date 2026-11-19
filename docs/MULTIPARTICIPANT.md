# Multi-participant composition

This implementation keeps one Chronolog session and operation journal per retained
signing profile. Several browser views or local tool clients attach to that owner.
Independent agents use separately enrolled profiles when they need separate rights
or revocation. A local attachment is attribution within one signer trust boundary,
not a sandbox between hostile same-origin scripts.

The optional `@tendriller/core/collaboration` module supplies application policy;
the host and browser kernel do not import it. Its immutable SQL definition records
addressed interactions, frozen contribution slots, exclusive claims, results,
cancellation, and aggregation. Schema triggers enforce the same guards for raw
signed programs as for helper-generated commands. Verified execution identifies
the actual signer and generation. Display names and caller context confer no rights.

| Identity | Meaning |
| --- | --- |
| Application / page | Shared history / hosted publication handle |
| Principal / device profile | Approved human or agent / retained local signing configuration |
| Device | Actual cryptographic signer |
| Owner instance | Current process owning that profile |
| Endpoint / incarnation | Attached client / one live attachment lifetime |
| View / draft | Local editing scope, independent of signing authority |
| Agent binding / run | Independently approved gateway caller / execution attempt |
| Interaction / slot / claim epoch | Durable request / frozen contribution / current execution fence |
| Operation / attempt | Signer-scoped semantic command / original signed bytes |
| Consumer / cursor | Independent observation progress and its generation/filter scope |

## Responsibilities and guarantees

Observation may fan out. Execution requires an addressed request or an accepted
claim. One selected-history slot has at most one accepted claim; this cannot stop
CPU work or recall an external effect already dispatched by a disconnected worker.
Every generation change invalidates active old-generation fences, including claims
in an adopted prefix. Rebinding requires an explicit guarded operation.

Closing a view cancels that view's waits, streams, and captured reads. Saved work
remains in the owner's journal. Cancelling a wait, requesting task cancellation,
and accepting cancellation are separate operations. Exact retry preserves signer,
operation, payload, and attempt; reapplication creates explicit new lineage.

Results retain their original author, run, claim, and content. Late results remain
inspectable with a superseded, cancelled, or review disposition. Fan-in counts the
frozen slots, never tabs, sockets, or observed presence. All-slots, first-accepted,
and manual synthesis are explicit policies. Partial results are visible as partial.

External effects require a durable conditional journal outside recoverable history,
a stable provider idempotency key, fresh authorization, and reconciliation. A lost
receipt is outcome-unknown. No component promises exactly-once external effects.

Addressing and filtering do not restrict history readership. Private projections
need separate grants/keys or an explicitly approved sanitized export. Camera,
microphone, focus, navigation, and speech stay under the receiving view's control.

## Version and release boundaries

Facade ABI, immutable application definition, publication, selected generation,
and gateway/export schema are independent versions. Incompatible owners reject
attachments with an upgrade action. Applications adopting the SQL collaboration
schema are created with that definition; publishing a UI does not migrate old data.

The implementation branch records source and executable qualification separately.
Local protocol/browser tests cannot establish real mobile suspension, an Internet
latency budget, or the ability to wake an ended conversation on a provider. Those
claims require the corresponding actual environment and evidence.
