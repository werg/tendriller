// Enumerate exact authored bytes for immutable upload and publication.
// Source files are never generated, rewritten or resolved through a catalog.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
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

export function shouldSkip(relPath) {
  const parts = relPath.split(/[\\/]/);
  return parts.some((p) => p.startsWith(".") || p === "node_modules") || ["_tendril", "_publications"].includes(parts[0]);
}

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (shouldSkip(rel)) continue;
      if (ent.isSymbolicLink()) throw new Error(`Refusing symlink in publication: ${rel}`);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(rel);
      else throw new Error(`Unsupported publication entry: ${rel}`);
    }
  };
  walk(dir);
  return out.sort();
}

function canonicalPath(path) {
  if (!path || path.normalize("NFC") !== path || path.length > 512 || path.startsWith("/") ||
      /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..") ||
      /^(?:_tendril|_publications)(?:\/|$)/.test(path)) throw new Error(`Unsafe publication path: ${path}`);
  return path;
}

// A merged publication keeps its current entry unless an explicit entry is given.
export function pack(target, { as, entry, merge = false, message, maxBytes = 5 * 1024 * 1024 } = {}) {
  const st = lstatSync(target);
  if (st.isSymbolicLink()) throw new Error("Refusing publication source symlink");
  const files = [];
  const add = (path, source) => {
    path = canonicalPath(path);
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-file publication entry: ${path}`);
    if (info.size > maxBytes) throw new Error(`Publication file exceeds the effective upload limit: ${path}`);
    const bytes = readFileSync(source);
    if (bytes.length > maxBytes) throw new Error(`Publication file exceeds the effective upload limit: ${path}`);
    files.push({ path, type: guessType(path), size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
  };
  if (st.isDirectory()) {
    const paths = listFiles(target);
    if (paths.length === 0) throw new Error(`nothing to upload in ${target}`);
    for (const path of paths) add(path, join(target, path));
    entry ??= merge ? undefined : "index.html";
  } else if (st.isFile()) {
    let name = as || basename(target);
    if (!as && /\.html?$/i.test(name)) name = "index.html";
    add(name, target);
    entry ??= merge ? undefined : name;
  } else throw new Error("Publication source must be a regular file or directory");
  if (entry !== undefined) {
    entry = canonicalPath(entry);
    if (guessType(entry) !== "text/html") throw new Error("Publication entry must be an HTML path");
    if (!merge && !files.some(file => file.path === entry))
      throw new Error(`${target} has no ${entry}; choose --entry or use --no-replace with an existing publication`);
  }
  return { files, merge, ...(entry === undefined ? {} : { entry }), ...(message === undefined ? {} : { message }) };
}
