// Runtime tests: npx playwright test --config runtime/test/playwright.config.ts  (after npm run build)
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["runtime.spec.ts", "updates.spec.ts", "document-navigation.spec.ts", "transport-inspector.spec.ts", "inbox.spec.ts"],
  testIgnore: ["**/tts/**"],
  timeout: 30_000,
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  outputDir: "../../test-results/runtime",
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, ...devices["Desktop Chrome"], headless: true,
    trace: "retain-on-failure", screenshot: "only-on-failure" },
});
