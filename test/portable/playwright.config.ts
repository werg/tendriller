import { defineConfig } from "@playwright/test";

// Portable behavior is tested in real engines. Device prompts are covered by
// explicit granted/denied/unsupported fixtures; no physical hardware is implied.
export default defineConfig({
  testDir: ".", testMatch: "*.spec.ts", timeout: 45_000, workers: 2,
  fullyParallel: true, reporter: [["list"]], outputDir: "../../test-results/portable",
  use: { headless: true, viewport: { width: 390, height: 844 }, colorScheme: "light",
    trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined } } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
