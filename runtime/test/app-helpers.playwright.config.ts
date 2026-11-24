import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "app-helpers.spec.ts", timeout: 30_000,
  fullyParallel: false, workers: 1, reporter: [["list"]],
  outputDir: "../../test-results/app-helpers",
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined } } },
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 568 }, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined } } },
  ],
});
