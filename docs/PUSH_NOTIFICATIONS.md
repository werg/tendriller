# Web Push notifications

Tendriller uses standards-based Web Push (VAPID, encrypted payloads, and the
per-page service worker). A subscribed owner device can receive a notification
when there is **no page tab open**. No continuously running page JavaScript,
agent socket, or browser session is required to *receive* push; the agent or
timer does need to call the deployed service. Push services and operating
systems may delay or suppress delivery, so successful provider acceptance is
not a device-display guarantee.

## Provision the service

1. Create a long-lived VAPID key pair with `node scripts/vapid-keys.mjs`.
   Generate a separate pair for staging and production. Keep the private value
   outside the repository.
2. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` as secrets on the matching
   Cloudflare Worker. Set `VAPID_SUBJECT` to a monitored `mailto:` address (or
   HTTPS contact). The existing `scripts/set-secrets.mjs` installs these when
   they are provided in the environment, or use
   `npx wrangler secret put VAPID_PUBLIC_KEY --config server/wrangler.staging.jsonc`
   and repeat for the other two secrets and the production config.
3. Deploy the Worker and its runtime asset graph. On the authenticated agent
   API, `GET A/notify` should return `available: true`. A `false` value
   means the server has no working key configuration; do not prompt users to
   subscribe until it is set.
4. Open a published page **as an approved owner** on each device, using HTTPS.
   In the always-present Tendriller control, open **Settings and history →
   Device notifications**. Select **Allow agent alerts on this device** and
   approve the browser permission prompt. Once the server confirms registration,
   use **Send test notification**. Then close all tabs for the page and send a
   second notification from the agent to verify real background delivery.

On iPhone and iPad, install that page to the Home Screen and launch the
installed web app before opting in. Browsers require a user gesture to request
permission. Guest and display devices cannot subscribe on behalf of an owner.
Removing an owner device also removes its stored subscription. Revoking
notification permission in browser/OS settings prevents display; reopening the
page reconciles the subscription.

**Do not regenerate the VAPID keys on each deployment.** A changed key pair
requires previously subscribed devices to open the page again; the runtime
replaces their old subscriptions and registers them with the server. Every
page origin has its own service-worker registration and push subscriptions.

## Send from an agent or any authenticated code

`A` is the page-specific agent API from the creation response (for example,
`https://tendriller.dev/api/t/<page-id>`). Keep its bearer token private.

```sh
curl -fsS -H "Authorization: Bearer $TENDRIL_TOKEN" "$TENDRIL_API/notify"
# Check available, subscribed_devices, count, and quota before sending.
curl -fsS -X POST "$TENDRIL_API/notify" \
  -H "Authorization: Bearer $TENDRIL_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"title":"Decision needed","body":"Please review the result.","tag":"approval-42"}'
```

The existing `notify` MCP tool calls this same HTTP endpoint, and
`notification_status` calls `GET A/notify`. Contrib's CLI offers
`tendril notifications` and
`tendril notify "Decision needed" "Please review the result"`.
Use the optional `device` field to target one subscribed owner device;
`url` is the page location opened on click (the service worker rejects
out-of-scope/cross-origin targets), and `tag` groups repeated notifications.
The default click target is the page's own URL.

A normal response includes `sent` (accepted by push services), `failed`,
and per-device `deliveries` with HTTP status and `gone`. An empty result
typically means no owner device has opted in. `GET A/notify` is read-only
and does **not** consume the notification quota. Notification attempts are
limited to 20 per page per hour; the status endpoint reports what remains.
If a service returns 404 or 410, the stored subscription is discarded.
Application code should handle quota errors (429), unavailable server
configuration, and transient provider failures.

## Security, lifetime and diagnostics

- Only authenticated agent tokens may use the notification HTTP API or MCP.
  A page-device socket may register/unregister/test subscriptions only when
  authorized for the owner role; it cannot send arbitrary notification text.
- The service validates browser-submitted push endpoints as HTTPS public hostnames
  and checks the subscription encryption keys. Subscription endpoints and
  secrets never appear in `GET A/notify`. Do not put private application
  details in a notification title/body: they may appear on a locked screen.
- The service worker can receive encrypted pushes while the page is closed.
  Notification clicks only focus/open a page URL within that worker's own
  origin and scope.
- Notifications are best-effort delivery, not a durable job queue.
  Durable timers have their own bounded retry queue; for business-critical
  alerts, persist the task or decision in shared state as well. A provider
  success means *accepted*, not *read*.
- To diagnose: check `GET A/notify`; confirm permission and registration
  in the control; send a test while open; close the page and send via API;
  inspect per-device delivery statuses and device/OS notification settings.
  Browser private mode and aggressive battery settings can restrict background
  notifications.

For regression checks, use `npm run test:push`, the Worker server tests
(including notification readiness), and the Playwright control suite.
Real delivery must be verified on actual browser/OS push services in staging.
