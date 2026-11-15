// Download and verify the exact public speech artifacts used by the Worker.
// Cached outside the repository; no Cloudflare account or credentials are needed.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RUNTIME_RESOURCES } from "../runtime/resources.mjs";

const files = RUNTIME_RESOURCES;
const dir = process.env.TENDRIL_SPEECH_CACHE || join(homedir(), ".cache", "tendriller-e2e", "speech-4.0.0");
await mkdir(dir, { recursive: true });
for (const file of files) {
  const target = join(dir, file.name);
  let bytes;
  try { bytes = await readFile(target); } catch { /* download below */ }
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    process.stderr.write(`Downloading pinned ${file.name}\n`);
    const response = await fetch(file.source, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`${file.name}: SHA-256 mismatch`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }
  process.stderr.write(`Verified ${file.name}\n`);
}
process.stdout.write(dir);
