import {
  IndexedDbBytesStore,
  OpfsBytesStore,
  acquireBrowserStorageLock,
  inspectExistingIndexedDbRecords,
  inspectLegacyOpfsDirectory,
  probeIndexedDbBytesStore,
  probeOpfsWritable
} from "./chunk-NXL6QHAF.mjs";
import {
  assertCanonicalCbor
} from "./chunk-MAGRVNAE.mjs";
import {
  encodeCanonicalCbor
} from "./chunk-HYFY2E3E.mjs";

// packages/peer-session/src/browser-storage-selector.ts
var BACKEND_PIN = "peer-session/storage-backend/v1";
var STORAGE_OPENED = "peer-session/storage-opened/v1";
var STORAGE_BINDING = "peer-session/storage-binding/v1";
function decodePin(bytes) {
  let value;
  try {
    value = assertCanonicalCbor(bytes);
  } catch {
    throw new Error("BROWSER_STORAGE_BACKEND_PIN_INVALID");
  }
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== 1n || value[1] !== "opfs" && value[1] !== "indexeddb") throw new Error("BROWSER_STORAGE_BACKEND_PIN_INVALID");
  return value[1];
}
async function openSelectedBrowserStorage(name, metadata) {
  if (typeof navigator === "undefined" || navigator.storage?.getDirectory === void 0) {
    const preflightPin = await metadata.get(BACKEND_PIN);
    if (preflightPin !== null && decodePin(preflightPin) === "opfs") {
      throw new Error("BROWSER_DURABLE_STORAGE_UNAVAILABLE");
    }
  }
  const lock = await acquireBrowserStorageLock(name);
  try {
    let root;
    const opfsRoot = async () => {
      if (typeof navigator === "undefined" || navigator.storage?.getDirectory === void 0) {
        throw new Error("BROWSER_DURABLE_STORAGE_UNAVAILABLE");
      }
      return root ??= await navigator.storage.getDirectory();
    };
    const opened = await metadata.get(STORAGE_OPENED);
    const oldPin = await metadata.get(BACKEND_PIN);
    let backend;
    let verifiedOpfs = false;
    if (oldPin !== null) backend = decodePin(oldPin);
    else {
      let candidate;
      const hasIndexedDb = await inspectExistingIndexedDbRecords(name).catch((error) => {
        throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS", { cause: error });
      });
      if (hasIndexedDb) throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS");
      if (opened !== null) candidate = "opfs";
      else if (await inspectLegacyOpfsDirectory(name, await opfsRoot().catch((error) => {
        throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS", { cause: error });
      }))) {
        try {
          const directory = await (await opfsRoot()).getDirectoryHandle("chronolog-" + name);
          const legacy = new OpfsBytesStore(directory);
          try {
            if (await legacy.get(STORAGE_BINDING) === null) throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS");
          } finally {
            await legacy.close();
          }
        } catch (error) {
          throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS", { cause: error });
        }
        candidate = "opfs";
      } else {
        verifiedOpfs = await probeOpfsWritable(await opfsRoot());
        if (verifiedOpfs) candidate = "opfs";
        else if (await probeIndexedDbBytesStore()) candidate = "indexeddb";
        else throw new Error("BROWSER_STORAGE_BACKEND_UNSUPPORTED");
      }
      await metadata.compareAndSwap(BACKEND_PIN, null, encodeCanonicalCbor([1n, candidate]));
      const persisted = await metadata.get(BACKEND_PIN);
      if (persisted === null) throw new Error("BROWSER_STORAGE_BACKEND_AMBIGUOUS");
      backend = decodePin(persisted);
    }
    const store = await (async () => {
      if (backend === "indexeddb") {
        if (typeof indexedDB === "undefined") throw new Error("BROWSER_STORAGE_BACKEND_UNSUPPORTED");
        return IndexedDbBytesStore.open(name, { create: opened === null });
      }
      const directoryRoot = await opfsRoot();
      if (!verifiedOpfs && !await probeOpfsWritable(directoryRoot)) throw new Error("BROWSER_STORAGE_BACKEND_UNSUPPORTED");
      let directory;
      try {
        directory = await directoryRoot.getDirectoryHandle("chronolog-" + name, { create: opened === null });
      } catch (error) {
        if (opened !== null && error instanceof DOMException && error.name === "NotFoundError") {
          throw new Error("APPLICATION_DATA_STORAGE_MISSING", { cause: error });
        }
        throw error;
      }
      return new OpfsBytesStore(directory);
    })();
    let closing;
    return { store, close() {
      return closing ??= (async () => {
        try {
          await store.close();
        } finally {
          await lock.close();
        }
      })();
    } };
  } catch (error) {
    await lock.close();
    throw error;
  }
}
export {
  openSelectedBrowserStorage
};
