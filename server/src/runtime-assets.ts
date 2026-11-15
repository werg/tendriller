import type { Env } from './env';
import { errorResponse } from './http';
import { sha256Hex } from './ids';

/** Immutable runtime objects persist in the existing service asset bucket across deployments. */
export async function runtimeAsset(env: Env, request: Request, id: string, path: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.'))
    return errorResponse(404, 'not_found');
  const pathname = `/_tendril/runtime/${id}/${path}`;
  const bundled = await env.ASSETS.fetch(new Request(new URL(pathname, request.url)));
  if (bundled.ok) {
    const response = new Response(request.method === 'HEAD' ? null : bundled.body, bundled);
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  }
  await bundled.body?.cancel();
  const stored = await env.FILES.get(`runtime/${id}/${path}`);
  if (!stored) return errorResponse(404, 'runtime_not_found', 'The runtime artifact is unavailable');
  const headers = new Headers({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: stored.httpEtag });
  stored.writeHttpMetadata(headers);
  return new Response(request.method === 'HEAD' ? null : stored.body, { headers });
}

/** Content-addressed optional resources are retained across runtime releases. */
export async function immutableAsset(env: Env, request: Request, id: string, name: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(name)) return errorResponse(404, 'not_found');
  const object = await env.FILES.get(`assets/${id}/${name}`);
  if (!object) return errorResponse(404, 'asset_not_found', 'The runtime resource is not installed');
  // Only the trusted resource installer can write this bucket namespace. It
  // verifies bytes before upload; browser consumers verify them again on use.
  const headers = new Headers({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: object.httpEtag });
  object.writeHttpMetadata(headers);
  if (request.method === 'HEAD') return new Response(null, { headers });
  // Verify executable JavaScript at the delivery boundary as importScripts has
  // no integrity option. WASM and models are also verified by their consumer.
  const type = headers.get('Content-Type') || 'application/octet-stream';
  let body: BodyInit = object.body;
  if (/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/.test(type)) {
    const bytes = await object.arrayBuffer();
    if (await sha256Hex(bytes) !== id) return errorResponse(503, 'integrity_mismatch', 'Runtime resource failed integrity verification');
    body = bytes;
  }
  return new Response(body, { headers });
}
