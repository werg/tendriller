import {
  DEFAULT_DECODE_LIMITS,
  assertCanonicalCbor,
  encodeCanonicalCbor,
  equalBytes,
  sha256,
  utf8
} from "./chunk-HYFY2E3E.mjs";

// packages/records/src/record-envelope.ts
var MAX_RECORD_VALUE_BYTES = 128 * 1024 * 1024;
var MAX_RECORD_ENVELOPE_BYTES = MAX_RECORD_VALUE_BYTES + 8192;
function assertRecordKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 4096) throw new Error("OPFS_KEY_INVALID");
}
async function recordFilename(key) {
  assertRecordKey(key);
  return "value-" + [...await sha256(utf8(key))].map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function encodeRecordValue(key, bytes) {
  assertRecordKey(key);
  if (bytes.length > MAX_RECORD_VALUE_BYTES) throw new Error("BYTES_STORE_VALUE_LIMIT");
  const raw = encodeCanonicalCbor([1n, key, bytes, await sha256(bytes)]);
  if (raw.length > MAX_RECORD_ENVELOPE_BYTES) throw new Error("BYTES_STORE_VALUE_LIMIT");
  return raw;
}
async function decodeRecordValue(key, raw, corruptionCode) {
  assertRecordKey(key);
  const entry = await decodeRecordEntry(raw, corruptionCode);
  if (entry.key !== key) throw new Error(corruptionCode);
  return entry.value;
}
async function decodeRecordEntry(raw, corruptionCode) {
  if (raw.length === 0 || raw.length > MAX_RECORD_ENVELOPE_BYTES) throw new Error(corruptionCode);
  try {
    const decoded = assertCanonicalCbor(raw, {
      ...DEFAULT_DECODE_LIMITS,
      maxBytes: MAX_RECORD_ENVELOPE_BYTES,
      maxBlobBytes: MAX_RECORD_VALUE_BYTES
    });
    if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== 1n || typeof decoded[1] !== "string" || !(decoded[2] instanceof Uint8Array) || !(decoded[3] instanceof Uint8Array) || !equalBytes(decoded[3], await sha256(decoded[2]))) throw new Error(corruptionCode);
    assertRecordKey(decoded[1]);
    return { key: decoded[1], value: decoded[2].slice() };
  } catch {
    throw new Error(corruptionCode);
  }
}

