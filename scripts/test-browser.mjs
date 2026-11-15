// Shipping browser suites. The Worker suite covers the current public identity,
// host delivery and speech flow; obsolete anonymous/Workers-AI tests are excluded.
import { spawn } from "node:child_process";

const suites = [
  ["runtime/test/playwright.config.ts", "runtime.spec.ts"],
  ["runtime/test/control/playwright.config.ts"],
  ["runtime/test/push/playwright.config.ts"],
  ["runtime/test/tts/playwright.config.ts"],
  ["snippets/test/playwright.config.ts"],
  ["cli/test/preview.playwright.config.ts"],
  ["test/e2e/playwright.config.ts"],
  ["test/portable/playwright.config.ts", "--project=chromium"],
];
const failed = [];
for (const [config, ...files] of suites) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", config, ...files], { stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
  if (code) failed.push(config);
}
if (failed.length) {
  console.error(`Browser suites requiring attention: ${failed.join(", ")}`);
  process.exitCode = 1;
}
