import type { BlobUploadStart, BlobUploadSession, BlobUploadCompletion, SharedFileHead, SharedFileSnapshot,
  SharedFileWrite, SharedFileDelete, PagePublicationWrite, PagePublicationRollback, BlobReference } from "./index.mjs";
export type BlobUploadData = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
export interface BlobTransferClient {
  blobs: {
    start(body: BlobUploadStart, options?: { signal?: AbortSignal }): Promise<BlobUploadSession>;
    status(uploadId: string, options?: { signal?: AbortSignal }): Promise<BlobUploadSession>;
    put(uploadId: string, bytes: BlobUploadData, options?: { signal?: AbortSignal }): Promise<number>;
    complete(uploadId: string, options?: { signal?: AbortSignal }): Promise<BlobUploadCompletion>;
    cancel(uploadId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    upload(data: BlobUploadData, options?: { name?: string; type?: string; cid?: string; signal?: AbortSignal }): Promise<BlobUploadCompletion>;
    info(blobId: string): Promise<BlobReference>;
    list(): Promise<{blobs: BlobReference[]; cursor?: string | null}>;
    download(blobId: string, options?: { signal?: AbortSignal; range?: string; disposition?: "inline" | "attachment" }): Promise<Response>;
    pin(blobId: string, command: { cid: string; expected_generations: Record<string,string>; scope?: string; keep: boolean }): Promise<unknown>;
  };
  files: {
    snapshot(options?: { signal?: AbortSignal }): Promise<SharedFileSnapshot>;
    get(path: string, options?: { signal?: AbortSignal }): Promise<SharedFileHead>;
    history(path: string, options?: { signal?: AbortSignal }): Promise<{path: string; versions: SharedFileHead[]}>;
    put(body: SharedFileWrite): Promise<{file: SharedFileHead; cursor: number}>;
    delete(body: SharedFileDelete): Promise<{file: SharedFileHead; cursor: number}>;
    cleanup(body: SharedFileDelete): Promise<{file: SharedFileHead; cursor: number}>;
  };
  publications: {
    list(): Promise<unknown>;
    get(version: number): Promise<unknown>;
    publish(body: PagePublicationWrite): Promise<{version: number; head_revision: number}>;
    rollback(body: PagePublicationRollback): Promise<{version: number; head_revision: number}>;
  };
}
export function createBlobClient(
  json: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }, schema?: string) => Promise<any>,
  raw: (path: string, options?: { method?: string; body?: BlobUploadData; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>,
): BlobTransferClient;
