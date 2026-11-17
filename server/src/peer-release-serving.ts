import type { ReleaseBootstrap } from '../../contract/releases.mjs';
import type { RuntimeArtifactFeatures } from '../../contract/index.mjs';
import { selectedApplication } from './application';
import { HttpError, readBody } from './http';
import { holdingPage, injectRuntime, type PublicationManifest } from './inject';
import { isHtmlType } from './mime';
import { peerBootstrap } from './peers';
import { peerReleaseBootstrap, peerReleaseManifest, verifiedReleaseObject } from './peer-releases';
import type { Tendril } from './tendril';

// HTML injection buffers authored input. Keep its aggregate input bounded until
// the response drains; immutable non-HTML assets use the streaming path below.
const rendering = new WeakMap<Tendril, { bytes: number; requests: number }>();
function reserveRender(t: Tendril, bytes: number): () => void {
  let state = rendering.get(t);
  if (!state) { state = { bytes: 0, requests: 0 }; rendering.set(t, state); }
  if (state.requests >= 2 || state.bytes + bytes > 25 * 1024 * 1024)
    throw new HttpError(429, 'release_render_busy', 'The page renderer is at its bounded byte capacity');
  state.bytes += bytes; state.requests++;
  let held = true;
  return () => { if (held) { held = false; state.bytes -= bytes; state.requests--; } };
}
function renderedResponse(html: string, headers: Headers, release: () => void): Response {
  const reader = new Response(html).body!.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); release(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { reader.releaseLock(); release(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); release(); } },
  }), { headers });
}

/** A serving projection of one signed activation. Integer version is presentation metadata only. */
export async function peerPublication(t: Tendril, base: string, requested?: string): Promise<{
  version: number; publication: PublicationManifest | null; bootstrap: ReleaseBootstrap | null;
}> {
  const bootstrap = await peerReleaseBootstrap(t);
  const activation = requested === undefined ? bootstrap?.state.activations.at(-1)
    : bootstrap?.state.activations.findLast(value => value.payload.releaseId === requested);
  if (!activation) {
    if (requested !== undefined) throw new HttpError(404, 'release_not_activated');
    return { version: 0, publication: null, bootstrap };
  }
  const id = activation.payload.releaseId;
  const manifest = bootstrap!.manifest && activation.id === bootstrap!.state.activations.at(-1)?.id
    ? bootstrap!.manifest : await peerReleaseManifest(t, id);
  if (!manifest) throw new HttpError(503, 'release_manifest_missing');
  const runtime = t.db.one<{ runtime_id: string; runtime_version: string; runtime_features: string }>(
    'SELECT runtime_id,runtime_version,runtime_features FROM page_release_publications WHERE release_id=?', id);
  if (!runtime) throw new HttpError(503, 'release_projection_missing');
  const publication: PublicationManifest = {
    id, base: `${base}_publications/${id}/`, entry: manifest.payload.entry,
    assets: manifest.payload.assets.map(asset => ({ path: asset.path, sha256: asset.digest, size: asset.bytes, type: asset.mediaType })),
    runtime: { id: runtime.runtime_id, version: runtime.runtime_version, features: JSON.parse(runtime.runtime_features) as RuntimeArtifactFeatures,
      base: `${base}_tendril/runtime/${runtime.runtime_id}/` },
  };
  return { version: activation.payload.revision + 1, publication, bootstrap };
}

export async function servePeerPage(t: Tendril, req: Request, base: string, rest: string, role: 'owner' | 'guest' | 'display'): Promise<Response> {
  const pinned = /^_publications\/([0-9a-f]{64})\/(.*)$/.exec(rest);
  if (rest.startsWith('_publications/') && !pinned) throw new HttpError(404, 'release_not_found');
  if (pinned) rest = pinned[2];
  const { version, publication, bootstrap } = await peerPublication(t, base, pinned?.[1]);
  const config = { id: t.tid, base, version, application: selectedApplication(t), features: t.features(),
    peerBootstrap: role === 'display' ? undefined : peerBootstrap(t), peerRelease: bootstrap ?? undefined };
  const headers = new Headers({ 'Cache-Control': 'private, no-cache', 'X-Tendril-Version': String(version), 'X-Content-Type-Options': 'nosniff' });
  if (!publication) {
    if (rest) throw new HttpError(404, 'not_found');
    headers.set('Content-Type', 'text/html; charset=utf-8'); headers.set('Cache-Control', 'no-store');
    const html = injectRuntime(holdingPage(t.db.get('name', 'Tendril')), { ...config, publication: null, documentPath: null });
    return new Response(req.method === 'HEAD' ? null : html, { headers });
  }
  let path = rest || publication.entry;
  let file = publication.assets.find(asset => asset.path === path);
  if (!file && rest.endsWith('/')) { path = rest + 'index.html'; file = publication.assets.find(asset => asset.path === path); }
  if (!file) throw new HttpError(404, 'not_found');
  const release = isHtmlType(file.type) ? reserveRender(t, file.size) : undefined;
  let object: R2ObjectBody;
  try { object = await verifiedReleaseObject(t, { path: file.path, digest: file.sha256, bytes: file.size, mediaType: file.type }, req.signal); }
  catch (error) { release?.(); throw error; }
  headers.set('Content-Type', file.type); headers.set('X-Tendril-Publication', publication.id);
  if (isHtmlType(file.type)) {
    // Signatures cover authored bytes. This host's trusted bootstrap remains explicit.
    try {
      if (req.method === 'HEAD') { await object.body.cancel(); release!(); return new Response(null, { headers }); }
      const bytes = await readBody({ body: object.body, headers: new Headers({ 'Content-Length': String(object.size) }), signal: req.signal }, file.size, 30_000);
      const html = injectRuntime(new TextDecoder().decode(bytes), { ...config, publication, documentPath: path });
      return renderedResponse(html, headers, release!);
    } catch (error) { release!(); throw error; }
  }
  headers.set('Content-Length', String(file.size)); headers.set('ETag', `"${file.sha256}"`);
  if (pinned) headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (req.headers.get('If-None-Match') === headers.get('ETag')) { await object.body.cancel(); return new Response(null, { status: 304, headers }); }
  if (req.method === 'HEAD') await object.body.cancel();
  return new Response(req.method === 'HEAD' ? null : object.body, { headers });
}