// packages/records/src/browser.ts
var OpfsBytesStore = class {
  #directory;
  #pending = Promise.resolve();
  #closing;
  #closed = false;
  constructor(directory) {
    this.#directory = directory;
  }
  async get(key) {
    assertRecordKey(key);
    return this.#enqueue(async () => {
      let file;
      try {
        file = await this.#directory.getFileHandle(await recordFilename(key));
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return null;
        throw error;
      }
      const raw = new Uint8Array(await (await file.getFile()).arrayBuffer());
      if (raw.length === 0) return null;
      return decodeRecordValue(key, raw, "OPFS_VALUE_CORRUPT");
    });
  }
  async put(key, input) {
    assertRecordKey(key);
    const bytes = input.slice();
    return this.#enqueue(async () => {
      const raw = await encodeRecordValue(key, bytes);
      const file = await this.#directory.getFileHandle(await recordFilename(key), { create: true });
      const writer = await file.createWritable();
      try {
        await writer.write(raw.slice().buffer);
        await writer.close();
      } catch (error) {
        try {
          await writer.abort();
        } catch {
        }
        throw error;
      }
    });
  }
  async *iterateEntries() {
    const entries = this.#directory.entries?.bind(this.#directory);
    if (entries === void 0) throw new Error("BYTES_STORE_ENUMERATION_UNSUPPORTED");
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    }), ready = new Promise((resolve) => {
      started = resolve;
    });
    const owner = this.#enqueue(async () => {
      started();
      await held;
    });
    await Promise.race([ready, owner]);
    try {
      const files = [];
      for await (const [name] of entries()) if (/^value-[0-9a-f]{64}$/u.test(name)) files.push(name);
      for (const name of files.sort()) {
        const file = await (await this.#directory.getFileHandle(name)).getFile();
        if (file.size !== void 0 && file.size > MAX_RECORD_ENVELOPE_BYTES) throw new Error("OPFS_VALUE_CORRUPT");
        const raw = new Uint8Array(await file.arrayBuffer());
        if (raw.length === 0) continue;
        const entry = await decodeRecordEntry(raw, "OPFS_VALUE_CORRUPT");
        if (await recordFilename(entry.key) !== name) throw new Error("OPFS_VALUE_CORRUPT");
        yield entry;
      }
    } finally {
      release();
      await owner;
    }
  }
  async delete(key) {
    assertRecordKey(key);
    const remove = this.#directory.removeEntry?.bind(this.#directory);
    if (remove === void 0) throw new Error("BYTES_STORE_DELETE_UNSUPPORTED");
    return this.#enqueue(async () => {
      try {
        await remove(await recordFilename(key));
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
      }
    });
  }
  close() {
    if (this.#closing !== void 0) return this.#closing;
    this.#closed = true;
    this.#closing = this.#pending.then(() => void 0);
    return this.#closing;
  }
  #enqueue(work) {
    if (this.#closed) return Promise.reject(new Error("OPFS_STORE_CLOSED"));
    const task = this.#pending.then(work);
    this.#pending = task.then(() => void 0, () => void 0);
    return task;
  }
};
function acquireBrowserStorageLock(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) return Promise.reject(new Error("BROWSER_STORAGE_NAME_INVALID"));
  if (typeof navigator === "undefined" || navigator.locks === void 0) {
    return Promise.reject(new Error("BROWSER_DURABLE_STORAGE_UNAVAILABLE"));
  }
  return new Promise((resolve, reject) => {
    const completed = navigator.locks.request("chronolog:" + name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (lock === null) {
        reject(new Error("BROWSER_STORAGE_IN_USE"));
        return;
      }
      let release;
      const held = new Promise((done) => {
        release = done;
      });
      let closing;
      resolve({ close() {
        if (closing !== void 0) return closing;
        release();
        closing = completed.then(() => void 0);
        return closing;
      } });
      await held;
    });
    void completed.catch(reject);
  });
}
async function inspectLegacyOpfsDirectory(name, providedRoot) {
  if (typeof navigator === "undefined" || navigator.storage?.getDirectory === void 0) {
    throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS");
  }
  try {
    const root = providedRoot ?? await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle("chronolog-" + name);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false;
      throw error;
    }
  } catch (error) {
    throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS", { cause: error });
  }
}
async function probeOpfsWritable(providedRoot) {
  if (typeof navigator === "undefined" || navigator.storage?.getDirectory === void 0) return false;
  const root = providedRoot ?? await navigator.storage.getDirectory();
  const fileName = "chronolog-probe-" + crypto.randomUUID();
  let created = false;
  try {
    const file = await root.getFileHandle(fileName, { create: true });
    created = true;
    if (typeof file.createWritable !== "function") return false;
    let writer;
    try {
      writer = await file.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotSupportedError") return false;
      throw error;
    }
    try {
      await writer.write(Uint8Array.of(23, 42));
      await writer.close();
    } catch (error) {
      try {
        await writer.abort();
      } catch {
      }
      throw error;
    }
    const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    if (bytes.length !== 2 || bytes[0] !== 23 || bytes[1] !== 42) throw new Error("BROWSER_OPFS_PROBE_FAILED");
    return true;
  } finally {
    if (created) try {
      await root.removeEntry(fileName);
    } catch {
    }
  }
}

