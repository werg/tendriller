// Download and verify the exact public speech artifacts used by the Worker.
// Cached outside the repository; no Cloudflare account or credentials are needed.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const engine = "1a028f5a3972b67dd8d8752f882113d475e7ec4c";
const model = "ad73f1468dd5203791e0cc81d31544c553563645";
const files = [
  { name: "cactus.js", url: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.js`, sha: "bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc" },
  { name: "cactus.wasm", url: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.wasm`, sha: "4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6" },
  { name: "whistle.cact", url: `https://huggingface.co/Cactus-Compute/whistle/resolve/${model}/whistle.cact`, sha: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb" },
];
const dir = join(homedir(), ".cache", "tendriller-e2e", "speech-4.0.0");
await mkdir(dir, { recursive: true });
for (const file of files) {
  const target = join(dir, file.name);
  let bytes;
  try { bytes = await readFile(target); } catch { /* download below */ }
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha) throw new Error(`${file.name}: SHA-256 mismatch`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }
}
process.stdout.write(dir);
