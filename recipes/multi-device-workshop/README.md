# Multi-device workshop

One shared task can have a phone camera, tablet controller, large display and
speaker. Devices have a **purpose** for presentation and a separate access role.
Changing a purpose never grants more authority.

```sh
node cli/bin/tendril.mjs scaffold multi-device-workshop ./my-workshop
npm run build
node cli/bin/tendril.mjs preview ./my-workshop --fixture ./my-workshop/scenario.json
```

For interactive local use run `npm run preview -- ./my-workshop`. For a real
session, attach a host listener, give the agent [AGENT.md](AGENT.md), and publish
with `tendril --tendril <name> push ./my-workshop`. Open the same owner page on each
device, sign in, and assign its purpose in the page. The owner can move attention
to a device for five minutes; replies can speak on one selected device.

The agent creates a shared `workshop.step`, interprets accepted photos, and adds
annotations tied to an exact frame. A tap on the image sends normalized
coordinates with that frame identifier. Completing a step emits a receipt; the
agent confirms it and advances once. **Pause workshop** immediately stops active
camera tracks and disables capture/completion until resumed. Starting the camera
again always needs a tap.

The [machine contract](contract.json) defines the events and shared state paths.
The [agent instructions](AGENT.md) cover reading media, frame-specific overlays,
duplicate guards, correlated replies, durable progress and completion. Queued
offline observations are distinct from received ones. Exported notes contain the
steps, frame references, annotations and receipts. Full tendril export includes
portable media when needed.

The local scenario uses explicit device/focus HTTP fixtures and scripted agent
responses while loading the production runtime. CI runs it with the browser
shipping gate; actual Worker tests cover owner-only device/focus authorization.
