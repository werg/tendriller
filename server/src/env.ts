// Worker environment. Owned by the server agent; voice.ts and push.ts import it.
export interface Env {
  TENDRIL: DurableObjectNamespace;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  AI?: { run(model: string, input: unknown): Promise<any> };
  PUBLIC_BASE: string;
  PAGE_HOST_MODE: "path" | "subdomain";
  PAGE_BASE_DOMAIN: string;
  CREATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  VOICE_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  VOICE_MODEL?: string;
}
