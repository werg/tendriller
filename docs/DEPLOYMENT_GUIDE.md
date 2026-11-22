# Deploy a retained application participant

Choose a host that can keep the application process and its private device store.
The host's page and `/mcp` endpoint do not replace that participant or wake a
terminated agent conversation. Prepare and publish the app through the selected
service's [build guide](BUILD_AN_APP.md), then verify a real command and a read
from its other participant before reporting it available.

| Host | Actual lifetime | Durable state |
| --- | --- | --- |
| Existing cloud computer or foreground Node process | Until the process or computer stops | Project `.tendriller/` on retained private disk |
| Turn-scoped sandbox | Only the current execution window; no future wake is implied | Retained private project or an explicitly verified device checkpoint |
| Browser participant | While the supported browser owns the participant; closing it ends availability | That browser's IndexedDB/OPFS, subject to browser storage policy |
| Linux systemd or macOS launchd | While the machine and configured service/user session run | Service-user-owned project `.tendriller/` |
| Windows logon task | While the registered user is logged on and the task runs | That user's private project `.tendriller/` |
| Container | While its orchestrator runs it | Volume mounted at `/app/.tendriller` |

A remote MCP client still needs a running authorized application participant.
The [request adapter](SERVERLESS_HOST.md) in `@tendriller/core/serverless` is an application integration
primitive; it does not automatically turn an ordinary starter into an on-demand
Chronolog participant. Do not describe a template as qualifying such a deployment.

## Start and stop the same participant

These templates target the current native starter's exported
`runPeer({ signal }, { onOwned, onClosed })` lifecycle. Copy the maintained
[`deploy`](../deploy/) files into your authored project as `deploy/`, alongside
its `session.mjs`, `local.mjs`, helpers and pinned package lock. Install the
project's exact dependencies and finish its normal setup first. Use **Node 24
or newer** for this launcher and native starter, even though some portable Core
modules support Node 22. Do not infer native/SQL compatibility from that lower
package minimum.

Run from the project directory:

```sh
node deploy/participant.mjs --session ./session.mjs
```

The launcher explicitly awaits `runPeer`; importing an arbitrary module alone
would not start a participant. An application with a different native entry point
must adapt and test its own launcher. A separate optional assistant process must
use the application's documented assistant entry point and exclusive owner
rules; starting a second signer against the same store is not a deployment method.

On POSIX hosts, SIGINT/SIGTERM requests cancellation and awaits the participant's
owned cleanup. The launcher reports failure if cleanup fails or exceeds ten
seconds, and bounds output flushing. It does not claim that in-flight operations
committed: preserve their original IDs, signed attempts and device store, then
inspect uncertain outcomes after reopening. Machine loss, forced container kill
and Windows task termination can interrupt cleanup. Resume the same private
store; never rerun initialization merely because the process stopped.

## Linux and macOS

Edit the absolute Node/project paths in
[`tendriller.service`](../deploy/tendriller.service) or
[`dev.tendriller.participant.plist`](../deploy/dev.tendriller.participant.plist).
Verify the selected Node binary's version. Create the dedicated service user and
private `.tendriller` directory before installing the unit; systemd's writable
path must exist and contain the retained setup/store. Do not put credentials in
unit arguments. The systemd template permits writes only in that state directory;
applications needing other persistent paths must declare them explicitly.

Use the appropriate administrator or per-user service manager to install and
start the unit. Verify the actual process and cross-device round trip after
startup. The systemd unit restarts on failure, and the launchd template restarts
unsuccessful exits. They do not guarantee availability while the host is asleep
or offline. Stop the unit before deliberately starting another owner manually.

## Windows

[`install-windows-task.ps1`](../deploy/install-windows-task.ps1) registers a
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
Start-ScheduledTask -TaskName TendrillerParticipant
Get-ScheduledTaskInfo -TaskName TendrillerParticipant
```

Run the foreground Node command first to inspect startup errors. Task Scheduler
history and process status alone do not prove application connectivity. Use the
application's public query and the paired browser for that check. A scheduler
stop/logoff may forcibly terminate Node; it is not proof of a graceful flush.
The task can be removed with `Unregister-ScheduledTask` after stopping it, without
deleting the project or state.

## Container

The [Dockerfile](../deploy/Dockerfile) uses Node 24 on Debian, a non-root user,
and the project's locked runtime dependencies. It is a native events-starter
template. A native SQL engine with install-time build requirements needs its own
matching prepared runtime/image; `--ignore-scripts` does not compile such an engine
or establish SQL support. No silent fallback to events is permitted.

Use the matching [Dockerfile.dockerignore](../deploy/Dockerfile.dockerignore)
when building from the project root. It excludes the standard private store,
checkpoint files, environment secrets, Git data and local dependencies. Review
the authored context for any additional private paths before building. Never
bake signing keys or initialized device state into an image.

```sh
docker build -f deploy/Dockerfile -t my-tendriller-app .
docker run --name my-tendriller-app --memory=1g --memory-swap=1g --cpus=1 \
  --mount type=bind,src=/absolute/private/app-state,dst=/app/.tendriller \
  --stop-timeout=15 my-tendriller-app
```

The host state directory must already contain the prepared application's private
records and be accessible only to the container's service user (the image's
`node` user, normally UID/GID 1000). Keep it out of the build context. A read-only
or incorrectly owned mount is a startup error. `local.mjs` locates state beside
its source module, so mounting `/data/.tendriller` would not retain this starter's
actual store. No inbound port is required by this template. Resource limits are
an explicit host budget, not a memory or Internet-connectivity qualification.

## Verify the deployment and retain evidence

Record the exact source/package hashes, actual Node version, executable command,
process/service identity, private store location and resume command. Prove an
applied command observed from the other participant and persistence after process
restart. Report which process must remain running. Unit syntax tests and a mocked
launcher prove only template wiring and shutdown behavior; actual Linux, macOS,
Windows, container, OAuth and remote transport deployments require their own
recorded runs. Never label configured CI or an unexecuted template as a passed
platform qualification.
