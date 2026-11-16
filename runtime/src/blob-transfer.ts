import { assertValid, validate } from "../../contract/index.mjs";
import type { BlobReference, WireContracts } from "../../contract/index.mjs";
import { createUploadClient } from "../../contract/blobs-client.mjs";
import type { BlobRawRequest } from "../../contract/blobs-client.mjs";

export class BlobHttpError extends Error {
  constructor(public status: number, message: string, public code = "upload_failed") { super(message); }
}

/** Authenticated immutable transfer, without file or publication APIs in the kernel. */
export function createBrowserBlobs(base: string, deviceHeaders: () => Record<string, string>) {
  const url = (blobId: string) => new URL(base + `_tendril/blobs/${blobId}`, location.href).href;
  const reference = (blob: BlobReference): BlobReference => ({ ...blob, url: url(blob.id) });
  const raw: BlobRawRequest = async (path, { method = "GET", body, signal, headers = {} } = {}) => {
    const response = await fetch(base + "_tendril" + path, { method, body: body as BodyInit | undefined,
      signal, credentials: "same-origin", headers: { ...deviceHeaders(), ...headers } });
    if (!response.ok) {
      let error;
      try { error = (await response.json())?.error; } catch { /* HTTP status still determines retryability. */ }
      throw new BlobHttpError(response.status, error?.message || `Blob operation failed (${response.status})`, error?.code);
    }
    return response;
  };
  const json = async (path: string, { method = "GET", body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {}, schema?: keyof WireContracts) => {
    const response = await raw(path, { method, signal, ...(body === undefined ? {} : {
      body: new TextEncoder().encode(JSON.stringify(body)), headers: { "Content-Type": "application/json" },
    }) });
    // Body-stream interruptions are transport failures, even after HTTP headers
    // arrive. Only a complete but malformed JSON body is an invalid receipt.
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); }
    catch { throw new BlobHttpError(response.status, "The blob service returned a non-JSON response", "invalid_response"); }
    if (schema && validate(schema, value).length)
      throw new BlobHttpError(response.status, `The blob service response does not match ${schema}`, "invalid_response");
    return value;
  };
  const uploads = createUploadClient(json, raw);
  return {
    url,
    async upload(blob: Blob, name: string | undefined, cid: string): Promise<BlobReference> {
      const result = await uploads.upload(blob, { name, cid, type: blob.type || "application/octet-stream" });
      return reference(result.blob);
    },
    async pin(blobId: string, command: WireContracts["blobPin"]): Promise<BlobReference> {
      if (!/^b_[a-z2-7]{20}$/.test(blobId)) throw new TypeError("A blob ID is required");
      const result = await json(`/blobs/${blobId}/pin`, { method: "PUT", body: assertValid("blobPin", command) }, "blobMetadata");
      if (result.id !== blobId) throw new BlobHttpError(200, "The pin receipt does not match the original blob", "invalid_response");
      return reference(result);
    },
  };
}
