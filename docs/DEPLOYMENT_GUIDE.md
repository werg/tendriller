# Deploy the agent program

Choose a host that can keep the workspace's one long-running program,
`tendril agent run` (`npm run agent` in a first-app workspace), and its private `.tendriller/` folder (agent credential,
shared signer and every page's device store).
The host's page and `/mcp` endpoint do not replace that program or wake a
terminated agent conversation. Prepare and publish the app through the selected
service's [build guide](BUILD_AN_APP.md), then verify a real command and a read
from its other participant before reporting it available.

| Host | Actual lifetime | Durable state |
| --- | --- | --- |
| Existing cloud computer or foreground Node process | Until the process or computer stops | Workspace `.tendriller/` on retained private disk |
| Turn-scoped sandbox | Only the current execution window; no future wake is implied | Retained private workspace or an explicitly verified device checkpoint |
| Browser participant | While the supported browser owns the participant; closing it ends availability | That browser's IndexedDB/OPFS, subject to browser storage policy |
| Linux systemd or macOS launchd | While the machine and configured service/user session run | Service-user-owned workspace `.tendriller/` |
| Windows logon task | While the registered user is logged on and the task runs | That user's private workspace `.tendriller/` |
| Container | While its orchestrator runs it | Volume mounted at `/app/.tendriller` |

A remote MCP client still needs a running authorized agent program.
The [request adapter](SERVERLESS_HOST.md) in `@tendriller/core/serverless` is an application integration
primitive; it does not automatically turn an ordinary starter into an on-demand
Chronolog participant. Do not describe a template as qualifying such a deployment.

## Start and stop the same program

Every template runs the same command, `tendril agent run`, from the workspace
root: one process, one hub connection and one session per initialized page. The
immutable first-app kit selected by that service's build guide and the
[source-only starter download](../downloads/tendriller-first-app.tgz)
include the `deploy/` directory beside `tendriller.json`. Retain that directory
when extracting the kit. For an existing workspace, copy `deploy/` from the
selected qualified kit into its root; no separate repository checkout is
required. Those files are packaged directly from the maintained root `deploy/`
sources, without a second maintained copy. Install the workspace's exact
dependencies, register its agent and initialize at least one page first. Use
**Node 24 or newer** for the starter, even though some portable Core modules
support Node 22. Do not infer native/SQL compatibility from that lower package
minimum.

Run from the workspace directory:

```sh
npm run agent        # tendril agent run
```

A page initialized while the program runs is opened without a restart. A
separate optional assistant adapter is part of a page owner inside this program;
starting a second signer against the same page store is not a deployment method.

SIGINT/SIGTERM requests cancellation and awaits each page owner's cleanup, then
closes the hub connection and the attach socket. A cleanup or output-flush failure
exits nonzero. It does not claim that in-flight operations committed: preserve
their original IDs, signed attempts and device stores, then inspect uncertain
outcomes after reopening. Machine loss, forced container kill and Windows task
termination can interrupt cleanup. Resume the same private workspace; never
rerun initialization merely because the process stopped.

## Linux and macOS

Edit the absolute Node/workspace paths in
`deploy/tendriller.service` or
`deploy/dev.tendriller.agent.plist`.
Verify the selected Node binary's version. Create the dedicated service user and
private `.tendriller` directory before installing the unit; systemd's writable
path must exist and contain the retained agent credential, signer and page stores. Do not put credentials in
unit arguments. The systemd template permits writes only in that state directory;
applications needing other persistent paths must declare them explicitly.

Use the appropriate administrator or per-user service manager to install and
start the unit. Verify the actual process and cross-device round trip after
startup. The systemd unit restarts on failure, and the launchd template restarts
unsuccessful exits. They do not guarantee availability while the host is asleep
or offline. Stop the unit before deliberately starting another owner manually.

## Windows

`deploy/install-windows-task.ps1` registers a
**current-user logon task**, not a Windows Service. `node.exe` does not implement
the Service Control Manager protocol and must not be passed directly to
`New-Service`. The task stores no account password, uses limited privileges,
refuses to overwrite an existing task, and disallows overlapping task instances.
It runs only in that user's logged-on session; it is not an unattended boot
service. A true SCM service requires a separately installed and qualified service
wrapper.

```powershell
.\deploy\install-windows-task.ps1 -AppDirectory 'C:\Apps\My application' -WhatIf
.\deploy\install-windows-task.ps1 -AppDirectory 'C:\Apps\My application'
Start-ScheduledTask -TaskName TendrillerAgent
Get-ScheduledTaskInfo -TaskName TendrillerAgent
```

Run the foreground Node command first to inspect startup errors. Task Scheduler
history and process status alone do not prove application connectivity. Use the
application's public query and the paired browser for that check. A scheduler
stop/logoff may forcibly terminate Node; it is not proof of a graceful flush.
The task can be removed with `Unregister-ScheduledTask` after stopping it, without
deleting the workspace or state.

## Container

The `deploy/Dockerfile` uses Node 24 on Debian, a non-root user,
and the workspace's locked runtime dependencies (`npm ci --ignore-scripts`).
Both event/JSON topics and SQLite-CAS (`chronolog/sql` via `sqlite-cas.wasm`)
run with zero native C/C++ builds on Node 22+ built-in `node:sqlite`.

Use the matching `deploy/Dockerfile.dockerignore`
when building from the workspace root. It excludes the standard private store,
checkpoint files, environment secrets, Git data and local dependencies. Review
the authored context for any additional private paths before building. Never
bake signing keys or initialized device state into an image.

```sh
docker build -f deploy/Dockerfile -t my-tendriller-app .
docker run --name my-tendriller-app --memory=1g --memory-swap=1g --cpus=1 \
  --mount type=bind,src=/absolute/private/app-state,dst=/app/.tendriller \
  --stop-timeout=15 my-tendriller-app
```

The host state directory must already contain the prepared workspace's private
records (agent credential, signer and page stores) and be accessible only to the container's service user (the image's
`node` user, normally UID/GID 1000). Keep it out of the build context. A read-only
or incorrectly owned mount is a startup error. The workspace keeps its state in
`.tendriller/` beside `tendriller.json`, so mounting `/data/.tendriller` would not
retain this starter's actual stores. No inbound port is required by this template. Resource limits are
an explicit host budget, not a memory or Internet-connectivity qualification.

