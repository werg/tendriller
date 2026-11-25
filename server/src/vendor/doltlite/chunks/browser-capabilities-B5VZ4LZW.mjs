import {
  probeIndexedDbBytesStore,
  probeOpfsWritable
} from "./chunk-NXL6QHAF.mjs";
import "./chunk-HYFY2E3E.mjs";

// packages/peer-session/src/browser-capabilities.ts
async function ed25519() {
  try {
    const generated = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const exported = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
    const signer = await crypto.subtle.importKey("pkcs8", exported, "Ed25519", false, ["sign"]);
    const bytes = Uint8Array.of(1, 2, 3);
    return crypto.subtle.verify("Ed25519", generated.publicKey, await crypto.subtle.sign("Ed25519", signer, bytes), bytes);
  } catch {
    return false;
  }
}
async function x25519() {
  try {
    const first = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
    const second = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
    const publicRaw = await crypto.subtle.exportKey("raw", second.publicKey);
    const publicKey = await crypto.subtle.importKey("raw", publicRaw, "X25519", false, []);
    const bits = await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, first.privateKey, 256);
    return bits.byteLength === 32;
  } catch {
    return false;
  }
}
async function syncOpfsHandle() {
  if (typeof navigator === "undefined" || navigator.storage?.getDirectory === void 0 || typeof document !== "undefined") return false;
  const root = await navigator.storage.getDirectory();
  const name = "chronolog-sync-probe-" + crypto.randomUUID();
  let created = false;
  try {
    const file = await root.getFileHandle(name, { create: true });
    created = true;
    const method = file.createSyncAccessHandle;
    if (typeof method !== "function") return false;
    let handle;
    try {
      handle = await method.call(file);
      return true;
    } finally {
      handle?.close();
    }
  } finally {
    if (created) try {
      await root.removeEntry(name);
    } catch {
    }
  }
}
async function probeBrowserCapabilities() {
  const secureContext = globalThis.isSecureContext === true;
  const dedicatedWorker = typeof document === "undefined" && typeof self !== "undefined" && typeof self.postMessage === "function";
  const sharedWorker = typeof document === "undefined" && typeof self !== "undefined" && "onconnect" in self;
  const ownerWorker = dedicatedWorker || sharedWorker;
  const webLocks = typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
  const indexedSupported = typeof indexedDB !== "undefined";
  const wasm = typeof WebAssembly !== "undefined";
  const directory = typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
  const [ed, x] = await Promise.all([ed25519(), x25519()]);
  let idbWritable = false, opfsWritable = false, syncHandle = false, reason;
  try {
    if (indexedSupported) idbWritable = await probeIndexedDbBytesStore();
    if (directory) {
      opfsWritable = await probeOpfsWritable();
    }
  } catch (error) {
    reason = error instanceof Error ? error.name + ": " + error.message : String(error);
  }
  const backend = reason === void 0 && directory ? opfsWritable ? "opfs" : idbWritable ? "indexeddb" : null : null;
  const supported = secureContext && ownerWorker && webLocks && ed && x && idbWritable && backend !== null;
  const unavailable = reason ?? (!secureContext ? "Secure context required" : !ownerWorker ? "Dedicated or shared owner Worker required" : !webLocks ? "Web Locks unavailable" : !ed || !x ? "Required native WebCrypto algorithms unavailable" : !idbWritable ? "Writable IndexedDB is required for device metadata" : !directory ? "The OPFS directory must be inspectable before choosing a record backend" : backend === null ? "Neither durable record backend is writable" : void 0);
  let sqlError;
  if (directory && ownerWorker && wasm) {
    try {
      syncHandle = await syncOpfsHandle();
    } catch (error) {
      sqlError = error instanceof Error ? error.name + ": " + error.message : String(error);
    }
  }
  const eligible = ownerWorker && wasm && syncHandle;
  return {
    secureContext,
    dedicatedWorker,
    sharedWorker,
    indexedDb: { supported: indexedSupported, writable: idbWritable },
    webLocks,
    opfs: { directory, createWritable: opfsWritable, syncAccessHandle: syncHandle },
    crypto: { ed25519: ed, x25519: x },
    wasm,
    events: { supported, backend: supported ? backend : null, ...supported ? {} : { reason: unavailable ?? "Event prerequisites unavailable" } },
    sql: { apiEligible: eligible, qualified: false, reason: eligible ? "SQL/WASM application and VFS have not been qualified on this browser" : sqlError ?? "SQL/WASM requires an owner Worker, WebAssembly and OPFS sync access handles" }
  };
}
export {
  probeBrowserCapabilities
};
