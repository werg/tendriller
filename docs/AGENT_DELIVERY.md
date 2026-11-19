# Deliver a running connected application

When a user gives you a Tendriller domain and asks for an app, the intended result
is its **working hosted page, connected application session and verified signed
publication**. Provisioning, enrollment, publication and starting the participant
are part of that task. Source files support the result; a ZIP or local preview
alone does not establish it.

## Start provisioning early

1. Read the requested origin's `/api/service`, onboarding descriptor and
   [capability map](CAPABILITIES.md). Identify the smallest native application path.
2. Obtain the owner's verified email if it is missing. Use the supplied
   [create command](BUILD_AN_APP.md#2-create-the-application-and-let-the-owner-claim-it),
   save the private handle and give the owner the real `page_url` immediately.
3. Ask the owner to open that URL and sign in. While they do so, prepare the
   domain, UI and exact setup commands. Do not ask them to design the authority,
   invent a session module or perform implementation work that the starter supplies.
4. Continue with configuration, saved initial-generation selection, native session,
   signed publication and explicit browser enrollment. Describe each human action
   in terms of the concrete page or public device key they are approving.
5. Start the actual native participant, perform a real shared command in both
   directions, and verify reopening before calling the app complete.

If an action is blocked, preserve completed setup and name the exact missing
permission, compatible artifact or runtime capability. Distinguish **not yet
attempted** from **attempted and failed**, with the observed error. An unfamiliar
bootstrap is work to perform; it is not evidence of a platform failure or a reason
to silently switch the user's application to another stack.

## Keep the native participant alive

The starter provides a complete persistent device/session owner:

```sh
npm run peer
```

The process participates in the selected application and observes real changes.
It stays alive until stopped. Its private device store must survive future
invocations. Start it in the supported execution environment and retain enough
process information to monitor, stop and restart it. The CLI and this process
cannot simultaneously own the same native store; stop the peer before a CLI
query/publication/enrollment, then reopen it.

For an agent integration, connect the session's public application tools and
changes to the agent's actual execution loop. `createApplicationTools` and
`serveApplicationToolLines` from `@chronolog/peer-session` are the public tooling
primitives. Merely printing changes in a terminal does not make an LLM respond.

Name the process lifetime explicitly:

| Environment | Honest delivery statement |
| --- | --- |
| A process verified running during the current task | The page and native peer exchanged work during this run; identify the active process and how to resume it |
| A durable machine/service with a configured, verified process owner | Identify that owner, its restart mechanism and the persistent device location; test a restart |
| A temporary agent execution environment | State its known lifetime or that lifetime is unverified; arrange a supported persistent participant if ongoing service is required |
| Only the hosted page remains | The signed UI is available, but ongoing native coordination or agent responses still require the relevant participant |

Page residency retains hosted control and code. It does not run a native process,
retain every application's data, or prevent browser suspension. The first-app
browser has explicit reader/writer grants and relies on its native coordinator
for applied writes. Changing that availability policy requires deliberate grants
and recovery choices, not a silent identity reset.

## An existing ChatGPT conversation

A user saying “connect this app to this conversation” has asked for an additional
host integration. The ordinary Tendriller MCP endpoint administers host/control
operations; application tools execute in the owned Chronolog session. The
optional [Cloudflare assistant](CLOUDFLARE_ASSISTANT.md) adds same-origin
OAuth-protected application tools, explicit MCP Events subscriptions and a
live inbox card. Use its route table and
`describe_application` to establish the connection's capabilities.

These routes do not provide or qualify a universal ChatGPT conversation wake
adapter. OAuth ownership alone does not subscribe a conversation. Establish
whether the actual agent host supports the selected route before promising
replies after its current turn/process ends. The
[resuming-agent cookbook](https://github.com/werg/tendriller-contrib/blob/main/cookbooks/connect-resuming-agent/COOKBOOK.md)
requires a real host admission/wake mechanism and probes across turn completion.
Its historical bridge links are not an active implementation to install.

Complete the authorized app provisioning and current live exchange first. If
conversation resumption remains unavailable, report that specific remaining
boundary, the still-working page/session functionality and a concrete supported
process handoff. Do not call a generic connected socket a verified chat handoff.

## Evidence in the final handoff

Lead with the live page and its current state. Include the facts the user needs
to return to the application:

| Item | Required evidence |
| --- | --- |
| Live application | Actual page URL, application identity and owner claim status |
| Selected code | Signed publication receipt and the visible release tested |
| Connected state | A browser command observed natively and a native command observed in the browser |
| Retained work | Same-device browser reload and native reopen, with the original work still present |
| Agent/process | What is running, where, its known lifetime, and the exact resume command |
| Reuse | Which supplied session, helper and capability modules the app uses |
| Remaining boundary | Concrete unverified or blocked behavior, including conversation wake if relevant |

Supply editable source alongside this evidence when useful. Do not describe source
delivery as a deployed or connected application. The
[fresh-agent acceptance procedure](AGENT_ONBOARDING_TEST.md) scores the live result
and records whether the agent actually attempted provisioning.
