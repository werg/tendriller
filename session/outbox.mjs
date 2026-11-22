// Atomic pre-submission command outbox (W1) so lost responses across sandbox destruction
// can be reconciled by original operationId without duplicate side effects.
import { createHash } from 'node:crypto';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJsonAtomic } from './ipc.mjs';

const FILE = 'outbox.json';
const MAX_ENTRIES = 512;

function canonicalHash(value) {
  const text = JSON.stringify(value, (_k, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item);
  return createHash('sha256').update(text ?? 'null').digest('hex');
}

export async function createPersistentOutbox(directory) {
  const root = await ensurePrivateDirectory(directory, true);
  let tail = Promise.resolve();
  const serialize = fn => {
    const next = tail.then(fn, fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const load = async () => {
    const saved = await readPrivateJson(root, FILE, 2 * 1024 * 1024);
    if (saved === null) return [];
    if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.some(entry => !entry || typeof entry.operationId !== 'string'))
      throw Object.assign(new Error('Preserve the unrecognized outbox before retrying.'), {code:'OUTBOX_INVALID'});
    return saved.entries;
  };
  const save = entries => writePrivateJsonAtomic(root, FILE, { version: 1, entries });

  return Object.freeze({
    async record({ operationId, appId, deviceId, command, input }) {
      const payloadHash = canonicalHash({ command, input });
      return serialize(async () => {
        const entries = await load();
        const existing = entries.find(item => item.operationId === operationId);
        if (existing) {
          if (existing.payloadHash !== payloadHash || existing.appId !== appId || existing.deviceId !== deviceId) {
            throw Object.assign(new Error(`Outbox conflict: operationId ${operationId} already exists with different payload.`), {
              code: 'OUTBOX_OPERATION_CONFLICT',
            });
          }
          return existing;
        }
        if (entries.length >= MAX_ENTRIES) {
          const terminal = entries.findIndex(entry => ['applied', 'rejected'].includes(entry.status));
          if (terminal < 0) throw Object.assign(new Error('Resolve retained operations before submitting more commands.'), {code:'OUTBOX_FULL'});
          entries.splice(terminal, 1);
        }
        const entry = {
          operationId,
          appId,
          deviceId,
          command,
          payloadHash,
          status: 'recorded',
          createdAt: new Date().toISOString(),
        };
        entries.push(entry);
        await save(entries);
        return entry;
      });
    },
    async mark(operationId, status, detail = null) {
      return serialize(async () => {
        const entries = await load();
        const entry = entries.find(item => item.operationId === operationId);
        if (!entry) return null;
        entry.status = status;
        entry.updatedAt = new Date().toISOString();
        if (detail !== null) entry.detail = detail;
        await save(entries);
        return entry;
      });
    },
    async list({ pendingOnly = false } = {}) {
      const entries = await load();
      return pendingOnly ? entries.filter(e => !['applied', 'rejected'].includes(e.status)) : entries;
    },
    async get(operationId) {
      return (await load()).find(item => item.operationId === operationId) ?? null;
    },
  });
}
