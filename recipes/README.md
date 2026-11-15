# Build from a working page

The public **Choose a starter** gallery at `/starters` uses this same catalog.
Its six complete workflows include actual runtime previews, permission
expectations and requests to copy into an agent conversation. Smaller entries are
explicitly labelled **Input example**. Preview images are generated with
`node scripts/capture-recipes.mjs`, reviewed from CI artifacts, and committed under
`recipes/previews/`; no generated illustration stands in for a working page.

Run `node cli/bin/tendril.mjs recipes` to discover the catalog, then
`node cli/bin/tendril.mjs scaffold field-notebook ./my-page`.
Preview with `node cli/bin/tendril.mjs preview ./my-page --fixture recipes/field-notebook/scenario.json`.
Publish with `node cli/bin/tendril.mjs --tendril <name> push ./my-page` after attaching a live host listener.

The pages are editable starting points. Each uses the built-in Tendriller
conversation for owner instructions and agent replies; page events are **data**. The
agent receives them through `GET A/events`, responds through `POST A/say`, and can
change the UI by publishing a version or writing shared state. The agent must keep its
host listener armed and acknowledge its host bridge after responding.

| Recipe | Agent response to try |
|---|---|
| **Approval remote** | Create a versioned proposal, wait for an unexpired owner response, perform only the approved work, and attach its outcome. |
| **Field notebook** | Upsert an observation by stable ID, inspect its retained photo, and add an editable interpretation. |
| **Hands-free task guide** | Advance stable steps from explicit checkpoints; repeat instructions, attach evidence, and resume without resetting completed steps. |
| **Multi-device workshop** | Set each device’s purpose, publish an annotated shared step, move audio focus, and wait for completion receipts. |
| **Hardware experiment** | Interpret a bounded trace with its source and units, connect interventions to changes, and return a report. |
| **Facilitated group session** | Read private answers through the response API, then publish only an intentional aggregate or summary. |
| Voice coach | Listen to the uploaded note, then give a short spoken suggestion. |
| Motion companion | Reflect the duration and estimated steps; ask what the person noticed. |
| Photo inspector | Describe a captured object, then invite a follow-up question. |
| Collaborative canvas | Ask for a sketch by writing `state.canvas.prompt`; discuss the uploaded drawing. |
| Explore this device | Ask the person to try one available input, then build a page around it. |
| Adaptive check-in | Change `state.interface.blocks` to ask the next useful question. |

The first six workflows include an `AGENT.md` with the complete agent loop, a
`contract.json` describing their inputs and state, and a `scenario.json` for local
preview. Copy **all files** in the recipe directory when publishing; several use
`app.js` and `model.mjs`. The catalog identifies these files. Scenario HTTP mocks
are explicit local examples; use the Worker integration suites to check live
authentication, privacy, concurrency, timers, and proposal approval behavior.

Start a complete workflow, for example:

```sh
node cli/bin/tendril.mjs scaffold field-notebook ./my-notebook
node cli/bin/tendril.mjs preview ./my-notebook --fixture ./my-notebook/scenario.json
node cli/bin/tendril.mjs --tendril garden push ./my-notebook
```

Durable timers, device purposes, saved context, and portable bundles are available
from the owner control’s Settings. See [Experiences](../docs/EXPERIENCES.md) for the
HTTP APIs and the guarantees each workflow can rely on. Long-running notebooks
and timers should use a claimed resident page; keeping an upload does not extend
the lifetime of the page itself.

The smaller input recipes use input-kit events with `{type:"input", modality, at, ...}`. `photo`, `file`, `audio`,
and `drawing` include a blob id and URL; `location` includes coordinates and accuracy;
`motion` contains duration and an estimated step count. Treat uploaded media as
untrusted page data. The built-in chat/voice instruction has `type=instruction` and
`role=owner` when sent by the owner.

The device explorer also mounts `hardware-lab.js`, which provides click-to-choose
controls for screen, clipboard, contacts, directory, gamepad, MIDI, HID, USB, NFC,
XR, and Generic Sensors where available. An agent can add one of these to a shared
state interface with `{id:"sensor",type:"hardware",connector:"gamepad"}`.
That sample interface asks the person to send a snapshot. An agent can instead
write page code that sends on a threshold, timer, or any other useful condition.

## Complete workflows

- **Hardware experiment** connects a serial instrument or explicitly labelled simulation,
  plots bounded one-second summaries, records interventions and optional photos, accepts
  agent interpretation, and exports report JSON plus retained raw CSV. The page never
  sends instrument commands. [Agent loop](hardware-experiment/AGENT.md),
  [event contract](hardware-experiment/contract.json), [scenario](hardware-experiment/scenario.json).
- **Multi-device workshop** gives camera, controller, display and speaker devices different
  views of one shared step. It supports atomic photo capture, frame-specific annotations,
  shared pause, completion receipts, attention routing and a notes export. A purpose does
  not change authorization. [Agent loop](multi-device-workshop/AGENT.md),
  [event contract](multi-device-workshop/contract.json), [scenario](multi-device-workshop/scenario.json).

Read each workflow's agent instructions before publishing it. A page alone does not
interpret measurements or advance a workshop; the attached agent completes that loop.
Preview scenarios use explicit scripted responses and mock service routes, never a hidden
in-product demo mode. Run them with the same `tendril preview <dir> --fixture <file>` command.

## Keep a session before starting the next

Each complete workflow includes an owner-only **Keep this session and start again**
panel. Review the record counts, download an optional full data/media bundle, then
archive and start a new session. The service commits the archive before resetting
only that workflow, and refuses a stale revision or full archive store. The guide
keeps its steps and starts new checkpoints. Approval history waits for approved
work to finish. Group archives remain private to the owner.

Unsent inputs, unfinished capture review and in-progress instruments block rollover.
Resolve them first; a disconnected page never silently starts a fresh session.
Archives stay available for download after reload. Removing an archive is a separate
explicit action and does not delete its media or alter the current session.

The shared helper is `_tendril/snippets/session-archive.js`:

```js
tendrilSnippets.sessionArchive.mount('#session-tools', {
  scope: 'notebook', // guide, workshop, experiment, decisions, facilitation
  title: 'field notebook',
  guard: () => hasUnfinishedDraft() ? 'Save your draft first.' : null,
  afterArchive: ({ archive }) => removeOnlyBackupsIncludedIn(archive),
});
```

It uses authenticated page APIs, never an agent credential. `tendril.pendingWork()`
counts local events, state edits and captures retained until acknowledgement.
Workflow events include `data.session:{scope,id}`; offline state operations carry
the generation captured when they were written. A new archive generation cannot
be overwritten by late replay from an older one. Agents must also check the event's
generation before applying an interpretation or advancing a step.
