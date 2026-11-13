import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Push agent tests: device rules and push availability, run against a bundled test entry.
// Run: npx playwright test --config runtime/test/push/playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: "list",
  outputDir: join(tmpdir(), "tendril-push-test-results"),
  use: { browserName: "chromium", channel: "chromium", headless: true, timezoneId: "UTC" }, // full Chromium: headless shell always reports Notification.permission "denied"
});
