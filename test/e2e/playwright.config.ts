import { defineConfig, devices } from "@playwright/test";

const PORT = 8790;
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Pixel 7"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    permissions: ["camera", "microphone", "geolocation"],
  },
  webServer: {
    command: `rm -rf ../../.wrangler/state-e2e && npx wrangler dev --config ../../server/wrangler.jsonc --port ${PORT} --persist-to ../../.wrangler/state-e2e --var PUBLIC_BASE:http://localhost:${PORT}`,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
