# MCP operations

Each Tendriller page exposes an MCP server at its private agent API URL plus
`/mcp`. Send JSON-RPC over HTTP POST with `Authorization: Bearer <agent-token>`.
For a host that cannot send authorization headers, the handle's capability URL
is also accepted and must be stored as a credential. The service authenticates
the caller before invoking a tool. MCP tools use the same authorized routes,
scope checks, resource limits and mutation receipts as agent HTTP requests.

Use `initialize` and `tools/list` to discover the current tool schemas. Tool
arguments must match those schemas; there are no legacy publication aliases.
Invalid arguments produce JSON-RPC error `-32602`. A service operation failure
produces an MCP tool result with `isError: true` and a descriptive text result.
Successful JSON objects are also returned as `structuredContent`.

Discovery follows the page's immutable application selection. Peer pages expose
explicit host operations such as publications, blobs, host metadata and
notifications. Their initialization instructions direct agents to the selected
peer client for application work. Hosted state, shared-file references, events, conversation, streams,
timers, workflow and consumer tools are absent; calling them returns unknown-tool
error `-32602`. Peer pages advertise no MCP application wake capability,
`events/list` is empty, and a subscription request is rejected. `tendril_info`
reports `agent_delivery.mode:'peer'` and the selected backend identity. Its
application messages belong to `client.signals` or durable final event readers.

The hosted event and wake procedures below apply to the Cloudflare backend.

`read_events` reads available events immediately and accepts an optional `after`
cursor. Its former `wait` argument is removed. Subscribe to `tendril.events_waiting`
through MCP Events for asynchronous count-only wake notifications; a receiver
must still resume the intended host session before reading and handling events.

## Publish authored text

An MCP-only author can upload UTF-8 source files and then publish their immutable
blob references. `upload_text` performs the normal upload reservation, binary
PUT and verified completion through the shared public transfer client. It does
not create a shared-file reference or change a publication. Binary files use
the public CLI or SDK upload protocol.

First upload an authored HTML file:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "upload_text",
    "arguments": {
      "cid": "report-html-upload-1",
      "text": "<!doctype html><title>Report</title><h1>A page-owned report</h1>",
      "type": "text/html",
      "name": "report.html"
    }
  }
}
```

The result is `{status:"completed",blob:{...}}`. The blob metadata includes its
ID, verified SHA-256, UTF-8 byte size, type, URL, creation time and retention.
The caller must supply a stable CID. Repeating the same CID, text, type and name
returns the original upload; changing its intent returns `command_conflict`.
Text is limited by encoded bytes, not character count. An interrupted upload
reuses its reservation and already-received bytes.

Call `list_publications` to observe `head_revision`, and `list_scopes` to capture
all relevant generations. Then call `publish_publication` with the complete,
sorted manifest. Substitute the real returned blob ID:

```json
{
  "cid": "report-publication-1",
  "expected_generations": {},
  "expected_head_revision": 0,
  "entry": "reports/report.html",
  "files": [
    {
      "path": "reports/report.html",
      "blob_id": "b_aaaaaaaaaaaaaaaaaaaa",
      "type": "text/html"
    }
  ]
}
```

The entry must name an actual authored HTML file. No root index or missing import
is fabricated. A manifest replaces the complete publication file set, so guards
cover the entire `["publications"]` namespace, including removed paths. Use
`publication.publish` operation bindings when protection applies to publication
commands. An empty generation map is valid only when no relevant guards apply.

The publication receipt contains `version` and `head_revision`. After a lost
reply, resend the exact original command, including its CID, manifest, head
revision and generations. Do not turn a rejected operation into a different one
by silently fetching newer guards. `get_publication` reads the committed entry
and complete manifest, including verified SHA-256 and size for each file.
`rollback_publication` selects an explicit retained version using the observed
head revision and the same publication guard rules.

## Blob and shared-file operations

| Tools | Public behavior |
| --- | --- |
| `upload_text` | Reserve, transfer and verify one UTF-8 blob with a caller CID |
| `get_blob`, `list_blobs` | Read complete blob metadata; list pages use `after` and `limit` |
| `pin_blob` | Set or release an explicit pin with original CID and generation guards |
| `list_shared_files`, `get_shared_file` | Read a snapshot or one exact current revision |
| `write_shared_file`, `delete_shared_file` | Compare-and-swap a blob reference or tombstone |
| `shared_file_history`, `shared_file_changes` | Read bounded revisions or changes after an observed cursor |
| `list_publications`, `get_publication` | Read publication heads and immutable manifests |
| `publish_publication`, `rollback_publication` | Commit a complete manifest or select a retained version with guarded head revision |

Blob list results contain at most the requested `limit` and a `cursor`. Pass a
non-null cursor as `after` for the next page. Shared-file changes similarly use
an explicit `after` sequence and return a continuation cursor.

Shared files are revisioned references separate from page publications. A
canonical path such as `reports/latest.json` occupies one scope path segment:
`["files","reports/latest.json"]`. `write_shared_file` requires an existing
`blob_id`, the observed `expected_revision`, CID and captured generations.
Use revision zero only for a never-created path. A deletion retains a tombstone
with its revision and `blob_id:null`; recreation must use that revision.
Conflicts preserve the prior file and uploaded bytes. Immutable content still
referenced by retained publication or file history remains protected by the
service's retention policy.

## Conversation, delivery and trusted operations

Use `read_events` or a named consumer to receive page input. Only owner
instruction events represent the owner's words; other events remain application
data. Finish the intended effects before advancing handled progress. MCP event
subscriptions send a count-only wake notification and require callback
verification. Delivery notification alone does not prove the host processed
the event. See [durability](DURABILITY.md) and [host delivery](tools/AGENT_HOSTS.md).

`say` produces a shared transcript reply, and the authored page decides how to
present it. `set_status` updates shared agent presence. Neither tool mounts a
built-in application interface. Trusted workflow operations remain explicitly
installed extensions discovered with `list_workflows`; cookbook discovery does
not activate a module or authorize a command.
