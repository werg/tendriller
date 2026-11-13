// Content-Type guessing by file extension.

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  weba: "audio/webm",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

export function guessType(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && TYPES[m[1].toLowerCase()]) || "application/octet-stream";
}

/**
 * Uses the given type unless it is absent or a client default, then guesses from the path.
 * Client defaults: application/octet-stream, application/x-www-form-urlencoded (curl --data),
 * and text/plain (fetch with a string body) when the extension says something more specific.
 */
export function resolveType(path: string, given: string | null | undefined): string {
  const g = (given ?? "").trim();
  const lower = g.toLowerCase();
  if (!g || lower.startsWith("application/octet-stream") || lower.startsWith("application/x-www-form-urlencoded")) return guessType(path);
  if (lower.startsWith("text/plain")) {
    const guess = guessType(path);
    return guess === "application/octet-stream" ? "text/plain; charset=utf-8" : guess;
  }
  return g;
}

export function isHtmlType(type: string): boolean {
  return /^text\/html\b/i.test(type);
}
