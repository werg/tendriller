// Runtime tests: npx playwright test --config runtime/test/playwright.config.ts  (after npm run build)
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["runtime.spec.ts", "real-server.spec.ts"],
  testIgnore: ["**/control/**", "**/push/**", "**/voice/**"],
  timeout: 30_000,
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], headless: true },
});
