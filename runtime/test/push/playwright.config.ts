import { defineConfig } from "@playwright/test";
// Push agent tests: notification availability, run against a bundled test entry.
// Run: npx playwright test --config runtime/test/push/playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: true,
  reporter: "list",
  outputDir: "../../../test-results/push",
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, browserName: "chromium", channel: "chromium", headless: true, timezoneId: "UTC",
    trace: "retain-on-failure", screenshot: "only-on-failure" }, // full Chromium: headless shell always reports Notification.permission "denied"
});
