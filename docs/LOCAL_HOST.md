# Test an application against a release locally

Use the supported `dev:host` command to run one immutable Tendriller release on
your own machine. It starts the release's packed Worker and public assets, an
isolated account/page database and object storage, and a synthetic owner login.
You can register a workspace agent, create, initialize, publish, pair and
connect an application before creating anything on your production host.

## 1. Start the selected release

Use Node 24, Git and npm. Clone the current Tendriller repository for the local
host runner and install its locked development dependencies. You do not need a
Cloudflare account, OAuth provider secrets, a Chronolog checkout, or a source
build of the release.

```sh
git clone https://github.com/werg/tendriller.git
cd tendriller
npm ci
npx playwright install chromium

# Set this to the FULL source commit from the selected source-<SHA> release
# or the selected service's /api/readiness build.sourceCommit.
TENDRILLER_RELEASE_SOURCE=659a75ba469f8940b84cc38293f40341149aff0e
TENDRILLER_DEV_STATE="$PWD/.tendriller-dev-host/$TENDRILLER_RELEASE_SOURCE"
npm run dev:host -- --release "$TENDRILLER_RELEASE_SOURCE" \
  --state "$TENDRILLER_DEV_STATE" --open
```

The example selects a published rc.17 source checkpoint. Choose the checkpoint
you intend to test; package version alone does not identify release bytes.
The runner accepts only a full 40-character source SHA. It downloads the public
manifest from that immutable source release, verifies the complete composition
and every artifact's size and SHA-256, then extracts the sealed deployment and
its matching first-app kit. Missing assets, mismatched identities or hashes, an
unsupported storage baseline, or an occupied port stop startup. There is no
fallback to `master` or a locally rebuilt Worker.

The command prints the source, version, composition ID, service origin, owner
email, local sign-in URL, kit directory, network preload path and state directory.
Keep it running. By default the service is `https://service.localhost:8790`;
`--port 8791` selects another unprivileged loopback port.

`--open` launches a separate retained Chromium profile. It maps only `.localhost`
names to this machine and trusts the local host certificate by its public-key
fingerprint, including requests made by Workers. It preserves the release's
separate service and page origins without requiring a hosts-file change or
binding privileged port 443. Use this Chromium window for local pages; an
ordinary browser window does not have its local port mapping and certificate
configuration. On Linux, install the browser's system dependencies if Playwright
reports they are missing. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an
already installed Chromium executable. `--open --headless` supports automation.

In the opened **Test account** page, select **Open test account**. The prefilled
token signs into the synthetic `owner@example.test` account. This exercises the
host's existing test-account session route, owner claim and permission review;
it does not contact GitHub or Google for OAuth. The local access token expires
after 24 hours. Restart the runner to renew it, then open the newly printed
sign-in link in the isolated Chromium window.

## 2. Copy the matching kit into a fresh workspace directory

In another terminal, set `TENDRILLER_DEV_STATE` to the **absolute state path**
printed by the runner. Use a separate new directory for the test workspace;
the runner recreates its extracted release directory when restarted.

```sh
TENDRILLER_DEV_STATE=/absolute/path/to/tendriller/.tendriller-dev-host/FULL_SOURCE_SHA
TENDRILLER_APP=/absolute/path/to/local-shared-notes
mkdir "$TENDRILLER_APP"
cp -R "$TENDRILLER_DEV_STATE/release/first-app/." "$TENDRILLER_APP/"
cd "$TENDRILLER_APP"

TENDRILLER_CORE_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('composition.json')).version")
TENDRILLER_SESSION_ARCHIVE=$(node -p "JSON.parse(require('fs').readFileSync('composition.json')).components.find(x=>x.role==='session').file")
npm install --ignore-scripts --save-exact \
  "./packages/tendriller-sdk-$TENDRILLER_CORE_VERSION.tgz" \
  "./packages/tendriller-tools-$TENDRILLER_CORE_VERSION.tgz" \
  "./packages/$TENDRILLER_SESSION_ARCHIVE"
npm install --save-dev --save-exact esbuild@0.28.2
```

The verified kit supplies SDK, tools and the events session; esbuild is the local
application bundler. To try an existing page's source, copy it into
`pages/<slug>/` of this fresh workspace. Keep your production workspace,
credentials and device storage in their original folder. A local workspace has a
different agent, signing key and application identities.

## 3. Register the agent, create, initialize and publish

The generated `local-network.mjs` is an opt-in Node preload. It supplies the
loopback DNS mapping, trusts only this host's certificate, and refuses nonlocal
HTTP/WebSocket requests. Enable it only for the application commands below, in a
shell where dependencies are already installed; Node child processes (npm
scripts, `tendril`) inherit it. Do not enable it while installing npm
dependencies or calling a remote provider.

```sh
export NODE_OPTIONS="--import $TENDRILLER_DEV_STATE/local-network.mjs"

npx tendril workspace init --service https://service.localhost:8790 \
  --owner owner@example.test --name local-agent
npm run page:new -- notes --template notes --name "Local shared notes"
npm run init -- notes
npm run build -- notes
```

