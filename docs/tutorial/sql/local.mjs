// Node-only private project state. This module is never bundled into the page.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@tendriller/core';

export const privateDirectory = new URL('./.tendriller/', import.meta.url);
export const devicePath = fileURLToPath(new URL('device.sqlite', privateDirectory));
export const databasePath = fileURLToPath(new URL('materialized.sqlite', privateDirectory));

export async function readPrivate(name, optional = false) {
  try { return JSON.parse(await readFile(new URL(name, privateDirectory), 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

// Provisioning records are write-once. In particular, a retry never replaces a
// signer, epoch key, pinned descriptor or already signed transition request.
export async function savePrivate(name, value) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(new URL(name, privateDirectory), text, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(new URL(name, privateDirectory), 'utf8');
    if (existing !== text) throw Error(`Refusing to replace saved setup record ${name}; inspect the original setup.`);
  }
  return value;
}

// Losing the host handle never makes an existing signer or recovery journal a
// fresh application. Keep that state intact until the original handle is restored.
export async function requireFreshProject() {
  const files = await readdir(privateDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (files.length) {
    // Names are local diagnostic context, never a classification of safe-to-delete
    // state. Bound both their count and length, and quote/escape terminal controls.
    const names = files.sort().slice(0, 6).map(name => JSON.stringify(name.slice(0, 64) + (name.length > 64 ? '...' : ''))
      .replace(/[^\x20-\x7e]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
    const entries = `${names.join(', ')}${files.length > names.length ? `; ${files.length - names.length} more entries` : ''}`;
    throw Object.assign(Error(`This project retains setup or recovery state. Blocking directory entries (names only, shortened when needed): ${entries}. .tendriller/ is reserved for Tendriller-managed identity, setup and recovery state; application-specific local files belong in a separate gitignored directory. Inspect and restore or resume the original application; no replacement page creation was attempted. Use a separate empty project only for an explicitly new application.`), { code: 'setup_recovery_required' });
  }
}

export async function project({ signal } = {}) {
  const handle = await readPrivate('handle.json');
  return { handle, host: createClient(handle, { applicationId: handle.application.id,
    fetch: (url, options = {}) => fetch(url, { ...options,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal, options.signal].filter(Boolean)]) }),
  }) };
}
