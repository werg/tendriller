import type { ParticipantRequest, ParticipantResponse, ParticipantExchangeOptions, ParticipantFacet } from './participant.mjs';
export * from './participant.mjs';
export interface PeerParticipantClient {
  exchange(request: ParticipantRequest, options?: ParticipantExchangeOptions): Promise<ParticipantResponse>;
  request<T = unknown>(facet: ParticipantFacet, action: string, payload: unknown, options?: ParticipantExchangeOptions): Promise<T>;
}
export declare function createPeerParticipantClient(options: {
  readonly applicationId?: string | (() => Promise<string>);
  readonly request: (path: string, options?: { method?: 'POST'; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
}): PeerParticipantClient;
