---
name: connect-tendriller
description: Build or connect a Tendriller application with UI and sensor input, link the user's account, and verify real application reads and writes from ChatGPT.
---

# Build or connect a Tendriller application

Start with `tendril_guide` (`topic: "start"`). It returns the maintained setup
instructions directly, without requiring web browsing. Follow its `serviceOrigin`
for every request and link, including staging. A custom MCP connection may not
include this skill; the tool and server instructions provide the same entry path.

For a **new page/application**, read `tendril_guide` with `topic: "build"` and
`topic: "capabilities"`. Use the supplied native/browser starter, the supported
HTTP page-creation API and the existing UI/sensor helper modules. Check that your
execution environment supports Node 24, installing the exact packages, retained
private storage and the required running participant. Provision early and give
the owner the real claim URL. Use `topic: "delivery"` for completion evidence. Complete claim, authority/first generation, device
connection, signed publication and bidirectional verification. Then follow
`topic: "connect"` to expose selected app operations through MCP. If the necessary
runtime is unavailable, name that prerequisite and offer a concrete handoff to a
coding-agent/runtime with the same origin and guide. MCP alone does not host a
new app's executable participant.

For an **existing application**, call `list_tendrils`, then
`describe_application`. An empty list means no assistant-connected applications
for this account; it is not evidence of a missing plugin. For a known app, check
its account and have its existing participant propose assistant access using
`topic: "connect"`. Give the owner the returned review URL. They choose the
queries, commands and events to share; do not silently replace their app.

When account linking is requested, follow ChatGPT's sign-in prompt. The person
uses their normal GitHub or Google identity and reviews **Connect ChatGPT**.
Give one step at a time and keep credentials and authorization codes out of chat.
Ordinary calls use the OAuth-client binding; separate approved agent proofs are
for independently revocable agents, not a mandatory first step for every user.

Verify a relevant query. Execute a write when requested and verify its applied
result with a fresh read. Retain original operation IDs and inputs for uncertain
retries. If the app is offline, resume its enrolled participant from the existing
device store. Use `read_application_events` to catch up and keep its cursor.
Verify a supported subscription before promising future background delivery;
a page or mounted card does not guarantee a future wake of this conversation.

For sign-in and linking recovery, use the returned service origin's
`/docs/CHATGPT_INTEGRATION.md`. Users can revoke account access at
`/oauth/connections` or app capabilities at `/connections` on that same origin.
