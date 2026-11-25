// Node-only workspace state. This module is never bundled into a page.
// The kit folder is the workspace: tendriller.json, pages/<slug>/ and the private
// .tendriller/ created by `npx tendril workspace init`.
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkspace } from '@tendriller/tools/workspace';

export const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;

export function requireSlug(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw Object.assign(Error('Name the page with a slug of lowercase letters, digits and dashes, e.g. npm run init -- notes'), { code: 'page_slug_required' });
  return slug;
}
/** The slug of the page folder that contains `moduleUrl` (pages/<slug>/...). */
export const slugOf = moduleUrl => basename(dirname(fileURLToPath(moduleUrl)));

export async function workspace() { return openWorkspace({ root: workspaceRoot }); }

/** Everything a page's Node modules need: its page client, private records and a
 * device opened with the workspace's one shared signing key. */
export async function pageContext(slug, options) {
  return (await workspace()).pageContext(requireSlug(slug), options);
}

// A page folder that already holds files is not evidence of a fresh page. Retained
// source, build output or a checkpoint belongs to an existing application.
export async function requireEmptyPageFolder(slug) {
  const folder = join(workspaceRoot, 'pages', requireSlug(slug));
  const files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (files.length) {
    // Names are local diagnostic context, never a classification of safe-to-delete state.
    const names = files.sort().slice(0, 6).map(name => JSON.stringify(name.slice(0, 64) + (name.length > 64 ? '...' : ''))
      .replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
    const entries = `${names.join(', ')}${files.length > names.length ? `; ${files.length - names.length} more entries` : ''}`;
    throw Object.assign(Error(`pages/${slug}/ already holds files (${entries}). Continue that page, or choose another slug for an explicitly new page; no page was created.`), { code: 'page_folder_not_empty' });
  }
  return folder;
}
