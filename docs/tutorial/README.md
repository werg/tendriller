# First application: Shared Notes

This is the complete source used by [Build an app](https://tendriller.dev/docs/BUILD_AN_APP.md). Extract
the host's `/downloads/tendriller-first-app.tgz` into a new application directory,
or copy this directory out of the Tendriller repository before installing its
exact public SDK, tools and Chronolog session archives. Use Node 24.

The parent guide supplies the package acquisition commands and every setup
checkpoint. After installing those dependencies:

```sh
npm run create -- https://YOUR_HOST owner@example.com "Shared notes"
# The owner opens the printed page URL and signs in.
npm run init
npm run build
npx tendril --session ./session.mjs publish ./page --operation notes-release-1
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

The browser can read/write notes but cannot administer, publish, coordinate or
recover. Keep the native peer running for applied writes. This first-app policy
can be expanded deliberately after reviewing the membership and availability
requirements. Stop the native peer before running another CLI process that
opens its device store.

The page exposes real connection/data state, local draft preservation, accepted
versus rejected applied outcomes, operation inspection, exact retry and explicit
close. Its localhost preview is clearly labeled layout-only. Follow the parent
guide's deployed acceptance checks before reporting success.

| Source | Purpose |
| --- | --- |
| `domain.mjs` | Shared events-backed command/query definition |
| `setup.mjs` | Create, initialize/select genesis, enroll verified browser key |
| `local.mjs` | Private setup records and native host client |
| `session.mjs` | Real resumable native session; CLI bootstrap and running peer |
| `worker.mjs` | Browser device, owned session, authority and peer key acquisition |
| `page.mjs`, `index.html` | Editable UI and public session facade |
| `build.mjs` | Browser bundling and a public-only publication graph |

The source uses public package exports and no qualification fixture imports.
It is a small working composition to adapt, not a general automatic enrollment
service or a substitute for release qualification. The source of truth for
capabilities remains the host descriptor and exact installed artifacts.
