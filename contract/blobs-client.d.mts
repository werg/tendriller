import type { BlobUploadStart, BlobUploadSession, BlobUploadCompletion, SharedFileHead, SharedFileSnapshot,
  SharedFileWrite, SharedFileDelete, PagePublicationWrite, PagePublicationRollback, BlobReference, WireContracts } from "./index.mjs";
export type BlobUploadData = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
export interface BlobUploadClient {
    start(body: BlobUploadStart, options?: { signal?: AbortSignal }): Promise<BlobUploadSession>;
    status(uploadId: string, options?: { signal?: AbortSignal }): Promise<BlobUploadSession>;
    put(uploadId: string, bytes: BlobUploadData, options?: { signal?: AbortSignal }): Promise<number>;
    complete(uploadId: string, options?: { signal?: AbortSignal }): Promise<BlobUploadCompletion>;
    cancel(uploadId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    upload(data: BlobUploadData, options?: { name?: string; type?: string; cid?: string; signal?: AbortSignal }): Promise<BlobUploadCompletion>;
}
export interface BlobTransferClient {
  blobs: BlobUploadClient & {
    info(blobId: string): Promise<BlobReference>;
    list(options?: { after?: string; limit?: number; signal?: AbortSignal }): Promise<{blobs: BlobReference[]; cursor: string | null}>;
    download(blobId: string, options?: { signal?: AbortSignal; range?: string; disposition?: "inline" | "attachment" }): Promise<Response>;
    pin(blobId: string, command: { cid: string; expected_generations: Record<string,string>; scope?: string; keep: boolean }): Promise<BlobReference>;
  };
  files: {
    snapshot(options?: { signal?: AbortSignal }): Promise<SharedFileSnapshot>;
    get(path: string, options?: { signal?: AbortSignal }): Promise<SharedFileHead>;
    history(path: string, options?: { signal?: AbortSignal }): Promise<{path: string; versions: SharedFileHead[]}>;
    changes(options?: { after?: number; limit?: number; signal?: AbortSignal }): Promise<{changes: WireContracts["fileChange"][]; cursor: number}>;
    put(body: SharedFileWrite): Promise<{file: SharedFileHead; cursor: number}>;
    delete(body: SharedFileDelete): Promise<{file: SharedFileHead; cursor: number}>;
  };
  publications: {
    list(): Promise<unknown>;
    get(version: number): Promise<unknown>;
    publish(body: PagePublicationWrite): Promise<{version: number; head_revision: number}>;
    rollback(body: PagePublicationRollback): Promise<{version: number; head_revision: number}>;
  };
}
export type BlobJsonRequest = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }, schema?: keyof WireContracts) => Promise<any>;
export type BlobRawRequest = (path: string, options?: { method?: string; body?: BlobUploadData; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
export function createUploadClient(json: BlobJsonRequest, raw: BlobRawRequest): BlobUploadClient;
export function createBlobClient(json: BlobJsonRequest, raw: BlobRawRequest): BlobTransferClient;
