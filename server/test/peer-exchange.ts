import { api, req, type Handle } from './helpers';
/** Host-routing test helper only; application operation data never enters these endpoints. */
function route(operation: string, payload: unknown) {
  const [facet, action] = operation.split('/');
  if (facet === 'discovery' && ['read', 'advertise', 'withdraw'].includes(action ?? '')) return { path: 'peers/discovery', body: { action, ...(payload as object) } };
  if (facet === 'ephemeral' && action === 'invite') return { path: 'peers/invite', body: payload };
  if (facet === 'publication' && ['read', 'publish'].includes(action ?? '')) return { path: 'peers/publication', body: { action, ...(payload as object) } };
  throw Error('Use application/enrollment or a signed authority participant request explicitly');
}
export function peerApi(handle: Handle, operation: string, payload: unknown = {}): Promise<Response> {
  const value = route(operation, payload); return api(handle, 'POST', value.path, value.body);
}
export async function peerApiJson<T = any>(handle: Handle, operation: string, payload: unknown = {}): Promise<T> {
  const response = await peerApi(handle, operation, payload);
  if (!response.ok) throw Error(`${operation}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
export function peerOwnerApi(handle: Handle, operation: string, payload: unknown = {}): Promise<Response> {
  const value = route(operation, payload); return req(`${handle.page_url}_tendril/${value.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value.body) });
}
