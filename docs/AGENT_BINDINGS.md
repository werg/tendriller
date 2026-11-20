# Independent agent bindings

An agent's host credential and its Chronolog signing profile are independent.
An agent can connect an enrolled participant without receiving host management,
publication, control administration or authority to delegate further credentials.
Application read and write authority still comes from signed Chronolog grants.

The signed-in owner's page management surface offers **Add agent**. It creates a
single-use, ten-minute enrollment code for a named binding with selected scopes.
Redeeming this code through the existing adoption endpoint is additive. Existing
agents remain authorized. **Replace all agent credentials for recovery** is a
separate, explicit action and retains the replacing recovery semantics.

An agent with `agents:delegate` can use `POST <api>/tokens` with a unique `name`
and `scopes`. The selected scopes must be a subset of that agent's own scopes.
There are at most 32 host bindings per tendril. Available scopes are:

| Scope | Host operations |
| --- | --- |
| `host:read` | Page metadata, discovery guides and application identity |
| `host:manage` | Page lifecycle, guest links and host settings |
| `participants:connect` | Authenticated participant transport and routing |
| `control:write` | Signed control configuration and generation actions |
| `publication:write` | Signed code publication |
| `assistant:manage` | Propose application exports for owner approval |
| `agents:delegate` | Add, inspect and revoke credentials within the caller's authority |

`GET <api>/self` reports the actual host binding and its scope. The binding ID
survives `POST <api>/tokens/<name>/rotate`; the previous credential immediately
stops authenticating and the binding revision advances. A credential can rotate
itself. Rotating or revoking another binding requires delegation authority covering
all of that binding's scopes. `DELETE <api>/tokens/<name>` removes only that agent.

Names are display and local management labels. A new binding reusing a revoked
name gets a new identity. Never put host credentials in authored page assets,
operation context, logs or exported events. Browser endpoint attribution does not
create independent signing authority; use separately enrolled profiles for that.

Capacity belongs to the delegating account, while route ownership retains the
exact credential incarnation. All named agents and the signed-in human owner
share that account's eight discovery advertisements, eight invitation listeners
and eight relay sessions. Pending rendezvous are limited to sixteen endpoints
per account within the application-wide thirty-two endpoint budget. Participant
HTTP work admits at most two requests per account within the four-request page
budget. Unclaimed pages use a page-scoped budget until an owner claims them.
Adding or rotating tokens cannot multiply these limits. Revoking a binding still
withdraws only its own advertisements and sockets; sibling routes remain usable.

For several processes using one retained native signer, the optional
`@tendriller/core/collaboration/native` supervisor provides separate authenticated
attachment credentials and narrower command/query policies. See
[the CLI guide](tools/CLI.md) for explicit attachment, ownership, independent
profiles, credential rotation and retained provider effect receipts.
