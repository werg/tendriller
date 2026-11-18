import type { Env } from './env';
import { HttpError } from './http';
import { sha256Hex } from './ids';

const CACHE_NAME = 'tendriller-immutable-bytes-v1';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_BACKGROUND_BYTES = 1024 * 1024;
export type CacheContext = Pick<ExecutionContext, 'waitUntil'>;

/** Raw immutable bytes, never an authenticated HTTP response or injected HTML. */
export async function immutableObject(env: Env, key: string, options: {
  head?: boolean;
  sha256?: string;
  javascriptSha256?: string;
  context?: CacheContext;
} = {}): Promise<Response | null> {
  // A named cache and an unrouted key keep private bytes out of the public CDN
  // response cache. No visitor-supplied URL, cookie, or header becomes identity.
  // PUBLIC_BASE separates production, staging, and isolated preview storage.
  const verification = options.sha256 ? `sha256:${options.sha256}`
    : options.javascriptSha256 ? `javascript-sha256:${options.javascriptSha256}` : 'trusted-object';
  const cacheKey = new Request(new URL('/_tendril/_cached-bytes/v1/' + encodeURIComponent(verification) + '/' + key.split('/').map(encodeURIComponent).join('/'), env.PUBLIC_BASE));
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey);
    if (hit?.status === 200) {
      if (!options.head) return hit;
      await hit.body?.cancel();
      return new Response(null, hit);
    }
    await hit?.body?.cancel();
  } catch { /* An unavailable/evicted cache never makes immutable storage unavailable. */ }

  const object = options.head ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!object) return null;
  const headers = objectHeaders(object);
  if (options.head) return new Response(null, { headers });

  const stored = object as R2ObjectBody;
  let body: BodyInit = stored.body;
  const type = headers.get('Content-Type') || 'application/octet-stream';
  const expectedHash = options.sha256 ?? (/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(type) ? options.javascriptSha256 : undefined);
  if (expectedHash) {
    const bytes = await stored.arrayBuffer();
    if (await sha256Hex(bytes) !== expectedHash)
      throw new HttpError(503, 'integrity_mismatch', 'Immutable content failed integrity verification');
    body = bytes;
  }
  const response = new Response(body, { headers });
  if (cache && object.size <= MAX_CACHE_BYTES) {
    // Only complete successful bytes enter the cache. Conditions, ranges and
    // page-specific headers are applied by the caller after this copy is made.
    if (object.size <= MAX_BACKGROUND_BYTES) {
      const saved = cache.put(cacheKey, response.clone()).catch(() => {});
      if (options.context) options.context.waitUntil(saved);
      else await saved;
    } else {
      // A tee can buffer the entire model for its slower reader. Stream large
      // fills to cache once, then serve a fresh cache stream with backpressure.
      try {
        await cache.put(cacheKey, response);
        const saved = await cache.match(cacheKey);
        if (saved?.status === 200) return saved;
        await saved?.body?.cancel();
      } catch { /* Fall through to an uncached stream if the cache cannot retain it. */ }
      if (body instanceof ArrayBuffer) return new Response(body, { headers });
      if (!response.bodyUsed && !response.body?.locked) return response;
      const retry = await env.FILES.get(key);
      return retry ? new Response(retry.body, { headers: objectHeaders(retry) }) : null;
    }
  }
  return response;
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

export function etagMatches(condition: string | null, etag: string): boolean {
  return condition !== null && condition.split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
}

/** Apply request semantics to a complete asset without caching a partial body. */
export async function assetResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  const etag = headers.get('ETag'), modified = headers.get('Last-Modified');
  const condition = request.headers.get('If-None-Match');
  const since = request.headers.get('If-Modified-Since');
  if ((etag && etagMatches(condition, etag)) ||
    (condition === null && since && modified && Date.parse(modified) <= Date.parse(since))) {
    await response.body?.cancel();
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    await response.body?.cancel();
    return new Response(null, { headers });
  }

  const size = Number(headers.get('Content-Length'));
  if (headers.has('Content-Length') && Number.isSafeInteger(size) && size >= 0) {
    headers.set('Accept-Ranges', 'bytes');
    const ifRange = request.headers.get('If-Range');
    const canRange = !ifRange || (ifRange.startsWith('"') || ifRange.startsWith('W/')
      ? ifRange === etag && !ifRange.startsWith('W/')
      : !!modified && Date.parse(modified) <= Date.parse(ifRange));
    const range = canRange ? /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '') : null;
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
        if (start >= size || end < start) {
          await response.body?.cancel();
          headers.set('Content-Range', `bytes */${size}`);
          headers.set('Content-Length', '0');
          return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        headers.set('Content-Length', String(end - start + 1));
        return new Response(sliceBody(response.body!, start, end), { status: 206, headers });
      }
    }
  }
  return new Response(response.body, { headers });
}

/** Stream the selected bytes; large model ranges never require buffering a model. */
function sliceBody(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { controller.close(); return; }
        const next = offset + value.byteLength;
        if (next > start) controller.enqueue(value.subarray(Math.max(0, start - offset), Math.min(value.byteLength, end - offset + 1)));
        offset = next;
        if (offset > end) { controller.close(); await reader.cancel(); return; }
        if (offset > start) return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
