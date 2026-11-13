import { defineConfig } from "@playwright/test";

// Unit tests for the fast voice layer (runtime/src/voice). Run with:
//   npx playwright test --config runtime/test/voice/playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 20000,
  reporter: "list",
  use: { browserName: "chromium", headless: true },
});
