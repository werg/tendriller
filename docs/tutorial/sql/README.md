# Browser-first ordinary SQL inventory

This is a separate application with its own retained private handle and profile. Follow the selected origin's [Build an app](https://tendriller.dev/docs/BUILD_AN_APP.md) and [state-model guide](https://tendriller.dev/docs/STATE_MODELS.md): verify open readiness before acquisition/creation and install the exact public SDK/tools/authority/SQL-capable session plus qualified browser engine graph. Never mix same-version archives or use private kernel imports.

Use the advertised immutable SQL kit. It supplies the exact browser engine graph; setup verifies and copies the four package-public WASM assets to `engine/`: `manifest.json`, `sqlite3.mjs`, `sqlite3.wasm`, `sqlite3-opfs-async-proxy.js`. It rejects a different retained graph and derives deterministic execution semantics from the verified browser manifest **without a native data process/addon**.

```sh
npm run create -- https://YOUR_SELECTED_SERVICE owner@example.com "Shared inventory"
npm run init
npm run deploy
# Give the owner the ready page URL now; they complete sign-in/key proof locally.
```

The publisher key is independent from the as-yet-unknown data root. `page/` contains only the complete public authored graph. `.tendriller/`, signing identities, device journals and plaintext keys are private and never published. Retain exact original setup/publication attempts after uncertain replies.

The first owner browser initializes its local keys and signed root/membership. A fresh additional browser remains keyless until explicit key proof, independent crypto grants and recipient-bound wrapping/import. Crypto writer/admin/finalizer rights are not SQL object/namespace/row permissions. The SQL Worker uses its supported dedicated-Worker VFS mode and preserves one physical store owner.

## Domain flows

- **Create initial tables and rows** is an ordinary authorized atomic CREATE/INSERT/emit program, not a unique schema bootstrap channel.
- **Create/edit/delete bin** use stable IDs and normal row ownership/permission checks.
- **Reviewed transfer** captures explicit source/destination balances and runs guards, both updates, receipt insertion and emit atomically at its signed author-time position. No JavaScript prior read substitutes for the SQL guards.
- **Add label column** submits ordinary ALTER without republishing code. Catalog/forms rederive from the next coherent materialized snapshot.
- **Grant units updates and receipt inserts** is an explicit ordinary platform-permission transaction. Its column scope does not silently expand when `label` appears.
- The optional exact author-time field demonstrates late earlier DDL revising a previously displayed SQL success/rejection. Never dependency-sort DDL ahead of author time.

Submission acknowledges durable local signed intent, with no peer/native/finalizer/current-global-read prerequisite. Coherent materialization and SQL rejection/success are revisable until the chosen finality says otherwise. Retention is independent named-peer evidence. Default no-finality is complete and explicitly rejects final waits as unsupported. Optional frontier closure can exclude genuine unseen offline work behind it; originals remain inspectable without retimestamping.

The page derives rows/counts/detail/catalog from coherent snapshots while keeping local drafts/reviewed guards separate. A missing table or stale query marks the last snapshot **not current**, preserving drafts/focus/deep links and unrelated offline authoring. Complete-graph offline acknowledgment includes the real engine files; HTML or installation alone is not offline readiness.

`session.mjs` and `engine.mjs` are optional explicitly provisioned native capabilities, not prerequisites for browser operation. Native engine source/ABI must match the qualified WASM/profile. `demo.mjs` reads the existing initialized/provisioned application; it does not create another root, seed a special schema or select application history.

Qualify actual browser-first setup, offline CRUD/reload, separate-device crypto provisioning plus ordinary SQL grants, RTC/forced relay, schema-only invalidation, late DDL outcome revision, rejected cross-object DDL and native/WASM parity at desktop/320px. Report exact evidence and untested boundaries; native-only or static-preview tests do not qualify browser SQL.
