# Propose companion release pins

The release planner reads one published core graph and writes a content-addressed
`tendriller-companion-release/v1` tuple. Dependent workflows and pin guards consume
`distribution/companion-release.json`; neither repeats the source literals.
The planner opens reviewed PRs. It never merges, publishes packages or deploys.

There are two stages:

1. **Published:** download the source-tagged core manifest and every asset using
   the ordinary bounded public-release verifier. Compare the manifest with the
   GitHub release asset digest (and, when supplied, the publisher's expected
   digest). Resolve the source tag, compare clean core/kernel commit trees with
   GitHub, and inspect the authenticated session archive's provenance and standard
   native dependency. Propose the Contrib tuple update.
2. **Qualified:** require that exact tuple on merged Contrib main, successful
   normal MAIN push runs for content, the seven-transport composition and native/
   browser collaboration, all jobs successful, and retained unexpired artifact
   IDs/digests. Propose the Chronolog CI companion references. Chronolog continues
   to package its own actual checkout; a workflow-only revision is never relabeled
   as the kernel embedded in the host.

The tuple records CI artifact digests supplied by GitHub; it does not claim to
download or independently reinterpret every Contrib report. Existing composition
validators and ordinary repository gates remain authoritative for those reports.
The core asset bytes **are** downloaded and verified. Trust is in the selected
repositories and authorized publisher, not in arbitrary user-supplied URLs or
self-declared checksums. Publication is an application-enforced immutable source
tag, not a claim that GitHub administrators cannot alter releases.

## Bootstrap once with existing owner authorization

Use the existing `gh` login and owner SSH Git access. No new PAT or App is required.
The one-time workflow bootstrap pushes an isolated temporary checkout through
existing SSH authorization (strict known-host checks, no force). This avoids
requiring an existing `gh` OAuth credential to gain `workflow` scope. The PR and
dispatch APIs use the existing login. Start with a dry run:

```sh
node scripts/companion-release/cli.mjs --check-auth
node scripts/companion-release/cli.mjs --source CORE_FULL_SHA \
  --automation-source OWNER_APPROVED_AUTOMATION_CORE_FULL_SHA \
  --manifest-sha256 PUBLISHER_MANIFEST_SHA256 --output /tmp/companion-proposal
```

Inspect `tuple.json` and `proposal.json`. Re-run the same command with
`--apply --auth-kind user` to open the Contrib bootstrap PR. Application always
reverifies the public graph; a stored plan cannot be submitted as an input.
Review and merge only after normal gates pass. Bootstrap adds the tuple selector,
guard and target-owned receiver workflow. The implementation remains only in
core. Each receiver sparse-checks out `scripts/companion-release/` and
`scripts/check-published-release.mjs` from `werg/tendriller` at the explicitly
owner-approved immutable automation source, with credentials unpersisted.
It uses only Node builtins and needs no npm install. Its CLI verifies its actual
clean checkout SHA and target repository/mode before any graph lookup or write.
The automation source pin is independent of the evolving product tuple; upgrades
require a reviewed receiver bootstrap PR. These files are installed by an
ordinary reviewed PR after the central automation implementation is merged.
Workflow/code
changes require owner or existing App authorization; a receiver token is allowed
to change **only** tuple data. Future implementation upgrades use another reviewed
owner-authorized bootstrap PR.

After Contrib MAIN push qualification is green, run the same core selection with
`--contrib-source MERGED_CONTRIB_FULL_SHA` and a separate output directory. Its
bootstrap PR installs the Chronolog receiver. The publisher, core consumer source,
kernel archive source and independent CI checkout retain separate identities.

The read-only auth probe reports readable repositories and any repository push
metadata. It deliberately reports proposal write authority as **unverified**;
those observations do not prove token contents/PR/workflow permissions. Existing
owner credentials can bootstrap; an already-installed selected-repository App
may use `--auth-kind app`. App bootstrap needs contents, pull-request and workflow
write permissions plus actions write for explicit qualification dispatch.

## Scheduled and manual operation without cross-repository credentials

Each dependent's `companion-release-receiver.yml` runs hourly or by
`workflow_dispatch`, with its **own** `GITHUB_TOKEN`: contents write to create a
branch, pull-requests write to open its PR, and actions write to dispatch that
repository's qualification workflows. The token cannot be used by this adapter
to write another repository or change executable files/workflows.

Contrib selects the exact core `master` commit; if its manifest is not published,
verification fails and no pin PR is opened. Chronolog selects the tuple from
merged Contrib main, then requires that main's exact push qualification. Thus
neither follows an unqualified diagnostic kernel nor guesses a future source.
Scheduled failure during publication/CI propagation is a blocked proposal, not a
passing release. Re-run after the prerequisite completes.

GitHub repositories must allow Actions to create pull requests. An authorized
owner can enable this once with existing credentials:

```sh
gh api --method PUT repos/werg/tendriller-contrib/actions/permissions/workflow \
  -F can_approve_pull_request_reviews=true
gh api --method PUT repos/werg/chronolog-db/actions/permissions/workflow \
  -F can_approve_pull_request_reviews=true
```

This setting permits PR creation; the receiver never approves reviews. Do not
relax branch protections or required checks. GitHub's current token semantics
can leave token-created PR runs awaiting approval. The receiver therefore
explicitly dispatches each existing readonly qualification workflow at its own
generated branch, observes the exact head SHA, and retains run IDs. Existing
queued/completed exact-head runs are reused. Failed CI stays failed; use the
normal rerun/review process. An accepted dispatch is never counted as a pass.

Dispatch the installed receiver with existing owner authorization:

```sh
gh workflow run companion-release-receiver.yml --repo werg/tendriller-contrib --ref main
gh workflow run companion-release-receiver.yml --repo werg/chronolog-db --ref main
```

Refs are full source SHAs inside the tuple. Workflow input overrides, when used
for independent qualification, must also be full SHAs. Checkout identity guards,
normal build/test jobs and Contrib path filters remain in place. The automation
never runs on `pull_request_target`, uses no supplied code/URLs, and never writes
default branches. Unknown workflow layouts, moved bases, edited/closed existing
PRs, missing artifacts, incomplete pagination, dirty provenance and mismatched
hashes stop the proposal rather than guessing.

Gallery deployment remains separate: restore the exact qualified MAIN CI artifact,
verify its bytes and wait for compatible production SDK readiness. A generated pin
PR grants no deployment authorization or production compatibility result.

## Test and audit

`node --test scripts/test/companion-release.test.mjs scripts/test/published-release.test.mjs`
is also wired into ordinary `test:ci` and the dedicated readonly automation CI.
Fixtures retain the actual workflow layouts at Contrib `4eb5a8a` and Chronolog
`c10f2748`; they do not select the next release. Tests execute generated selectors
and guards in temporary projects, test both proposal stages, model repository-token
scope and exact-head dispatch, and reject missing/mutated artifacts and gate proof.
Reports and public downloads belong in explicit temporary directories outside git.

GitHub references: [token-trigger behavior](https://docs.github.com/en/actions/concepts/security/github_token),
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
and [workflow permissions API](https://docs.github.com/en/rest/actions/permissions).
