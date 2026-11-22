import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: ["voice-controls.spec.ts", "local-wake-pipeline.spec.ts"], timeout: 30_000,
  fullyParallel: false, workers: 1, reporter: [["list"]],
  outputDir: "../../test-results/voice-controls",
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    // WebKit with an iPhone viewport exercises layout and touch. It is not a
    // physical iOS microphone, lock-screen, Siri, or Low Power Mode qualification.
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
