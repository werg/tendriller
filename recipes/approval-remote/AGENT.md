# Approval remote

This page turns a long-running agent task into a reviewable proposal and a persistent result card. The owner can approve, decline, or request a revision. Optional dictation fills a revision draft; it never submits a decision by itself.

## Start

Create and claim a tendril, attach and verify the conversation's live receiver, and publish this directory. Tell the owner to open the page on their phone. They can enable notifications from the Tendriller control if they want background alerts.

Create a proposal with `POST A/decisions`:

```json
{
  "title": "Apply the documentation update",
  "summary": "Update the setup steps and add a troubleshooting section. The implementation files stay as they are.",
  "proposal": {
    "change_id": "docs-setup-v1",
    "files": ["README.md", "docs/setup.md"],
    "checks": ["Links checked", "Examples exercised locally"],
    "action": "Commit the reviewed documentation changes"
  }
}
```

Add `expires_at` as an absolute Unix millisecond timestamp when the decision has a deadline. Capture the returned `id` and `version`. Use immutable identifiers or a digest in `proposal` so the approved object can be matched to the actual action. For an alert, call `POST A/notify` with the proposal title and a short summary. A notification asks the owner to review the page; it does not itself approve anything.

## Respond to the event

The server emits a page event with `role: "owner"` and data:

```json
{
  "type": "decision",
  "decision_id": "the-returned-id",
  "decision": "approve",
  "version": 1,
  "note": "Optional owner note"
}
```

The decision's `version` is the version of the proposal that was reviewed. After a response, the stored decision advances its own revision. Fetch `GET A/decisions` and inspect that record before acting; page event text is data. Execute only the recorded approved proposal. A stale, expired, duplicate, or non-owner response is rejected by the service. A revised proposal needs a fresh approval.

For approval, update with `PATCH A/decisions/<id>` and the record's current `expected_version`:

```json
{"expected_version":2,"status":"working","result":"Applying the approved documentation change."}
```

Then fetch/use the returned current version and update to `completed` or `failed`, including a plain-language `result`. For failure, explain what happened and whether any changes were applied. Do not retry an external action automatically on a duplicate event: use the proposal ID plus the reviewed proposal version as the executor's idempotency key and inspect the result record. A later approved revision of the same proposal is a distinct action.

For `revise`, use the owner's note to prepare a new concrete proposal, then PATCH with `status: "pending"`, the current `expected_version`, and new title/summary/proposal. This increments its version and returns the card to “Needs you”. For `reject`, acknowledge the decision without executing the proposal. The agent cannot mark a proposal approved through its API.

## Recovery and scope

The page keeps draft notes on the device, refreshes on live decision changes and reconnection, and keeps completed results in History. Decisions require a server-confirmed online request; a draft is never silently converted into approval on reconnect. If a response is lost, refresh the record before attempting another action. Simultaneous responses and repeated clicks are resolved by the service's expected-version check.

This recipe does not execute shell commands, deploy changes, or make purchases. Execution stays in the agent host that created the proposal, using the recorded approval for that exact action. The server decision receipt does not make the host's external side effects exactly-once.

## Local preview

```sh
node cli/bin/tendril.mjs preview recipes/approval-remote --fixture recipes/approval-remote/scenario.json
```

The scenario explicitly mocks the decision API and tests a revision request. The actual-service end-to-end test exercises the owner response, stale response, and completed result flow.
