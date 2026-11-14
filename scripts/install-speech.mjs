// Pin and upload Whistle and its browser engine to an environment's R2 bucket.
// Usage: node scripts/install-speech.mjs <bucket> [--remote]
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const bucket = process.argv[2];
if (!bucket || !/^[a-z0-9-]+$/.test(bucket)) throw new Error("Pass an R2 bucket name");
const remote = process.argv.includes("--remote");
const engine = "1a028f5a3972b67dd8d8752f882113d475e7ec4c";
const model = "ad73f1468dd5203791e0cc81d31544c553563645";
const files = [
  { name: "cactus.js", url: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.js`,
    hash: "bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc", type: "text/javascript" },
  { name: "cactus.wasm", url: `https://huggingface.co/Cactus-Compute/cactus/resolve/${engine}/releases/4.0.0/wasm/cactus.wasm`,
    hash: "4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6", type: "application/wasm" },
  { name: "whistle.cact", url: `https://huggingface.co/Cactus-Compute/whistle/resolve/${model}/whistle.cact`,
    hash: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb", type: "application/octet-stream" },
];

const dir = await mkdtemp(join(tmpdir(), "tendriller-speech-"));
try {
  for (const file of files) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`Download ${file.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== file.hash) throw new Error(`${file.name}: SHA-256 mismatch`);
    const path = join(dir, file.name);
    await writeFile(path, bytes);
    const args = ["wrangler", "r2", "object", "put", `${bucket}/speech/4.0.0/${file.name}`, "--file", path,
      "--content-type", file.type, remote ? "--remote" : "--local"];
    execFileSync("npx", args, { stdio: "inherit" });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
