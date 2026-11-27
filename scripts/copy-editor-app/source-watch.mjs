import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { NODE_PREVIEW_PLUGINS, SITE_PREVIEW_ENTRY_SOURCE } from './build.mjs';

const WATCHED_EXT_RE = /\.(?:ts|tsx|js|mjs|cjs|json|css|html|svg|png|webp)$/i;
const IGNORED_SEGMENT_RE = /(?:^|\/)(?:dist|node_modules|\.git)(?:\/|$)/;
const IGNORED_TEMP_RE = /(?:\.sw[opx]|~|\.tmp|\.bak|\.part|\.DS_Store)$/i;
const GENERATED_FILES = new Set([
  'server/src/runtime-release.json',
  'server/src/release-changelog.json',
]);

function briefError(err) {
  const raw = String(err?.message ?? err ?? 'unknown error').trim();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const picked = lines.find((l) => /fail|error|assert/i.test(l)) ?? lines[0] ?? 'unknown error';
  return picked.length > 220 ? `${picked.slice(0, 217)}...` : picked;
}

export function shouldWatchCopyEditorFilename(filename) {
  if (!filename) return true;
  const normalized = String(filename).replaceAll('\\', '/');
  if (IGNORED_SEGMENT_RE.test(normalized) || IGNORED_TEMP_RE.test(normalized)) return false;
  if (normalized.endsWith('runtime-release.json') || normalized.endsWith('release-changelog.json')) return false;
  return WATCHED_EXT_RE.test(normalized);
}

function collectFilesRecursive(dir, { skipDirs = new Set(['dist', 'node_modules', '.git']) } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(join(cur, entry.name));
      } else if (entry.isFile()) {
        out.push(join(cur, entry.name));
      }
    }
  }
  return out;
}

/**
 * Computes a deterministic SHA-256 fingerprint over:
 *  - Every real repo file in the esbuild dependency graph of `SITE_PREVIEW_ENTRY_SOURCE`
 *    (so edits to unrelated server files do not trigger redundant copy-editor publishes)
 *  - All source files in `scripts/copy-editor-app/` (excluding `dist/` and `source-watch.mjs`)
 *  - Brand assets in `server/public/_tendril/brand/`
 *
 * Throws if `SITE_PREVIEW_ENTRY_SOURCE` fails to bundle (e.g. a syntax/import error mid-edit).
 */