## Verify the deployment and retain evidence

Record the exact source/package hashes, actual Node version, executable command,
process/service identity, private workspace location and resume command. Prove an
applied command observed from the other participant and persistence after process
restart. Report which process must remain running. Unit syntax tests and a mocked
launcher prove only template wiring and shutdown behavior; actual Linux, macOS,
Windows, container, OAuth and remote transport deployments require their own
recorded runs. Never label configured CI or an unexecuted template as a passed
platform qualification.

## Supervise request workers and conversation receivers separately

The workspace's native owner keeps application sessions alive. An actual
request worker and a Codex/ChatGPT conversation receiver each need their own
verified lifetime, restart policy and private retained state. Use the
[runnable request worker](AGENT_REQUESTS.md#run-a-supervised-consumer-with-a-handled-checkpoint)
for worker-owned ephemeral presence, exact receipt/answer retries and a handled
checkpoint. Stop only that worker and verify the assistant becomes stopped/stale
while the native owner stays connected.

For requests to the same existing conversation after a turn ends, use
[same-conversation delivery](CONVERSATION_DELIVERY.md). The supplied multi-page
Codex receiver targets an exact thread through an explicitly selected daemon.
It steers a running turn and uses queue/resume while idle or unloaded. Plain
`codex queue` waits while a turn runs, so deploying only that command does not
satisfy active injection. Steer/queue admission still requires observed handling
and durable-answer qualification in the intended thread.
Keep uncertain admission/effect records and stop for reconciliation rather than
allowing a supervisor to repeat them. A one-shot waiter that exits normally
requires explicit re-arming; `Restart=on-failure` alone does not keep it armed.
