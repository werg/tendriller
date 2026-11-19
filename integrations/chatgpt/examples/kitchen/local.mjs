// Node-only private project state. This module is never bundled into the page.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@tendriller/core';

export const privateDirectory = new URL('./.tendriller/', import.meta.url);
export const devicePath = fileURLToPath(new URL('device.sqlite', privateDirectory));
export const bridgeDevicePath = fileURLToPath(new URL('bridge-device.sqlite', privateDirectory));

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

export async function project({ signal } = {}) {
  const handle = await readPrivate('handle.json');
  return { handle, host: createClient(handle, { applicationId: handle.application.id,
    fetch: (url, options = {}) => fetch(url, { ...options,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal, options.signal].filter(Boolean)]) }),
  }) };
}
