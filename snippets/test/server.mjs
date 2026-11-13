// Tiny static server for snippet tests: serves snippets/ at /, a blank page, and a local
// copy of qrcode-generator at /vendor/qrcode.js (for tests that must not depend on the CDN).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 4791);
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".json": "application/json", ".png": "image/png" };

const BLANK = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>snippet test</title>
<style>body{margin:0;font:16px system-ui}</style></head><body><main id="app"></main></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" || url.pathname === "/blank.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(BLANK);
    }
    let file;
    if (url.pathname === "/vendor/qrcode.js") file = require.resolve("qrcode-generator"); // → dist/qrcode.js (the "require" export)
    else {
      file = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!file.startsWith(root)) throw new Error("outside root");
    }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`snippet test server on http://localhost:${port}`));
