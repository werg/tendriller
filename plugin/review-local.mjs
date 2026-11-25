// Node-only workspace state for the review fixture. It is never bundled into the signed page.
// The fixture folder is one agent workspace (tendriller.json, .tendriller/): one account-level
// credential, one shared signing key, and this one page granted to that agent. All page records
// live in the workspace's private page folder; nothing here keeps a separate credential or signer.
import { rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openWorkspace } from '@tendriller/tools/workspace';
import { REVIEW_SLUG } from './review-setup.mjs';

export const workspaceRoot = fileURLToPath(new URL('./', import.meta.url));
export { REVIEW_SLUG };

const timed = signal => (url, options = {}) => fetch(url, { ...options,
  signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal, options.signal].filter(Boolean)]) });

export const workspace = ({ signal } = {}) => openWorkspace({ root: workspaceRoot, fetch: timed(signal) });

/** The public page context: page client, private records and the shared signer's device. */
export async function pageContext(options = {}) {
  return (await workspace(options)).pageContext(REVIEW_SLUG, options);
}

/** The only mutable record: a private event-export checkpoint, replaced atomically after each acknowledged step. */
export async function replacePrivate(context, name, value) {
  const path = context.privatePath(name), temporary = context.privatePath(`${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, path);
  return value;
}
