// Packs a directory (or one file) into the body of POST <api>/files.
// Text files go as UTF-8 strings, everything else as {base64, type}.
// Skips dotfiles/dot-directories, node_modules and the reserved _tendril/ prefix.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";

const TYPES = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".md": "text/markdown", ".webmanifest": "application/manifest+json", ".xml": "application/xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".pdf": "application/pdf", ".csv": "text/csv", ".geojson": "application/geo+json",
};

export function guessType(path) {
  return TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

export function isText(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return true; } catch { return false; }
}

export function shouldSkip(relPath) {
  const parts = relPath.split(/[\\/]/);
  return parts.some((p) => p.startsWith(".") || p === "node_modules") || parts[0] === "_tendril";
}

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (shouldSkip(rel)) continue;
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export function encodeFile(buf, path) {
  const type = guessType(path);
  if (isText(buf) && (type.startsWith("text/") || /json|xml|svg|javascript|markdown/.test(type) || type === "application/octet-stream")) {
    return buf.toString("utf8");
  }
  return { base64: buf.toString("base64"), type };
}

// Returns {files, replace, skipped?}. A single .html file is uploaded as index.html
// unless `as` is given. A directory push replaces the whole version unless merge.
export function pack(target, { as, merge = false, message } = {}) {
  const st = statSync(target);
  const body = { files: {} };
  if (st.isDirectory()) {
    const paths = listFiles(target);
    if (paths.length === 0) throw new Error(`nothing to upload in ${target}`);
    for (const p of paths) body.files[p] = encodeFile(readFileSync(join(target, p)), p);
    body.replace = !merge;
    if (!merge && !paths.includes("index.html")) throw new Error(`${target} has no index.html (use --no-replace to add files to the existing version)`);
  } else {
    let name = as || basename(target);
    if (!as && /\.html?$/i.test(name)) name = "index.html";
    body.files[name] = encodeFile(readFileSync(target), name);
  }
  if (message) body.message = message;
  return body;
}
