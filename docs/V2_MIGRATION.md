# Chronolog v2 Cutover, Export & Workspace Re-Enrollment

When a Tendriller host cuts over to a new incompatible storage namespace (such as the Chronolog v1 → v2 cutover), pre-v2 pages and device stores cannot migrate in place. This guide documents the exact account, token, and page lifecycle so existing workspaces can recover data cleanly without silent empty recreations.

## Account, token, and old-page lifecycle

- **Host-side state:** Cutting over to a fresh storage namespace retires pre-v2 Durable Object namespaces. Pre-v2 page URLs return HTTP `404` and render an actionable transition screen in browsers (instead of an opaque error) explaining that local data on admitted devices is untouched.
- **Agent tokens (`ta_…`):** Host-issued pre-v2 agent tokens may return `401 unauthorized: Invalid or revoked agent token` and the agent hub reports `revoked`.
- **Local state is never erased by the host:** Your workspace `.tendriller/agent/identity.sqlite` (Ed25519 signing key), `.tendriller/agent/wrap-key.json` (X25519 wrap key), `.tendriller/pages/<id>/device.sqlite` stores, authored `pages/` source, and browser IndexedDB profiles remain intact locally.

## Recoverable cutover workflow

> **Rule:** Never silently recreate pages with empty state, and never treat receiving a breaking-change broadcast as migration completion.

### 1. Export and reconcile current data before upgrading

Before replacing your workspace kit or discarding old page references:

1. Keep the old workspace directory (or a full copy of `.tendriller/` and your v1 `pages/<slug>/domain.mjs`) intact.
2. Export materialized state from every local native page device and check for any pending offline edits on admitted browsers before closing them.
3. Save the exported domain JSON/SQL dump outside `.tendriller/` (for example `migration-exports/<slug>.json`) and verify record counts and pending edits.

### 2. Upgrade the workspace release kit cleanly

Avoid copying new same-version archives over `packages/` and running `npm install --package-lock-only` in place (which can retain stale integrity hashes in `package-lock.json`). Use the verified upgrade command:

```sh
npx tendril workspace upgrade --kit artifacts/tendriller-first-app-0.3.0-rc.17.tgz
```

This preserves `.tendriller/`, `tendriller.json`, and `pages/`, regenerates `package-lock.json` in a clean staging directory, runs `npm ci --ignore-scripts`, and verifies that every installed archive matches the immutable `composition.json` ID.

### 3. Re-enroll the same workspace agent (preserving signing & wrap keys)

If your previous `ta_` token returns `401 unauthorized`, re-enroll the existing workspace without creating a brand-new signing identity:

```sh
# Option A: Account-linked MCP route (reuse your existing keys)
# Register with your existing publicKey and wrapKey, save result, then:
npx tendril workspace reenroll --service "$TENDRILLER_ORIGIN" --credential .tendriller/register-agent-result.json

# Option B: Dashboard join code (Dashboard -> Your agents -> Add agent)
npx tendril workspace reenroll --service "$TENDRILLER_ORIGIN" --code CODE

# Option C: Unclaimed owner email (owner claims by signing into the first new page)
npx tendril workspace reenroll --service "$TENDRILLER_ORIGIN" --owner owner@example.com
```

`tendril workspace reenroll`:
- Reuses your existing `.tendriller/agent/identity.sqlite` and `.tendriller/agent/wrap-key.json`.
- Archives the previous `credential.json` and previous `tendriller.json` page map to `.tendriller/agent/credential.replaced-<ts>.json` and `.tendriller/migration-archive-<ts>.json`.
- Never deletes `.tendriller/pages/<old-id>/` device stores and never silently creates empty replacement pages.

### 4. Create v2 pages, import exported state, and verify

1. Update each page's reducer/domain to Chronolog v2 (`$reducers` ES Modules or `chronolog/sql` + `chronolog/rls`).
2. Create and initialize each replacement page (`npm run page:new -- <slug>`, `npm run init -- <slug>`), import your exported domain data and reconciled offline edits, and verify counts/views before publishing (`npm run deploy -- <slug>`).
3. Start `tendril agent run`, have the owner sign in to the new page URL, confirm device admission and data convergence, and **only after verification succeeds** acknowledge the breaking-change broadcast:

```sh
npx tendril broadcasts ack <broadcast-id>
```

If you placed the migrated v2 workspace inside a subdirectory of your existing Codex conversation root (for example `--workspace /home/user/agent/v2` while the conversation runs in `/home/user/agent`), pass `--thread-cwd /home/user/agent` to `consumers/codex-queue.mjs`. The bridge verifies the exact thread cwd at startup, preserves checkpoint scope and retained pending states, and still addresses the v2 workspace path in notices.
