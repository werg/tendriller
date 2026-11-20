# Prepare the Tendriller directory review

The maintainer prepares and runs qualification, records the walkthrough and
provides a working sample. Do not assign testing or recording to the publisher.
Only portal access, publisher verification and required attestations need the
publisher when the maintainer cannot access that session.

Build the upload package with `node integrations/chatgpt/plugin/build.mjs`.
The result is `dist/tendriller-chatgpt-plugin.zip`. Its public publisher metadata
names Gabriel Pickard; select the corresponding verified identity in the portal.

## Automated live qualification and recording

Install Node 24, the qualified Codex CLI (`npm install --global
@openai/codex@0.170.0`), Chromium (`npx playwright install --with-deps chromium`)
and dependencies with `npm ci`. Build with `npm run build:artifacts`. With the
operator's Cloudflare deployment access and existing private account record, run:

```sh
npm run test:plugin:live -- \
  --access /private/path/test-access.json \
  --config server/wrangler.staging.jsonc \
  --output /private/path/review-evidence
```

Use the production config and its matching private account for production.
The command creates its own synthetic app, prepares signed UI before claim,
starts the participant, signs in with the static form, claims that prepared
publication, approves application access and completes real OAuth with PKCE.
It then connects an actual Codex app-server MCP client and exercises the six
positive and three negative packaged scenarios at the tool/protocol level.
It verifies reads, a write, exact retry, retained events, rejected operations,
signed publication and persistence after reload. Ambiguity is handled by the
deterministic test client without sending a write; this does not evaluate a
model's clarification behavior.

The output contains `report.json`, `verified-page.png` and `walkthrough.webm`.
The recording identifies the actual client. No model turn, model token usage or
change to the maintainer's saved MCP configuration is required. These results
verify the native client and service, **not ChatGPT web UI or natural-language
agent behavior**. Never relabel them as a ChatGPT conversation. The publisher's
successful ChatGPT connection can be recorded separately as reported evidence.

The fixture is deleted and its participant stopped after the test; an existing
reviewer sample is untouched. Production creation is never automatically opened
if paused. Staging can be opened briefly for fixture creation, with its mode
restored immediately. If cleanup fails, the private temporary project is retained
for operator recovery. `--no-video` explicitly skips recording for diagnostics.

[Native MCP live qualification](../../../.github/workflows/plugin-qualification.yml)
gates production promotion with a staging run, checks production after successful
master deployment, and runs on both environments weekly and on demand. Each environment supplies `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` and private `TENDRILLER_REVIEW_ACCESS_JSON`. Qualification
renews the same dedicated account for 90 days without rotating its code. Only
the allowlisted sanitized report, screenshot and video are uploaded. Missing
credentials fail qualification; they do not produce a passing result.

The [2026-11-20 production walkthrough](https://github.com/werg/tendriller/releases/download/v0.3.0-rc.11/tendriller-native-mcp-review-2026-11-20.mp4)
is a native-client recording from an actual passing run. New workflow artifacts
provide evidence for later deployments; this dated video is not a claim about
future versions or ChatGPT web behavior.

## Dedicated reviewer account

Provision a dedicated synthetic account:

```sh
node scripts/provision-test-access.mjs \
  --config server/wrangler.production.jsonc \
  --output /private/path/production-test-access.json --days 90
```

Use a different record for staging. Keep the record private. It contains the
synthetic `accountId`, expiry and reusable access code stored in its URL
fragment. The Worker stores only its hash. The same test-only account uses normal
sessions and application/OAuth approvals, with no upstream Google or GitHub
account required.

For reviewer instructions, give the **static** `https://tendriller.dev/auth/test`
URL and the reusable code **separately** in private Review details. Enter the
code in the password field and select **Open test account**. Reviewers do not
need a magic link, an email/SMS code, MFA, or maintainer approval. Never put the
access code in public docs, the ZIP, the recording or chat.

To extend access, rerun the provisioning command with `--renew --days 90` and
the same private output file. To revoke, use `--revoke`; it suspends the sample
account and revokes sessions and OAuth grants. Create a new record after
revocation; renewal does not unsuspend a revoked account.

## Persistent sample for reviewers

Automated qualification uses a disposable fixture. Separately keep a fresh
**Review checklist** sample available throughout directory review. Reviewers
share its state. The initial `checklist` query returns two incomplete items,
`check-labels` and `check-links`; the only command is `completeItem` with an
explicit item ID. There is no deletion or reset command.

Copy adjacent `review-app.mjs` and `review-domain.mjs` into a private directory.
Install the qualified public `@tendriller/core` and events-capable
`@chronolog/peer-session` archives there. Then:

1. Run `node review-app.mjs create /private/path/test-access.json`.
2. Run `node review-app.mjs init`, then `node review-app.mjs propose`, without
   waiting for claim. Retain the page and permission-review URLs.
3. Supervise `node review-app.mjs run` from that directory. It retains one native
   signer, reconnects, checkpoints forwarded events and publishes signed UI.
4. Sign in with the static test-account form. Open the already-prepared page;
   claim adopts its publication. Open the proposal URL and approve `checklist`,
   `completeItem` and `item.completed`. Verify the native signer is enrolled.
5. Verify listing, description and the initial read without sending a command.
   Use the disposable qualification fixture for the mutation and denial tests.

Do not delete this sample during qualification. Keep its native process and
private device store available throughout review; MCP and page residency do not
keep that participant running. Record the actual process supervisor, restart
command and machine lifetime in private Review details. The page's **Open the
latest snapshot** link opens the current signed snapshot after a command.
After reviewers complete Check labels, that state persists; create a fresh sample
for a later clean review rather than inventing a reset API.

## Portal sequence

1. Complete publisher verification at
   [Organization settings](https://platform.openai.com/settings/organization/general).
2. Upload the ZIP through **Upload new or existing plugin** at
   [Platform Plugins](https://platform.openai.com/plugins), selecting the verified
   identity and publishing project.
3. Open **MCPs → tendriller → Connect**. Verify it uses
   `https://tendriller.dev/mcp` and CIMD OAuth. If requested, give the operator the
   exact public domain challenge URL and token, verify its plain-text response,
   then complete linking with the dedicated test account.
4. Resolve metadata, skill and tool findings. In **Metadata & Skills → Review
   information → Review details**, enter the static login URL, separate code,
   sample name, participant availability and an accessible walkthrough URL.
   State which client the recording demonstrates and which checks were automated.
   Check the six positive and three negative procedures imported from plugin.json.
5. Submit and complete required publisher attestations. After approval, publish.
   Record the actual public install link in the setup guide and verify installation
   from an account outside the publisher's workspace when accessible.

OpenAI's [submission guide](https://developers.openai.com/plugins/deploy/submission)
defines the current review requirements. Do not claim directory submission,
publication or ChatGPT web testing without evidence of that action.
