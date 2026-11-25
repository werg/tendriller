// Source handoff uses the public archive helper. Private workspace state moves with `tendril checkpoint` (checkpoint.mjs).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { packTarGz } from '@tendriller/core/archive';

const encoder = new TextEncoder();

const EXCLUDED_DIRS = new Set(['.tendriller', '.git', 'node_modules', 'dist', '.results', 'page', 'state', 'data', '.state', '.data']);
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.md', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2']);
const SOURCE_JSON = /^(?:package(?:-lock)?|tsconfig(?:\.[A-Za-z0-9_-]+)?)\.json$/u;
const EXCLUDED_FILES = new Set(['.env', '.env.local', 'provider-secrets.json', 'provider-local.mjs']);
const SECRET_PATTERNS = [
  /\b(?:privateKey|secretKey|clientSecret|accessToken|refreshToken|apiKey)\b["']?\s*[:=]\s*["'][^"']{16,}["']/u,
  /ta_[a-z2-7]{32}/u,
  /td_a_[a-f0-9]{64}/u,
  /td_n_[a-f0-9]{64}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walkSourceFiles(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      walkSourceFiles(root, join(current, entry.name), out);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.') || EXCLUDED_FILES.has(entry.name) ||
          (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !SOURCE_JSON.test(entry.name))) continue;
      const full = join(current, entry.name);
      const rel = relative(root, full).replaceAll('\\', '/');
      out.push({ path: rel, full });
    }
  }
  return out;
}

/**
 * Pack non-secret project source files into a deterministic tar.gz handoff archive.
 * Verifies zero private keys, device stores, or agent tokens enter the archive.
 */
export function exportSourceHandoff(projectDir, outputPath, { nextCommand = 'tendril checkpoint restore FILE in an empty folder, unpack this archive there, npm ci, then tendril agent run' } = {}) {
  const root = resolve(projectDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw fail('handoff_source_missing', `Project directory not found: ${root}`);
  const destination = resolve(outputPath);
  const files = walkSourceFiles(root).filter(file => resolve(file.full) !== destination);
  const entries = [];
  let totalBytes = 0;
  for (const file of files) {
    const size = statSync(file.full).size;
    if (size > 16 * 1024 * 1024 || (totalBytes += size) > 64 * 1024 * 1024)
      throw fail('handoff_size_limit', 'Source handoff exceeds the 16 MiB file or 64 MiB total bound.');
    const bytes = readFileSync(file.full);
    const text = bytes.toString('utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        throw fail('handoff_secret_detected', `Refusing to pack private credential material found in ${file.path}.`);
      }
    }
    entries.push({ path: file.path, bytes });
  }
  const manifest = {
    format: 'tendriller-source-handoff-v1',
    createdAt: new Date().toISOString(),
    fileCount: entries.length,
    nextCommand,
    privateStatePolicy: 'known runtime state and secret files excluded; recognized credentials rejected',
    sourceReviewRequired: true,
    inclusionPolicy: 'Code, documentation, static assets and package/TypeScript manifests only. Review authored source for embedded credentials before sharing.',
  };
  entries.push({ path: 'handoff-manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2) + '\n') });
  const archive = packTarGz(entries);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, archive, { mode: 0o600 });
  return { output: destination, sha256: sha256Hex(archive), size: archive.byteLength, manifest };
}
