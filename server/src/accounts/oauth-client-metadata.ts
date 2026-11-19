import { readBody } from '../http';
import { reject, type OAuthClient } from './oauth-support';

/** Only fetch an exact, operator-approved CIMD URL. Client input cannot supply a destination. */
export async function validateClientMetadata(client: OAuthClient, redirectUri: string) {
  if (!client.metadataDocument) return;
  try {
    const signal = AbortSignal.timeout(3500);
    const response = await fetch(client.id, { redirect: 'manual', signal, headers: { Accept: 'application/json' } });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel();
      throw Error();
    }
    const bounded = new Request('https://client-metadata.invalid/', { method: 'POST', body: response.body, signal });
    const raw = await readBody(bounded, 16 * 1024, 3500);
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
    const methods = document.token_endpoint_auth_methods_supported ?? [document.token_endpoint_auth_method ?? 'none'];
    if (document.client_id !== client.id || !Array.isArray(document.redirect_uris) ||
      !document.redirect_uris.includes(redirectUri) || !Array.isArray(methods) || !methods.includes('none')) throw Error();
  } catch {
    reject('invalid_client', 'The registered client metadata did not verify', 400);
  }
}
