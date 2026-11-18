# Build a Tendriller page for your user

Create an ad hoc web page connected to an agentic task. The person can open it on a phone or another device, sign in with GitHub or Google, and use controls, text, or permissioned sensors to send input back. Your application can update the interface, show a reply, or speak it aloud. Author the HTML, CSS, and JavaScript for the task. Tendriller hosts the authenticated page and its signed code. An owned Chronolog session carries application data between authorized peers.

## Start with one useful interaction

1. Use the service origin where you found this guide or the origin the user supplied. For a local copy of this guide, the default service is https://tendriller.dev. Read `/api/service` for the current contract and limits. For a new page, use the email the person signs in with. Ask for it only if you lack it. Call `POST /api/tendrils` with `{"owner":"the-person@example.com","name":"A short task name"}`. Keep the returned `api`, token, and `application.id` in private agent storage. Share `page_url` with the person. They sign in to claim the page.
2. An existing application already has an identity, definition, and device setup. Reuse them. For a new application, follow the [setup and signed publication guide](docs/AGENT_SETUP.md) and the [peer application cookbook](https://github.com/werg/tendriller-contrib/blob/main/cookbooks/run-a-peer-application/COOKBOOK.md). Start with a small complete loop, such as sending one question and rendering its answer.
3. Connect the peer that will act on that input. Before handing off a page that promises agent replies, verify that an action reaches the intended agent conversation, that the reply appears in the page, and that this works again after the current turn ends. See [agent delivery](#agent-delivery). A page built as a standalone tool or dashboard can work without a conversational receiver.

Use the [Tendriller skill](https://tendriller.dev/docs/AGENT_SKILL.md) for this workflow in a skill-aware harness. Agents can also follow this guide directly.

## Choose features by what the person needs

| Need | Use |
| --- | --- |
| Buttons, forms, text chat, a sketch, or live UI updates | Use normal DOM controls and page-owned views. Send a fresh preview with `tendril.signals.send`. Submit requests or changes that must survive disconnects through declared application commands. Render incoming replies from the same application. |
| Camera, microphone, screen sharing, location, orientation, or motion | Start with `tendril.capabilities()`, then call the corresponding browser API from the page. Ask for permission at the point of use, display what's active, and offer a way to stop or continue without the sensor. |
| Gamepads, Bluetooth, USB, serial, HID, NFC, or MIDI | Probe support on the actual device and use the browser's API and chooser where available. Own framing, cleanup, and fallback for the particular instrument. See the [instrument cookbook](https://cookbooks.tendriller.dev/cookbooks/connect-instrument/COOKBOOK.md). |
| Files, sharing, barcode or document capture | Use a file picker, drop target, or camera. Optional browser capabilities include clipboard, Web Share and barcode detection. Let the person review what they are sending. |
| Voice input, wake phrase, or spoken replies | Load the optional [voice adapter](docs/HANDS_FREE.md) and author the controls. Start with typing and push-to-talk. Add foreground wake if the target device supports the selected engine. Use visible and, if useful, audible feedback when capture starts. Explicitly enable output and call `voice.speak(text)` for a reply. |
| Shared lists, evidence, offline drafts, or history | Use a [Chronolog application](docs/APPLICATION_BACKENDS.md) with commands, applied reads and explicit recovery. Fresh previews can use [signals](docs/APPLICATION_SIGNALS.md). Keep local drafts independent of a delayed reply or an uncertain retry. |
| A phone shortcut and recognizable branding | Set page metadata, then show the person **Page options → Add to Home Screen** when the page is useful enough to revisit. See [branding and installation](#branding-and-installation). |
| A page that opens offline | Offer **Page options → Save for offline use** for its current code. Design and test disconnected data, draft retention and reconnection separately. See [offline code and application state](docs/BROWSER_API.md#immutable-code-and-offline-use). |

Your page code decides which interactions and readings to send, including automatic rules. For example, update a map locally with each location fix, then send one arrival when the device remains inside a waypoint radius. For a live gauge, send bounded, replaceable readings. For a checklist completion, submit a durable command. Test denied permissions, false triggers, and stop behavior on the intended device. See [browser sensors](docs/BROWSER_API.md#sensors-and-voice) and the [cookbook catalog](https://cookbooks.tendriller.dev/catalog.json).

### Agent delivery

An open peer connection can deliver work to a process that is running. To resume an idle agent conversation, use the actual harness's supported wake mechanism and an application-side consumer. The hosted control transport supplies peer introductions and signed publication; conversational wake, request queues, and notification delivery belong to the application and its chosen agent harness. See the [receiver cookbook](https://github.com/werg/tendriller-contrib/blob/main/cookbooks/connect-resuming-agent/COOKBOOK.md).

For work that must survive disconnects, persist a request under a stable identity, preserve its authenticated sender and granted authority, and record the correlated reply or handling outcome. Keep pending work visible while the agent is unavailable. Start with a harmless request, end the agent turn, and check that another request wakes the same conversation and renders a reply with the page's new draft intact. Describe the actual response path in the handoff, including any manual or scheduled step.

### Branding and installation

Use the returned agent API URL and its private bearer token, or patch through the authenticated SDK:

```js
await host.request('', {
  method: 'PATCH',
  body: {
    name: 'Kitchen Companion',
    short_name: 'Kitchen',
    icon: 'https://example.com/kitchen.png',
    theme_color: '#315744',
    background_color: '#f5f2eb',
  },
});
```

Use a suitably sized square PNG, WebP, or SVG at a reachable HTTPS URL for the generated install manifest. PNG also supplies the default Apple touch icon. An authored manifest can declare exact sizes, multiple or maskable icons, and its own branding. A same-origin, authenticated authored manifest needs `crossorigin="use-credentials"`. Set `id`, `scope`, and `start_url` to the stable page path when the shortcut should open the selected publication. In the browser, `tendril.identity.base` is the stable page URL. Check the icon and launch on the intended browser. Use `tendril.installation.prompt()` directly from a click if you provide a custom install control. See [Home Screen setup](docs/BROWSER_API.md#home-screen-setup).

## Prompts to adapt

Give your agent this guide, a task, and the email you sign in with. Add a concrete first action and result:

> Build a kitchen companion page for me using Tendriller. My sign-in email is me@example.com. Start with a shopping list I can edit and a recipe step I can advance from my phone. Add an optional fridge photo I can review before sending it. Show your reply in the page. Give me the link once you’ve tested both directions.

Other starting points:

- **Sports or activity companion** for sailing, cycling, or geocaching. Show the next waypoint and detect arrival on-device. Let me confirm a missed milestone by hand.
- **Office dashboard.** Show a live progress board and let me ask about a selected item or correct its status. Keep the question attached to that item.
- **Maintenance helper.** Keep a checklist visible, let me take and review a photo, and show the relevant diagram beside your answer. Offer push-to-talk and a typed fallback.

## Verify before handoff

Open the published page under its intended account and try its first useful action. Exercise the failure that matters most to the task, such as denied camera access, a lost connection, an uncertain command receipt, or a reply arriving after a new draft. Check narrow-screen and keyboard use. A local preview can test exact authored files and UI behavior. Use a live authorized run to verify sign-in, peer membership, signed publication, or agent wake. Give the person the stable page URL and a brief account of what worked and what still requires setup.

See the [setup guide](docs/AGENT_SETUP.md), [browser API](docs/BROWSER_API.md), [preview tool](docs/tools/PREVIEW.md), and [documentation index](llms.txt).
