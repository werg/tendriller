// Node-only private state for the review fixture. It is never bundled into the signed page.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@tendriller/core';

export const privateDirectory = new URL('./.private/', import.meta.url);

export async function readPrivate(name, optional = false) {
  try { return JSON.parse(await readFile(new URL(name, privateDirectory), 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

// Records are write-once: a retry never replaces a signer, credential, setup intent or signed attempt.
export async function savePrivate(name, value) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(new URL(name, privateDirectory), text, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(new URL(name, privateDirectory), 'utf8') !== text) throw Error(`Refusing to replace retained review record ${name}.`);
  }
  return value;
}

// The only mutable record: a private event-export checkpoint, replaced atomically after each acknowledged step.
export async function replacePrivate(name, value) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const temporary = new URL(`${name}.${randomUUID()}.tmp`, privateDirectory);
  await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, new URL(name, privateDirectory));
  return value;
}

export async function project({ signal } = {}) {
  const handle = await readPrivate('handle.json');
  return { handle, host: createClient(handle, { applicationId: handle.application.id,
    fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal, options.signal].filter(Boolean)]) }) }) };
}
