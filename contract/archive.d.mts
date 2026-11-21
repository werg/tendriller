export interface TarEntryInput {
  readonly path: string;
  readonly bytes: Uint8Array | string;
  readonly mode?: number;
  readonly mtime?: number;
}
export declare function packTarGz(entries: readonly TarEntryInput[], options?: { readonly mtime?: number }): Uint8Array;
export declare function unpackTarGz(compressedBytes: Uint8Array, options?: { readonly maxTotalBytes?: number; readonly maxEntries?: number }): Map<string, Uint8Array>;
export declare function listTarGz(compressedBytes: Uint8Array, options?: { readonly maxTotalBytes?: number; readonly maxEntries?: number }): string[];
export declare function readTarGzFile(compressedBytes: Uint8Array, targetPath: string, options?: { readonly maxTotalBytes?: number; readonly maxEntries?: number }): Uint8Array;
