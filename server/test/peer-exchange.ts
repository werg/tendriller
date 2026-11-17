import { api, inDO, req, type Handle } from './helpers';
import { selectedApplication } from '../src/application';
import { PARTICIPANT_PROTOCOL } from '../../contract/participant.mjs';

export function participantMessage(applicationId: string, operation: string, payload: unknown = {}) {
  const [facet, action] = operation.split('/');
  return { protocol: PARTICIPANT_PROTOCOL, applicationId, requestId: crypto.randomUUID(), facet, action, payload };
}
export async function participantPayload(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) return response;
  const envelope = await response.json() as { payload: unknown };
  return new Response(JSON.stringify(envelope.payload), { status: response.status, headers: response.headers });
}
export async function peerApi(handle: Handle, operation: string, payload: unknown = {}): Promise<Response> {
  const application = await inDO(handle.id, t => selectedApplication(t));
  const applicationId = application.id;
  return participantPayload(await api(handle, 'POST', 'peers/participant', participantMessage(applicationId, operation, payload)));
}
export async function peerApiJson<T = any>(handle: Handle, operation: string, payload: unknown = {}): Promise<T> {
  const response = await peerApi(handle, operation, payload);
  if (!response.ok) throw new Error(`${operation}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function peerOwnerApi(handle: Handle, operation: string, payload: unknown = {}): Promise<Response> {
  const selection = await inDO(handle.id, t => selectedApplication(t));
  return participantPayload(await req(`${handle.page_url}_tendril/peers/participant`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(participantMessage(selection.id, operation, payload)) }));
}
