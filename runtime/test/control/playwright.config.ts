import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  outputDir: join(here, ".results"),
  globalSetup: join(here, "global-setup.ts"),
  timeout: 30000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
    permissions: ["camera", "microphone", "geolocation"],
    geolocation: { latitude: 52.52, longitude: 13.405 },
  },
});
