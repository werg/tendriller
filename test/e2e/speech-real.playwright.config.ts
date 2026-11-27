import { defineConfig, devices } from "@playwright/test";

// The model test serves its own immutable assets across Chromium and Firefox. No OAuth, Worker, R2 or mic.
export default defineConfig({
  testDir: ".", testMatch: ["real-speech.spec.ts", "local-wake-real.spec.ts"], workers: 1, timeout: 180_000,
  reporter: [["list"]], outputDir: "../../test-results/speech-real",
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
