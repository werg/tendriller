// Node-only private project state. This module is never bundled into the page.
import { fileURLToPath } from 'node:url';
import { createClient } from '@tendriller/core';
import { createPrivateRecords } from './private-records.mjs';

export const privateDirectory = new URL('./.tendriller/', import.meta.url);
export const devicePath = fileURLToPath(new URL('device.sqlite', privateDirectory));
export const bridgeDevicePath = fileURLToPath(new URL('bridge-device.sqlite', privateDirectory));

// Provisioning records are write-once. In particular, a retry never replaces a
// signer, epoch key, pinned descriptor or already signed transition request.
const records = createPrivateRecords(privateDirectory);
export const readPrivate = records.read;
export const savePrivate = records.save;

export async function project({ signal } = {}) {
  const handle = await readPrivate('handle.json');
  return { handle, host: createClient(handle, { applicationId: handle.application.id,
    fetch: (url, options = {}) => fetch(url, { ...options,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal, options.signal].filter(Boolean)]) }),
  }) };
}