export async function computeCopyEditorFingerprint({ repoRoot, bundle }) {
  const result = await bundle({
    stdin: {
      contents: SITE_PREVIEW_ENTRY_SOURCE,
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: NODE_PREVIEW_PLUGINS,
  });

  const filePaths = new Set();
  for (const inputPath of Object.keys(result.metafile?.inputs ?? {})) {
    if (inputPath.includes(':') || inputPath.startsWith('<')) continue;
    const abs = resolve(repoRoot, inputPath);
    const rel = relative(repoRoot, abs).replaceAll('\\', '/');
    if (GENERATED_FILES.has(rel)) continue;
    if (existsSync(abs)) filePaths.add(abs);
  }

  for (const file of collectFilesRecursive(join(repoRoot, 'scripts/copy-editor-app'))) {
    if (file.endsWith('/source-watch.mjs') || file.endsWith('\\source-watch.mjs')) continue;
    if (shouldWatchCopyEditorFilename(file)) filePaths.add(file);
  }

  const hash = createHash('sha256');
  const sorted = [...filePaths].sort((a, b) => relative(repoRoot, a).localeCompare(relative(repoRoot, b)));
  for (const abs of sorted) {
    const rel = relative(repoRoot, abs).replaceAll('\\', '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Debounced, serialized, pass-gated republisher.
 *
 * - Coalesces bursts of file-change notifications using `debounceMs`.
 * - Serializes check/publish runs; notifications arriving mid-run schedule a single trailing pass.
 * - Skips verification and publish when the dependency fingerprint matches the last published fingerprint.
 * - Never publishes if `computeFingerprint()` or `verify()` fails; keeps the last published fingerprint
 *   unchanged so once the code passes again, the next change triggers a clean publish.
 */
export function createDebouncedRepublisher({
  debounceMs = 5000,
  computeFingerprint,
  readPublishedFingerprint = () => null,
  writePublishedFingerprint = () => {},
  verify,
  publish,
  log = () => {},
}) {
  let timer = null;
  let running = false;
  let pending = false;
  let closed = false;
  let lastReason = '';
  let lastFailedFingerprint = null;
  let inFlightPromise = null;

  function schedule(reason = 'change') {
    if (closed) return;
    lastReason = reason;
    if (running) {
      pending = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runPass();
    }, debounceMs);
  }

  async function runPass() {
    if (closed) return { outcome: 'closed' };
    if (running) {
      pending = true;
      return inFlightPromise;
    }
    running = true;
    const reason = lastReason;
    let outcome = 'skipped';

    const work = (async () => {
      try {
        let fingerprint;
        try {
          fingerprint = await computeFingerprint();
        } catch (err) {
          outcome = 'fingerprint_failed';
          log(`[copy-editor watch] Skipping republish (${reason}): bundle check failed — ${briefError(err)}`);
          return { outcome, error: err };
        }

        if (closed) return { outcome: 'closed' };

        const alreadyPublished = await readPublishedFingerprint();
        if (alreadyPublished && fingerprint === alreadyPublished) {
          lastFailedFingerprint = null;
          outcome = 'unchanged';
          return { outcome, fingerprint };
        }
        if (lastFailedFingerprint && fingerprint === lastFailedFingerprint) {
          outcome = 'already_failed';
          return { outcome, fingerprint };
        }

        try {
          await verify({ fingerprint, reason });
        } catch (err) {
          lastFailedFingerprint = fingerprint;
          outcome = 'verify_failed';
          log(`[copy-editor watch] Skipping republish (${reason}): validation failed — ${briefError(err)}`);
          return { outcome, fingerprint, error: err };
        }

        if (closed) return { outcome: 'closed' };

        // Re-check right before publishing in case `--apply --republish` landed while verify ran.
        const latestPublished = await readPublishedFingerprint();
        if (latestPublished && fingerprint === latestPublished) {
          lastFailedFingerprint = null;
          outcome = 'unchanged';
          return { outcome, fingerprint };
        }

        const result = await publish({ fingerprint, reason });
        lastFailedFingerprint = null;
        await writePublishedFingerprint(fingerprint);
        outcome = 'published';
        const ver = result?.version ?? result?.receipt?.version;
        const pubId = result?.publicationId ?? result?.receipt?.publicationId;
        log(
          `[copy-editor watch] Republished${ver ? ` v${ver}` : ''}${pubId ? ` (${pubId})` : ''} after ${reason} — reload browser to see latest changes.`,
        );
        return { outcome, fingerprint, result };
      } catch (err) {
        outcome = 'publish_failed';
        log(`[copy-editor watch] Republish failed (${reason}) — keeping current published version: ${briefError(err)}`);
        return { outcome, error: err };
      } finally {
        running = false;
        inFlightPromise = null;
        if (pending && !closed) {
          pending = false;
          schedule('trailing change');
        }
      }
    })();

    inFlightPromise = work;
    return work;
  }

  return {
    notify(reason = 'change') {
      schedule(reason);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlightPromise) {
        await inFlightPromise;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return runPass();
    },
    close() {
      closed = true;
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    status() {
      return { running, pending, closed, scheduled: Boolean(timer) };
    },
  };
}

export function startCopyEditorSourceWatcher({
  repoRoot,
  bundle,
  debounceMs = 5000,
  readPublishedFingerprint,
  writePublishedFingerprint,
  verify,
  publish,
  log = (msg) => console.error(msg),
}) {
  const republisher = createDebouncedRepublisher({
    debounceMs,
    computeFingerprint: () => computeCopyEditorFingerprint({ repoRoot, bundle }),
    readPublishedFingerprint,
    writePublishedFingerprint,
    verify,
    publish,
    log,
  });

  const dirs = [
    join(repoRoot, 'server/src'),
    join(repoRoot, 'scripts/copy-editor-app'),
  ];
  const watchers = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const relDir = relative(repoRoot, dir).replaceAll('\\', '/');
    const w = watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!shouldWatchCopyEditorFilename(filename)) return;
      const target = filename ? `${relDir}/${String(filename).replaceAll('\\', '/')}` : relDir;
      republisher.notify(target);
    });
    w.on('error', (err) => {
      log(`[copy-editor watch] Watcher warning on ${relDir}: ${err.message}`);
    });
    watchers.push(w);
  }

  log(`[copy-editor watch] Watching server/src & scripts/copy-editor-app (debounce ${debounceMs}ms; pass-gated auto-republish enabled).`);

  return {
    notify: republisher.notify,
    flush: republisher.flush,
    status: republisher.status,
    close() {
      republisher.close();
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
    },
  };
}
