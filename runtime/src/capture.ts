// Durable capture protocol. Public shapes are owned by the shared contract.
import type { BlobReference } from "../../contract/index.mjs";
export type { BlobReference, SendResult, CaptureOptions, CaptureResult, PendingCapture } from "../../contract/index.mjs";

/** Attach media to the original semantic input, preserving UI block value envelopes. */
export function captureData(data: Record<string, unknown>, path: string[] = [], blob: Pick<BlobReference, "id" | "url">): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(data));
  let target = result;
  for (const key of path) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError("Invalid capture dataPath");
    if (target[key] === undefined) target[key] = {};
    if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) throw new TypeError("Capture dataPath must identify an object");
    target = target[key];
  }
  target.blob = blob.id;
  target.url = blob.url;
  return result;
}
