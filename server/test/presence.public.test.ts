import { expect, it } from "vitest";
import { computePresence, type PresenceFacts } from "../src/presence";

it("does not claim an idle agent is working after an API check-in", () => {
  const now = Date.now();
  const facts: PresenceFacts = { now, tokens: 1, lastCheckin: now,
    longPollHeld: false, webhook: false, scheduleMinutes: null,
    wakePendingSince: null, graceSeconds: 120, status: null, withheld: 0 };
  expect(computePresence(facts).state).toBe("away");
  expect(computePresence({ ...facts, longPollHeld: true }).state).toBe("listening");
  expect(computePresence({ ...facts, status: { state: "working", text: null, at: now } }).state).toBe("working");
  expect(computePresence({ ...facts, webhook: true }).state).toBe("listening");
  const done = { state: "done" as const, text: null, at: now };
  expect(computePresence({ ...facts, status: done }).state).toBe("done");
  expect(computePresence({ ...facts, now: now + 8001, status: done }).state).toBe("away");
});
