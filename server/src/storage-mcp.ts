/** MCP storage tools invoke the same authenticated service routes as HTTP. */
import { assertValid, RESOURCE_LIMITS, schemas } from "../../contract/index.mjs";
import { createUploadClient } from "../../contract/blobs-client.mjs";
import { HttpError } from "./http";
import type { Tool, InvokeToolRequest, ToolRequest } from "./mcp";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const version = { type: "integer", minimum: 1 };
const path = (value: string) => ({ path: value });
const id = encodeURIComponent;

function uploads(invoke: InvokeToolRequest) {
  const request = (resource: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}, binary = false) => {
    const url = new URL(resource, "https://tendril.internal");
    const spec: ToolRequest = { method: options.method || "GET", rest: url.pathname.slice(1),
      query: Object.fromEntries(url.searchParams), headers: options.headers };
    if (options.body !== undefined) {
      if (binary) spec.rawBody = options.body as BodyInit;
      else spec.body = options.body;
    }
    return invoke(spec);
  };
  return createUploadClient(async (resource, options, schema) => {
    const response = await request(resource, options);
    const value = await response.json() as any;
    if (!response.ok) throw new HttpError(response.status, value.error?.code || "transfer_failed", value.error?.message || "Upload failed");
    return schema ? assertValid(schema, value) : value;
  }, async (resource, options) => {
    const response = await request(resource, options, true);
    if (!response.ok) {
      const value = await response.json() as any;
      throw new HttpError(response.status, value.error?.code || "transfer_failed", value.error?.message || "Upload failed");
    }
    return response;
  });
}

export const STORAGE_TOOLS: Tool[] = [
  {
    name: "upload_text",
    description: "Upload exact UTF-8 authored text as one immutable blob. Supply a stable CID and reuse the same text/type/name after a lost reply. This reserves, transfers and verifies bytes through the public upload protocol; it does not publish or change a shared file. Use the public CLI or SDK for binary files.",
    inputSchema: object({ cid: schemas.uploadStart.properties.cid,
      text: { type: "string", maxLength: RESOURCE_LIMITS.blob_bytes },
      type: schemas.uploadStart.properties.type, name: schemas.uploadStart.properties.name }, ["cid", "text"]),
    async call(args, invoke) {
      const receipt = await uploads(invoke).upload(new TextEncoder().encode(args.text), {
        cid: args.cid, type: args.type ?? "text/plain", ...(args.name === undefined ? {} : { name: args.name }),
      });
      return Response.json(receipt);
    },
  },
  {
    name: "get_blob",
    description: "Read verified immutable blob metadata, including SHA-256, byte size, content type, URL and retention. Blob bytes use the authenticated HTTP or public CLI download protocol.",
    inputSchema: object({ id: schemas.blobId }, ["id"]),
    call: args => ({ method: "GET", rest: `blobs/${id(args.id)}/info` }),
  },
  {
    name: "list_blobs",
    description: "Read one bounded page of blob metadata ordered by blob ID. Pass the returned non-null cursor as after for the next page.",
    inputSchema: object({ after: schemas.blobId, limit: { type: "integer", minimum: 1, maximum: 1000 } }),
    call: args => ({ method: "GET", rest: "blobs", query: { limit: String(args.limit ?? 100), ...(args.after ? { after: args.after } : {}) } }),
  },
  {
    name: "pin_blob",
    description: "Keep or release a blob's explicit pin with the original CID and captured generation guards. Other retained references continue to protect their content.",
    inputSchema: object({ id: schemas.blobId, ...schemas.blobPin.properties }, ["id", ...schemas.blobPin.required]),
    call: ({ id: blobId, ...body }) => ({ method: "PUT", rest: `blobs/${id(blobId)}/pin`, body }),
  },
  {
    name: "list_shared_files", description: "Read the current shared-file snapshot and change cursor. These are references to immutable blobs, separate from published page files.",
    inputSchema: object({}), call: () => ({ method: "GET", rest: "file-refs/snapshot" }),
  },
  {
    name: "get_shared_file", description: "Read a shared-file head and its exact revision. A deleted path returns its tombstone revision and blob_id:null; only a never-created path is missing.",
    inputSchema: object({ path: schemas.filePath }, ["path"]), call: args => ({ method: "GET", rest: "file-refs", query: path(args.path) }),
  },
  {
    name: "shared_file_history", description: "Read the bounded retained revisions of a shared-file path.",
    inputSchema: object({ path: schemas.filePath }, ["path"]), call: args => ({ method: "GET", rest: "file-refs/history", query: path(args.path) }),
  },
  {
    name: "shared_file_changes", description: "Read bounded shared-file changes after an explicit observed cursor. Keep the returned cursor for continuation.",
    inputSchema: object({ after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["after"]),
    call: args => ({ method: "GET", rest: "file-refs/changes", query: { after: String(args.after), limit: String(args.limit ?? 100) } }),
  },
  {
    name: "write_shared_file", description: "Point a canonical shared-file path at an existing immutable blob using the observed revision, original CID and captured generation guards. A conflict requires a deliberate new operation.",
    inputSchema: schemas.fileWrite, call: body => ({ method: "PUT", rest: "file-refs", body }),
  },
  {
    name: "delete_shared_file", description: "Write a tombstone at the exact observed shared-file revision using original CID and generation guards. Retained history remains bounded by service policy.",
    inputSchema: schemas.fileDelete, call: body => ({ method: "DELETE", rest: "file-refs", body }),
  },
  {
    name: "list_publications", description: "Read the current/latest/healthy publications, retained versions and authoritative head revision before composing a publication command.",
    inputSchema: object({}), call: () => ({ method: "GET", rest: "publications" }),
  },
  {
    name: "get_publication", description: "Read one immutable publication's actual HTML entry and complete verified blob manifest.",
    inputSchema: object({ version }, ["version"]), call: args => ({ method: "GET", rest: `publications/${args.version}` }),
  },
  {
    name: "publish_publication", description: "Commit a complete, sorted manifest of already-uploaded blobs and an actual authored HTML entry. Requires the observed head revision, original CID and all captured guards for the whole publications namespace, including removed paths. Retry the exact command after a lost reply; do not recapture its head or generations.",
    inputSchema: schemas.publicationWrite, call: body => ({ method: "POST", rest: "publications", body }),
  },
  {
    name: "rollback_publication", description: "Select an explicit retained publication against the observed head revision, original CID and complete publication-generation guards.",
    inputSchema: schemas.publicationRollback, call: body => ({ method: "POST", rest: "publications/rollback", body }),
  },
];
