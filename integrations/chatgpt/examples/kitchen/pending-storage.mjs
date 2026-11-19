/** A single recoverable command slot, serialized across same-origin tabs. */
export function createPendingStorage({ key, storage = globalThis.localStorage,
  locks = globalThis.navigator?.locks, now = Date.now, maxResolved = 100 } = {}) {
  if (typeof key !== 'string' || !key || !storage?.getItem || !storage?.setItem ||
      !Number.isSafeInteger(maxResolved) || maxResolved < 1) throw Error('ASSISTANCE_PENDING_STORAGE_REQUIRED');
  const clone = value => value === null ? null : structuredClone(value);
  function read() {
    const value = JSON.parse(storage.getItem(key) || 'null');
    // Preserve records from the original example; migration happens only in
    // the same lock used by every reservation and compare-and-clear.
    if (value === null || typeof value?.operationId === 'string') return {
      version: 1, pending: value, resolved: [],
      lastOperationId: value?.operationId ?? storage.getItem(`${key}:last-operation`),
    };
    if (value?.version !== 1 || !Array.isArray(value.resolved) ||
        !(value.pending === null || typeof value.pending?.operationId === 'string')) throw Error('ASSISTANCE_PENDING_RECORD_INVALID');
    return value;
  }
  function change(mutate) {
    if (typeof locks?.request !== 'function') throw Error('ASSISTANCE_CROSS_TAB_LOCK_UNAVAILABLE');
    return locks.request(`tendriller-pending:${key}`, { mode: 'exclusive' }, () => {
      const record = read(), result = mutate(record);
      // localStorage installs this whole value atomically. A quota/write error
      // leaves the previous slot intact and occurs before any command send.
      storage.setItem(key, JSON.stringify(record));
      return clone(result);
    });
  }
  return {
    load() { return clone(read().pending); },
    lastOperationId() { return read().lastOperationId; },
    resolved() { return clone(read().resolved); },
    reserve(pending) {
      return change(record => {
        if (record.pending && JSON.stringify(record.pending) !== JSON.stringify(pending)) throw Error('ASSISTANCE_PENDING_OPERATION_UNRESOLVED');
        record.pending = clone(pending); record.lastOperationId = pending.operationId;
        return record.pending;
      });
    },
    clear(operationId) {
      return change(record => {
        if (record.pending?.operationId !== operationId) return false;
        record.pending = null; return true;
      });
    },
    resolve(operationId, status) {
      if (!['abandoned', 'needsReapply'].includes(status)) throw Error('ASSISTANCE_OUTCOME_UNCERTAIN');
      return change(record => {
        if (record.pending?.operationId !== operationId) return false;
        if (record.resolved.length >= maxResolved) throw Error('ASSISTANCE_RESOLUTION_HISTORY_FULL');
        record.resolved.push({ pending: record.pending, status, resolvedAt: now() });
        record.pending = null; return true;
      });
    },
  };
}
