// Copy outside the repository, tailor to YOUR isolated synthetic app, then hash/review before the run.
// This example targets the current first-app notes UI. Enrollment is completed by the operator beforehand.
// It never signs in, enrolls, deploys, creates an app, performs a model turn, or inspects real user data.
export async function ready({ page }) {
  await page.locator('#connect:enabled').click({ timeout: 15000 });
  await page.locator('#editor:enabled').waitFor({ timeout: 30000 });
}
export async function settle({ page }) {
  // Called only on residency transitions, before the idle clock starts. Replace with an event-driven
  // connected/replication-ready barrier if your app needs one. No recurring health checks.
  if (page) await page.locator('#editor:enabled').waitFor({ timeout: 30000 });
}
export async function reconnect({ page, signal }) {
  signal.throwIfAborted();
  // Trigger an actual transport disconnect/reconnect, rather than mistaking an unchanged DOM for recovery.
  await page.locator('#close:enabled').click({ timeout: 10000 });
  await page.locator('#connect:enabled').click({ timeout: 10000 });
  await page.locator('#editor:enabled').waitFor({ timeout: 10000 });
  return true;
}
// Set each to true ONLY after instrumenting the complete path. The default reports null, not zero.
export async function audit() { return { modelTurns: false, wakeups: false }; }
// Optional event-driven external instrumentation (no timers / health polls):
// export async function observe({ record, signal }) { ... }
// record({source:'adapter',kind:'modelTurns',count:1}) at actual dispatch;
// record({source:'adapter',kind:'wakeups',count:1}) at actual native notification handling.