Use the printed service origin if you selected another port. `workspace init`
performs the ordinary readiness check and registers one agent (one credential,
one signing key) for the synthetic owner; `page:new` creates the page, granted to
that agent. Retain the complete `.tendriller/` directory and the signed
publication operation ID. A retry in this same workspace resumes the same agent
and page. To try another release, use a separate host state directory and a
separate workspace directory.

## 4. Run the agent program, claim and pair the browser

In a second terminal with the same `NODE_OPTIONS`, start the workspace's one
long-running program and leave it running, then publish through it:

```sh
npm run agent
# in the first terminal:
npm run deploy -- notes
```

Open the `page_url` returned by `page:new` in the runner's Chromium window. Keep
its URL unchanged; the browser handles local port routing. Sign in to the local
test account first if necessary, claim the page (this also claims the agent), and
follow the normal browser connection flow. The running agent program stages the
browser's signed device proposal; the host approves it automatically and the page
connects by itself, without an approval screen.
The [build guide](BUILD_AN_APP.md) describes these normal connection steps.

Add a note in the browser. From another terminal in the same workspace
directory, verify the agent program can read it:

```sh
export NODE_OPTIONS="--import $TENDRILLER_DEV_STATE/local-network.mjs"
cd "$TENDRILLER_APP"
npx tendril --page notes query notes null
```

Also submit a native command and observe it in the browser, reload the browser,
and check that the original notes remain. Inspect the signed publication with
`npx tendril --page notes publication`. These checks exercise real host setup,
publication, browser enrollment and connected application state. A successful
server startup alone does not establish application connectivity.

## Review connected UX with realistic development data

Use this environment for the connected UX pass before asking the production
owner to sign in. Keep the selected sealed release and matching SDK/tools/session
archives together. The same application source runs with a separate local
agent, signer, browser profile and data; record that scope in the review.

Seed data through the real domain commands while the agent program runs.
For the unmodified Shared Notes kit, one retained example is:

```sh
export NODE_OPTIONS="--import $TENDRILLER_DEV_STATE/local-network.mjs"
cd "$TENDRILLER_APP"
npx tendril --page notes command addNote \
  '{"text":"A realistic local review note"}' --operation local-ux-note-1
```

Use stable operation IDs for exact retries. For an adapted domain, use its
declared commands and input rather than writing a fixture directly into storage.
Include long content, several records and an empty-data case. Confirm browser
and native reads observe the same applied changes.

In the runner's correctly configured Chromium profile, review the main flows
at **1440×900** and **390×844**. Capture before/after screenshots of arrival,
navigation, reading, editing and saved results; exercise keyboard focus, Back,
reload, loading and unavailable states. Preserve uncertain operations when
testing recovery. The [delivery flow matrix](AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable)
records the steps, selected publication and what changed.

This pass needs synthetic local account access, not production OAuth. It does
not verify the production account, Internet transports, optional providers or
physical phones. Complete and identify those remaining checks separately.

## Restart, offline release input and limits

Stop the agent program first, then stop the host with Ctrl-C. Restart the host
with the same source, state path and port; it retains D1, R2, Durable Object and
Chromium storage. Restart the same workspace using its retained `.tendriller/`
directory and current local preload. The state record pins the original release
manifest and service origin, so another release or port cannot silently reuse
that storage. After a forced crash, inspect the PID in `host.lock` and remove
only that lock if its process has exited. Do not clear application state to
resolve a lock.

For downloaded or locally prepared release assets, use:

```sh
npm run dev:host -- --release FULL_SOURCE_SHA \
  --artifacts /absolute/path/to/release-assets \
  --state /absolute/path/to/isolated-host --open
```

That directory must include `manifest.json`, every referenced artifact and
`tendriller-deployment.tgz`. The same identity and digest checks apply. To
prepare a candidate release from a clean checkpoint, follow
[development](DEVELOPMENT.md#checkpoints-and-releases); `npm run build` output
alone is not a sealed release. This mode uses the supplied manifest as its
trust source and does not establish that those bytes were publicly published.
After an online run, the verified downloads are retained under `STATE/downloads`
and can be supplied as `--artifacts` for an offline restart.

The release browser CI job runs
`node scripts/test-dev-host.mjs --artifacts /absolute/release-assets` against the
same sealed graph. It verifies browser test-account login, packed-SDK page
creation, owner claim, public assets and host/browser restart persistence. The
separate exact-kit first-app tests qualify signed publication and real native /
browser enrollment/key provisioning and application state exchange.

This runner supports the schema-11 source-release format. Its emulator is pinned
by the runner checkout's lockfile; it is a local compatibility test, not a claim
that the Cloudflare production runtime is identical. The packed host and public
assets run unchanged. The existing test-only WebSocket forwarding Worker wraps
the local emulator to avoid its known hibernating-socket TCP-close issue.
Authentication is synthetic. Live OAuth, account-linked ChatGPT MCP, Internet
NAT traversal and physical devices require their separate qualification routes.
The optional model/voice providers are not configured by this command.

The host listens only on `127.0.0.1`. The generated preload is for local testing;
do not ship it in application assets or use it for a production process.
Creating and publishing the tested app on a real host remains a separate
explicit step with that host's readiness, release and owner checks.
