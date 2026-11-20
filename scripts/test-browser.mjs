// Shipping browser suites. The Worker suite covers the current public identity,
// signed publication coherence, origin isolation and explicit speech flow.
import { spawn } from "node:child_process";

const suites = [
  ["runtime/test/playwright.config.ts", "runtime.spec.ts"],
  ["runtime/test/tts/playwright.config.ts"],
  ["test/e2e/playwright.config.ts"],
  ["tools/preview/test/preview.playwright.config.ts"],
];
const failed = [];
for (const [config, ...files] of suites) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", config, ...files], { stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
  if (code) failed.push(config);
}
const starterCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', 'scripts/test/browser/starter-submission.test.mjs'], { stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
});
if (starterCode) failed.push('starter submission lifecycle');
if (failed.length) {
  console.error(`Browser suites requiring attention: ${failed.join(", ")}`);
  process.exitCode = 1;
}
