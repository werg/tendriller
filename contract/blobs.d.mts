export const blobIdSchema: Readonly<Record<string, unknown>>;
export const sha256Schema: Readonly<Record<string, unknown>>;
export const uploadIdSchema: Readonly<Record<string, unknown>>;
export const filePathSchema: Readonly<Record<string, unknown>>;
export const blobSchemas: Readonly<Record<string, Record<string, unknown>>>;
export function assertFilePath(path: unknown): string;
export function assertAttachments<T extends {blob_id: string; name?: string}>(attachments: T[]): T[];
export function assertPublicationEntries<T extends {path: string; blob_id: string}>(entries: T[], entry: string): T[];
