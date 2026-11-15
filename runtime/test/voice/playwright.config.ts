import { defineConfig } from "@playwright/test";

// Unit tests for the fast voice layer (runtime/src/voice). Run with:
//   npx playwright test --config runtime/test/voice/playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 20000,
  reporter: "list",
  outputDir: "../../../test-results/legacy-voice",
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, browserName: "chromium", headless: true,
    trace: "retain-on-failure", screenshot: "only-on-failure" },
});
