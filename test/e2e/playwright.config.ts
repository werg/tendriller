import { defineConfig } from "@playwright/test";
import { installLocalWorkerDns, LOCAL_WORKER_HOST_RULES } from "../../scripts/e2e-network.mjs";

// This config loads in both the runner (webServer readiness) and test workers
// (APIRequestContext); Chromium's resolver flag only covers browser requests.
installLocalWorkerDns();

export default defineConfig({
  testDir: ".",
  testMatch: ["assistant-inbox.spec.ts", "local.spec.ts", "speech.spec.ts", "real-speech.spec.ts", "tts-integration.spec.ts"],
  timeout: 45_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/e2e",
  use: {
    browserName: "chromium",
    baseURL: "https://service.localhost:8790",
    ignoreHTTPSErrors: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--host-resolver-rules=${LOCAL_WORKER_HOST_RULES}`] },
    permissions: ["camera", "microphone", "geolocation"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    cwd: "../..",
    url: "https://service.localhost:8790/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
