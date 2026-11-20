# First application: Shared Notes

This is the complete source used by [Build an app](https://tendriller.dev/docs/BUILD_AN_APP.md). Extract
the host's `/downloads/tendriller-first-app.tgz` into a new application directory,
or copy this directory out of the Tendriller repository before installing its
exact public SDK, tools and Chronolog session archives. Use Node 24.

The parent guide supplies the package acquisition commands and every setup
checkpoint. After installing those dependencies:

```sh
npm run create -- https://YOUR_HOST owner@example.com "Shared notes"
npm run init
npm run build
npx tendril --session ./session.mjs --mode own --timeout 120 publish ./page --operation notes-release-1
# Now give the owner the ready page URL; they sign in to open this version.
# Do not wait for a claimed reply before publishing.
# In the published page, choose Set up this browser and verify its public key.
npm run enroll -- BROWSER_PUBLIC_KEY_FROM_THE_PAGE
npm run peer
# In the published page, choose Connect existing device.
```

Only `page/` is publishable. `.tendriller/` holds the private agent handle,
native device, initial key and exact setup requests; keep it out of Git and page
assets. Setup records are write-once so a retry cannot silently generate another
identity or change a signed transition. The browser receives keys only through
the authenticated session's reader-to-reader key exchange.

Before installing the packages, inspect the selected host's `/api/readiness`.
`create` repeats that check and refuses paused, unavailable or older hosts with
no readiness endpoint. It also refuses an existing handle for another service.
Resume a saved production application only against its matching production
connector; use a separate directory for staging. Never copy private signing
state to make an origin mismatch disappear.

If publishing times out, retain `page/`, `.tendriller/` and the original
`notes-release-1` identity. With the owner stopped, inspect `publication` and
`publication-operation notes-release-1` using `--mode own`; compare the signed
graph before an exact retry. A retained host receipt and a verified current head
are separate observations. `--timeout 120` means 120 seconds.

The browser can read/write notes but cannot administer, publish, coordinate or
recover. Keep the native peer running for applied writes. This first-app policy
can be expanded deliberately after reviewing the membership and availability
requirements. With the peer running, ordinary CLI commands attach to its
owner automatically. Use `--mode own` only for deliberate standalone ownership
while the peer is stopped; it takes the same exclusive fence.

Several browser tabs attach to one profile owner. SharedWorker is preferred; the
fallback uses an exclusive Web Lock and authenticated local routes. A tab closes
its attachment, leaving the shared signer and sibling views intact. Drafts and
pending references belong to each view; copying a draft is explicit. A duplicate
live view ID receives a fresh ID. Reloading reopens the original signer journal.

The page exposes real connection/data state, local draft preservation, accepted
versus rejected applied outcomes, operation inspection, exact retry and explicit
close. It also imports the supplied live-view, operation-state and reviewed-input
helpers. Adapt these modules directly rather than rebuilding transport and state
fetching around another backend. Its localhost preview is clearly labeled
layout-only. Follow the parent guide's deployed acceptance checks before reporting
success: deliver the running hosted application and explain which process must
remain alive, as described in [Agent delivery](https://tendriller.dev/docs/AGENT_DELIVERY.md).

| Source | Purpose |
| --- | --- |
| `domain.mjs` | Shared events-backed command/query definition |
| `setup.mjs` | Create, initialize/select genesis, enroll verified browser key |
| `local.mjs` | Private setup records and native host client |
| `session.mjs` | Real resumable native session; CLI bootstrap and running peer |
| `worker.mjs` | Browser device, owned session, authority and peer key acquisition |
| `page.mjs`, `index.html` | Editable UI and public session facade |
| `build.mjs` | Browser bundling and a public-only publication graph |
| `helpers/` | Importable coherent views, operation observations and reviewed input |
| `media/` | Camera/file and runtime voice controls; opt-in native inference participant |
| `sql/` | Separate guarded SQL starter, exact engine setup and resumable transaction demo |

## Extend the running application

[Application patterns](https://tendriller.dev/docs/APP_PATTERNS.md) explains the
helper interfaces and their ownership boundaries. These are application-owned
source modules, not additional SDK exports or a second synchronization layer.

The page's **Review a photo** controls work with manual review immediately. The
optional **Analyze photo** path needs the native inference participant described
in [Reviewed AI input](https://tendriller.dev/docs/AI_INPUT.md), an allowed browser
device, an explicit request budget, and the owner's provider credentials. Run that
participant instead of a second process opening the same native store. Analysis
only suggests text; **Save reviewed observation** submits the reviewed command.
OpenAI is the included provider and is named in the page's consent. Disclose a
custom provider in the authored page before publishing that adaptation. Voice
likewise supplies an editable draft, with typed input always available.

For stock deductions or other guarded relational changes, follow
[State models](https://tendriller.dev/docs/STATE_MODELS.md) and [the SQL starter](sql/README.md).
It creates a separate application and needs the matching SQL-native engine
archive. The events-only archive used above cannot run it. The SQL demo tests
atomic two-bin transfers, rejection without partial changes, exact retry and
reopen; its optional browser Worker is an integration source, not a second
finished interface.

The source uses public package exports and no qualification fixture imports.
It is a small working composition to adapt, not a general automatic enrollment
service or a substitute for release qualification. The source of truth for
capabilities remains the host descriptor and exact installed artifacts.


For MCP access, run `npm run assistant:prepare` before owner sign-in and retain
its returned review URL. Run `npm run assistant` instead of `peer` for the same
native participant plus the assistant adapter. Give the owner the ready page and
review URL together. Claim adopts the prepared app, while assistant approval
remains explicit; there is no need to type “claimed” back to the agent.

The default assistant requests only the declared notes query and add-note command.
For optional event forwarding, use `npm run assistant:prepare -- --events` and
`npm run assistant -- --events` with the same reviewed choice. Forwarding events
does not create an MCP subscription, run a future model turn, or extend this
process's lifetime. The runner reports proposal preparation, the running native
PID, actual adapter status and shutdown separately. Even `adapter_online` still
requires a real MCP/browser round trip before setup is complete.
