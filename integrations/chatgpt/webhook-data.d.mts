export function callbackUrl(value: unknown): string;
export function webhookKey(value: unknown): Uint8Array;
export function signedHeaders(input: { id: string; subscriptionId: string; body: string; secrets: string[]; now?: number }): Record<string, string>;
export function verifyCallback(input: {
  subscriptionId: string; url: string; secret: string; now?: number; signal?: AbortSignal;
  send(url: string, options: { body: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number; body: string }>;
}): Promise<void>;
export function publicAddress(address: string): boolean;
export function deliveryDisposition(status: number): 'accepted' | 'gone' | 'retry' | 'failed';