// packages/records/src/indexeddb-bytes-store.ts
var TABLE = "values";
var STAGING = "checkpoint-staging";
var VERSION = 2;
var IndexedDbBytesStore = class _IndexedDbBytesStore {
  #database;
  #pending = Promise.resolve();
  #closing;
  #closed = false;
  #invalid;
  constructor(database) {
    this.#database = database;
    database.onversionchange = () => {
      this.#invalid = new Error("INDEXEDDB_STORE_VERSION_CHANGED");
      database.close();
    };
  }
  static open(name, { create = true } = {}) {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("BROWSER_STORAGE_BACKEND_UNSUPPORTED"));
    return new Promise((resolve, reject) => {
      let blocked = false, missing = false;
      const request = indexedDB.open("chronolog-data:" + name, VERSION);
      request.onupgradeneeded = (event) => {
        if (blocked) {
          request.transaction?.abort();
          return;
        }
        if (!create && event.oldVersion === 0) {
          missing = true;
          request.transaction?.abort();
          return;
        }
        if (!request.result.objectStoreNames.contains(TABLE)) request.result.createObjectStore(TABLE);
        if (!request.result.objectStoreNames.contains(STAGING)) request.result.createObjectStore(STAGING);
      };
      request.onerror = () => {
        reject(missing ? new Error("APPLICATION_DATA_STORAGE_MISSING") : request.error ?? new Error("INDEXEDDB_STORE_OPEN_FAILED"));
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error("INDEXEDDB_STORE_BLOCKED"));
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(new _IndexedDbBytesStore(request.result));
      };
    });
  }
  async get(key) {
    assertRecordKey(key);
    return this.#enqueue(async () => {
      const raw = await this.#transaction("readonly", (table) => {
        const request = table.get(key);
        return () => request.result;
      });
      if (raw === void 0) return null;
      if (!(raw instanceof Uint8Array) || raw.length > MAX_RECORD_ENVELOPE_BYTES) throw new Error("INDEXEDDB_VALUE_CORRUPT");
      return decodeRecordValue(key, raw, "INDEXEDDB_VALUE_CORRUPT");
    });
  }
  getMany(keys) {
    const captured = [...keys];
    if (captured.length > 128) return Promise.reject(new Error("BYTES_STORE_BATCH_LIMIT"));
    for (const key of captured) assertRecordKey(key);
    return this.#enqueue(async () => {
      const raw = await this.#transaction("readonly", (table) => {
        const requests = captured.map((key) => table.get(key));
        return () => requests.map((request) => request.result);
      });
      return Promise.all(raw.map(async (value, index) => {
        if (value === void 0) return null;
        if (!(value instanceof Uint8Array) || value.length > MAX_RECORD_ENVELOPE_BYTES) throw new Error("INDEXEDDB_VALUE_CORRUPT");
        return decodeRecordValue(captured[index], value, "INDEXEDDB_VALUE_CORRUPT");
      }));
    });
  }
  async put(key, input) {
    assertRecordKey(key);
    if (input.length > MAX_RECORD_VALUE_BYTES) return Promise.reject(new Error("BYTES_STORE_VALUE_LIMIT"));
    const bytes = input.slice();
    return this.#enqueue(async () => {
      const raw = await encodeRecordValue(key, bytes);
      await this.#transaction("readwrite", (table) => {
        table.put(raw, key);
        return () => void 0;
      });
    });
  }
  async putMany(entries) {
    if (entries.length === 0) return;
    if (entries.length > 128) return Promise.reject(new Error("BYTES_STORE_BATCH_LIMIT"));
    const staged = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      assertRecordKey(entry.key);
      if (entry.value.length > MAX_RECORD_VALUE_BYTES) return Promise.reject(new Error("BYTES_STORE_VALUE_LIMIT"));
      staged.set(entry.key, entry.value.slice());
    }
    return this.#enqueue(async () => {
      const encoded = [];
      for (const [key, value] of staged) encoded.push({ key, value: await encodeRecordValue(key, value) });
      await this.#transaction("readwrite", (table) => {
        for (const entry of encoded) table.put(entry.value, entry.key);
        return () => void 0;
      });
    });
  }
  async delete(key) {
    assertRecordKey(key);
    return this.#enqueue(() => this.#transaction("readwrite", (table) => {
      table.delete(key);
      return () => void 0;
    }));
  }
  async putAllIfEmpty(entries) {
    const captured = entries.map((entry) => ({ key: entry.key, value: entry.value.slice() }));
    const seen = /* @__PURE__ */ new Set();
    for (const entry of captured) {
      assertRecordKey(entry.key);
      if (entry.value.length > MAX_RECORD_VALUE_BYTES) throw new Error("BYTES_STORE_VALUE_LIMIT");
      if (seen.has(entry.key)) throw new Error("BYTES_STORE_DUPLICATE_KEY");
      seen.add(entry.key);
    }
    return this.#enqueue(async () => {
      const encoded = [];
      for (const entry of captured) encoded.push({ key: entry.key, value: await encodeRecordValue(entry.key, entry.value) });
      return this.#transaction("readwrite", (table) => {
        let initialized = false;
        const count = table.count();
        count.onsuccess = () => {
          if (count.result !== 0) return;
          for (const entry of encoded) table.add(entry.value, entry.key);
          initialized = true;
        };
        return () => initialized;
      });
    });
  }
  async *iterateEntries() {
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    }), ready = new Promise((resolve) => {
      started = resolve;
    });
    const owner = this.#enqueue(async () => {
      started();
      await held;
    });
    await Promise.race([ready, owner]);
    try {
      let after;
      for (; ; ) {
        const items = await this.#transaction("readonly", (table) => {
          const entries = [];
          let failure, bytes = 0;
          const request = table.openCursor(after === void 0 ? void 0 : IDBKeyRange.lowerBound(after, true));
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor === null) return;
            const key = cursor.key, raw = cursor.value;
            if (typeof key !== "string" || !(raw instanceof Uint8Array) || raw.length > MAX_RECORD_ENVELOPE_BYTES) {
              failure = new Error("INDEXEDDB_VALUE_CORRUPT");
              return;
            }
            entries.push({ key, value: raw });
            bytes += raw.length;
            if (entries.length < 64 && bytes < 1024 * 1024) cursor.continue();
          };
          return () => {
            if (failure !== void 0) throw failure;
            return entries;
          };
        });
        if (items.length === 0) break;
        for (const entry of items) {
          after = entry.key;
          yield { key: entry.key, value: await decodeRecordValue(entry.key, entry.value, "INDEXEDDB_VALUE_CORRUPT") };
        }
      }
    } finally {
      release();
      await owner;
    }
  }
  async entries() {
    const entries = [];
    for await (const entry of this.iterateEntries()) entries.push(entry);
    return entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
  putStreamIfEmpty(entries) {
    return this.#enqueue(async () => {
      const empty = await this.#transaction("readonly", (table) => {
        const count = table.count();
        return () => count.result === 0;
      });
      if (!empty) return false;
      const clear = () => this.#transaction("readwrite", (table) => {
        table.clear();
        return () => void 0;
      }, STAGING);
      await clear();
      try {
        for await (const entry of entries) {
          assertRecordKey(entry.key);
          const raw = await encodeRecordValue(entry.key, entry.value);
          await this.#transaction("readwrite", (table) => {
            table.add(raw, entry.key);
            return () => void 0;
          }, STAGING);
        }
        return await new Promise((resolve, reject) => {
          const tx = this.#database.transaction([TABLE, STAGING], "readwrite", { durability: "strict" });
          const table = tx.objectStore(TABLE), staging = tx.objectStore(STAGING);
          let initialized = false;
          const count = table.count();
          count.onsuccess = () => {
            if (count.result !== 0) return;
            initialized = true;
            const cursor = staging.openCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (entry === null) {
                staging.clear();
                return;
              }
              table.add(entry.value, entry.key);
              entry.continue();
            };
          };
          tx.oncomplete = () => resolve(initialized);
          tx.onabort = () => reject(tx.error ?? new Error("INDEXEDDB_RESTORE_FAILED"));
        });
      } finally {
        await clear();
      }
    });
  }
  close() {
    if (this.#closing !== void 0) return this.#closing;
    this.#closed = true;
    this.#closing = this.#pending.then(() => {
      this.#database.close();
    });
    return this.#closing;
  }
  #enqueue(work) {
    if (this.#closed) return Promise.reject(new Error("INDEXEDDB_STORE_CLOSED"));
    if (this.#invalid !== void 0) return Promise.reject(this.#invalid);
    const task = this.#pending.then(() => {
      if (this.#invalid !== void 0) throw this.#invalid;
      return work();
    });
    this.#pending = task.then(() => void 0, () => void 0);
    return task;
  }
  #transaction(mode, enqueue, name = TABLE) {
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = this.#database.transaction(name, mode, { durability: "strict" });
      } catch (error) {
        reject(error);
        return;
      }
      let value;
      try {
        value = enqueue(transaction.objectStore(name));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
        }
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        try {
          resolve(value());
        } catch (error) {
          reject(error);
        }
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("INDEXEDDB_TRANSACTION_ABORTED"));
      };
      transaction.onerror = () => {
      };
    });
  }
};
async function probeIndexedDbBytesStore() {
  if (typeof indexedDB === "undefined") return false;
  const name = "probe-" + crypto.randomUUID();
  let store;
  try {
    store = await IndexedDbBytesStore.open(name);
    await store.put("probe", Uint8Array.of(0, 255));
    await store.close();
    store = void 0;
    const reopened = await IndexedDbBytesStore.open(name);
    store = reopened;
    const bytes = await reopened.get("probe");
    if (bytes?.length !== 2 || bytes[0] !== 0 || bytes[1] !== 255) throw new Error("INDEXEDDB_PROBE_FAILED");
    return true;
  } finally {
    await store?.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("chronolog-data:" + name);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error("INDEXEDDB_PROBE_CLEANUP_FAILED"));
      };
      request.onblocked = () => {
        reject(new Error("INDEXEDDB_PROBE_CLEANUP_BLOCKED"));
      };
    });
  }
}
function inspectExistingIndexedDbRecords(name) {
  if (typeof indexedDB === "undefined") return Promise.resolve(false);
  if (typeof indexedDB.databases === "function") {
    return indexedDB.databases().then((databases) => databases.some((database) => database.name === "chronolog-data:" + name));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("chronolog-data:" + name);
    let absent = false;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        absent = true;
        request.transaction?.abort();
      }
    };
    request.onerror = () => {
      if (absent && request.error?.name === "AbortError") resolve(false);
      else reject(request.error ?? new Error("INDEXEDDB_INSPECTION_FAILED"));
    };
    request.onblocked = () => {
      reject(new Error("INDEXEDDB_INSPECTION_BLOCKED"));
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(true);
    };
  });
}

export {
  OpfsBytesStore,
  acquireBrowserStorageLock,
  inspectLegacyOpfsDirectory,
  probeOpfsWritable,
  IndexedDbBytesStore,
  probeIndexedDbBytesStore,
  inspectExistingIndexedDbRecords
};
