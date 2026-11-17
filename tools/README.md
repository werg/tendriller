# Application and authored-page tools

These optional Node tools use the common public application session. They do not
supply another database, host data protocol, signer, outbox or event dispatcher.

| Entry | Purpose |
| --- | --- |
| `tendril` | Domain commands and coherent queries, exact operations, explicit recovery, signed publication, and host lifecycle administration |
| `tendril-preview` | Serve complete authored assets or run them with an explicitly supplied real application bootstrap |
| `@tendriller/tools/session` | The same operational adapter for an already owned public session |
| `@tendriller/tools/preview` | Authored asset server and optional Playwright browser harness |
| `@tendriller/tools/pack` | Enumerate and hash exact authored bytes for complete signed publication |

See [the CLI](../docs/tools/CLI.md), [preview composition](../docs/tools/PREVIEW.md)
and [artifact boundaries](../docs/tools/ARTIFACTS.md).

Build the core public artifacts, install this package's pinned local artifact
dependencies, then build the tools:

```sh
npm run build
npm --prefix tools ci
npm run build:tools
npm run test:tools
```

The release contains the two executable commands and three public modules in
one tools archive. It embeds the exact runtime assets named by its manifest.
The application's bootstrap independently imports its pinned public Chronolog
package and owns device creation or resume, peer transports and shutdown.

Unit tests check the tool boundary and authored graph behavior. They do not
qualify a fake backend as a real application. Actual application behavior is
qualified by the independent packed native, browser, SQL and hosted participant
consumers in tendriller-contrib. Headless preview requires an actual Playwright
browser installation, supplied by the project or `--playwright-path`.
