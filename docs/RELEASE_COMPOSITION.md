# Qualify a three-repository release

Tendriller hosts the page and its controls. Chronolog owns the application session, durable history, and peer replication. The cookbook repository supplies independent examples and black-box qualification. A green check in any one repository does not prove that three new commits work together.

## Choose exact source

Choose one full 40-character commit SHA from each repository: [core](https://github.com/werg/tendriller), [Chronolog](https://github.com/werg/chronolog-db), and [cookbooks](https://github.com/werg/tendriller-contrib). Record all three before building. Use a clean checkout; local edits cannot be reproduced by a commit SHA. Older candidate branches are listed in [the branch inventory](BRANCH_INVENTORY.md); review and qualify their changes before using them.

## Run local checks

| Repository | Minimum local gate |
| --- | --- |
| Core | `npm ci && npm run check:release` |
| Chronolog | `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` |
| Cookbooks | `npm ci && npm run check && npm run build` |

Chronolog's [independent application workflow](https://github.com/werg/chronolog-db/actions/workflows/webrtc.yml) builds public Chronolog session archives, core host artifacts, and cookbook consumers. It checks native and browser participation, SQL, hosted serving, and WebSocket fallback. Dispatch it with the candidate core and cookbook SHAs. GitHub requires the workflow `--ref` to be a branch or tag, so point a tag at the selected Chronolog commit (or use a branch whose head is that commit):

```sh
gh workflow run webrtc.yml --repo werg/chronolog-db --ref <chronolog-branch-or-tag> \
  -f host_ref=<core-40-character-commit> \
  -f contrib_ref=<cookbooks-40-character-commit>
```

Verify the run's `headSha` is the recorded Chronolog SHA, then inspect its `application-*` artifact and `composition.json`. The checkout step rejects abbreviated companion refs and verifies their exact commits. The workflow's ordinary push and PR runs retain their pinned reference pair, so candidate qualification does not silently move an established release checkpoint. If this candidate passes, update the pinned pair in a reviewed PR and run the default-branch workflow again.

## Stage the host

Build and deploy the selected core commit to fresh staging storage. Run `node scripts/check-deployment.mjs https://staging.tendriller.dev`; it checks a real Durable Object read as well as public endpoints. Then exercise OAuth return, owner claim, a signed page publication, page reload, and an independent agent/browser exchange. Keep creation paused if the shared Durable Object quota or a required check fails. `STAGING_READY` and `STAGING_STORAGE_SCHEMA` must describe the actual staging deployment before CI may deploy it automatically.

Production needs its own fresh storage baseline and explicit cutover. There is no old-state reader or migration path. The release tuple, passing composition artifact, staging evidence, runtime ID, and storage schema should be recorded together before production deployment.
