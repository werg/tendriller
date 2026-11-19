import type { Tendril } from '../../server/src/tendril';
import type { OAuthConfig } from '../../server/src/accounts/oauth-support';
interface Principal {
  id: string;
  issuer: string;
  expiresAt?: number;
  oauthGrantId?: string;
  scopes?: string[];
  requestSignal?: AbortSignal;
}
export function withWorkerAssistant<T>(t: Tendril, dependencies: {
  applicationId: string;
  oauth: OAuthConfig;
  auth: {
    authenticate(request: Request): Promise<Principal>;
    challenge(scopes?: string[], error?: string): string;
    metadata: Record<string, unknown>;
    metadataUrl: string;
  };
  authenticateOwner(request: Request): Promise<Principal | null>;
  authorizeAccountAccess(principal: Principal, applicationId: string): Promise<boolean>;
  authorizeOwner(principal: Principal, applicationId: string): Promise<boolean>;
  startCallback(generation: string, send: () => Promise<Response>): Promise<Response>;
  openSession(definition: unknown): (options?: { signal?: AbortSignal }) => Promise<unknown>;
}, work: (assistant: {
  handler(request: Request): Promise<Response>;
  active(): Promise<boolean>;
  drain(options: { observe: boolean; signal?: AbortSignal }): Promise<{ more: boolean; nextDue: number | null }>;
}) => Promise<T>): Promise<T>;
