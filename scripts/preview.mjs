// Persistent local preview for humans. Agent fixtures use `tendril preview`.
import { resolve } from "node:path";
import { watch } from "node:fs";
import { startServer } from "../cli/lib/preview.mjs";

const directory = resolve(process.argv[2] || "recipes/explore-device");
const server = await startServer(directory);
console.log(`Preview: http://127.0.0.1:${server.address().port}/`);
console.log("Production browser runtime; local protocol adapter. No external agent is attached.");
console.log("Edits are served immediately. Reload the browser after editing page files; npm run build:watch rebuilds runtime assets.");
const watcher = watch(directory, { recursive: true }, (_event, file) => {
  if (file && !String(file).startsWith(".")) console.log(`Changed ${file}; reload the preview to load it.`);
});
let stopped = false;
async function stop() { if (stopped) return; stopped = true; watcher.close(); await server.stopPreview(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
