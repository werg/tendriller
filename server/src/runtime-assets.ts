import type { Env } from './env';
import { errorResponse } from './http';
import { assetResponse, immutableObject, type CacheContext } from './immutable-cache';

/** Immutable runtime objects persist in the existing service asset bucket across deployments. */
export async function runtimeAsset(env: Env, request: Request, id: string, path: string, context?: CacheContext): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.'))
    return errorResponse(404, 'not_found');
  const pathname = `/_tendril/runtime/${id}/${path}`;
  const headers = new Headers();
  for (const name of ['If-None-Match', 'If-Modified-Since', 'If-Range', 'Range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const bundled = await env.ASSETS.fetch(new Request(new URL(pathname, request.url), { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers }));
  if (bundled.ok || bundled.status === 304 || bundled.status === 416) {
    const response = new Response(bundled.body, bundled);
    response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  }
  await bundled.body?.cancel();
  const stored = await immutableObject(env, `runtime/${id}/${path}`, { head: request.method === 'HEAD', context });
  if (!stored) return errorResponse(404, 'runtime_not_found', 'The runtime artifact is unavailable');
  return assetResponse(request, stored);
}

/** Content-addressed optional resources are retained across runtime releases. */
export async function immutableAsset(env: Env, request: Request, id: string, name: string, context?: CacheContext): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(name)) return errorResponse(404, 'not_found');
  // JavaScript is checked before a complete response enters the byte cache.
  // Other resources are verified by their browser consumers before execution.
  const object = await immutableObject(env, `assets/${id}/${name}`, { head: request.method === 'HEAD', javascriptSha256: id, context });
  if (!object) return errorResponse(404, 'asset_not_found', 'The runtime resource is not installed');
  const headers = new Headers(object.headers);
  // The shared byte cache is behind page admission. A CDN must not cache the
  // final response in front of that admission check.
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return assetResponse(request, new Response(object.body, { headers }));
}
