import type { Server, Socket } from 'node:net';
export interface LocalIpcDescriptor {
  readonly version: 1;
  readonly transport: 'unix-socket' | 'windows-named-pipe' | 'loopback-tcp';
  readonly address?: string;
  readonly host?: '127.0.0.1';
  readonly port?: number;
  readonly token?: string;
  readonly pid?: number;
}
export declare function isWindows(): boolean;
export declare function resolveUnixSocketPath(root: string): string;
export declare function resolveWindowsPipePath(root: string): string;
export declare function isProcessAlive(pid: number): boolean;
export declare function ensurePrivateDirectory(path: string, create?: boolean): Promise<string>;
export declare function writePrivateJsonAtomic(root: string, name: string, data: unknown): Promise<void>;
export declare function readPrivateJson(root: string, name: string, maxBytes?: number): Promise<unknown>;
export declare function probeEndpointReachable(descriptor: LocalIpcDescriptor | null, timeoutMs?: number): Promise<boolean>;
export declare function acquireAtomicLock(root: string, options?: {
  readonly lockName?: string;
  readonly leaseTtlMs?: number;
  readonly maxStaleRetries?: number;
  readonly probeReachable?: (descriptor: LocalIpcDescriptor | null) => Promise<boolean>;
}): Promise<{ readonly lockPath: string; readonly lockId: string; release(): Promise<void> }>;
export declare function listenLocalIpc(root: string, onConnection: (socket: Socket) => void, options?: {
  readonly preferredTransport?: 'auto' | 'loopback-tcp';
}): Promise<{
  readonly server: Server;
  readonly descriptor: LocalIpcDescriptor;
  verifyLoopbackToken(presented: unknown): boolean;
  close(): Promise<void>;
}>;
export declare function connectLocalIpc(root: string): Promise<{ readonly socket: Socket; readonly descriptor: LocalIpcDescriptor }>;
