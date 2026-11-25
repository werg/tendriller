import { defineConfig, devices } from "@playwright/test";

const mediaArgs = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

export default defineConfig({
  testDir: ".",
  testMatch: ["call-room.spec.ts"],
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/call-room",
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
          args: mediaArgs,
        },
      },
    },
    {
      name: "phone",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 568 },
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
          args: mediaArgs,
        },
      },
    },
  ],
});
