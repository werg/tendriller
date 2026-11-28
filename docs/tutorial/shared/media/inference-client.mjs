import { INFERENCE_TOPICS, INFERENCE_LIMITS, normalizeEvidenceType, digestPattern, validId, inferenceError, sha256, jsonCopy, abortable } from './inference-protocol.mjs';

/**
 * Browser-side analysis adapter for createReviewedInput({ analyze }). No HTTP
 * backend, credential, command dispatch or automatic retry. Only call analyze
 * after the person chooses to share this evidence with the named provider.
 */
export function createPeerInferenceClient({ session, workerDeviceId, prompt,
  maxEvidenceBytes = INFERENCE_LIMITS.evidenceBytes, timeoutMs = 45_000 }) {
  if (!digestPattern.test(workerDeviceId) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > INFERENCE_LIMITS.promptCharacters
    || !Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes < 1 || maxEvidenceBytes > INFERENCE_LIMITS.evidenceBytes
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw inferenceError('invalid');
  let active = null, closed = false;
  return {
    async analyze({ candidate, signal } = {}) {
      if (closed) throw inferenceError('closed');
      if (active) throw inferenceError('busy');
      const mediaType = candidate?.blob instanceof Blob ? normalizeEvidenceType(candidate.blob.type) : null;
      if (!candidate || !validId(candidate.id) || !digestPattern.test(candidate.sha256)
        || !mediaType || candidate.blob.size < 1 || candidate.blob.size > maxEvidenceBytes) throw inferenceError('invalid');
      const captured = { id: candidate.id, sha256: candidate.sha256, blob: candidate.blob,
        context: jsonCopy(candidate.context, INFERENCE_LIMITS.contextBytes) };
      const owner = new AbortController(); active = owner;
      const lifetime = signal ? AbortSignal.any([owner.signal, signal]) : owner.signal;
      const deadline = setTimeout(() => owner.abort(inferenceError('deadline')), timeoutMs);
      const requestId = crypto.randomUUID();
      let reference = null, dispatched = false, iterator;
      const cancelRemote = () => {
        if (!dispatched) return;
        void session.signals.send(INFERENCE_TOPICS.cancel, { workerDeviceId, requestId },
          { ttlMs: 5000, signal: AbortSignal.timeout(2000) }).catch(() => {});
      };
      lifetime.addEventListener('abort', cancelRemote, { once: true });
      try {
        lifetime.throwIfAborted();
        // Pull the reply subscription before asynchronous content preparation.
        // The page Worker registers this stream before its later send request.
        iterator = session.signals.subscribe({ topics: [INFERENCE_TOPICS.reply], mode: 'all', signal: lifetime })[Symbol.asyncIterator]();
        const response = (async () => {
          for (;;) {
            const next = await iterator.next();
            if (next.done) throw lifetime.reason ?? inferenceError('unavailable');
            const item = next.value, reply = item.payload;
            if (item.authorId !== workerDeviceId || item.scope !== session.applicationId || !reply || reply.recipient !== session.identity.publicKey
              || reply.requestId !== requestId || reply.candidateId !== captured.id || reply.sha256 !== captured.sha256
              || !reference || reply.contentId !== reference.id) continue;
            if (reply.kind === 'error') throw inferenceError(reply.code);
            if (reply.kind !== 'suggestion' || !reply.suggestion || typeof reply.suggestion !== 'object' || Array.isArray(reply.suggestion)) continue;
            return jsonCopy(reply.suggestion, INFERENCE_LIMITS.suggestionBytes);
          }
        })();
        // A subscription failure while staging must not become an unhandled
        // rejection; the same promise is still awaited for its actual outcome.
        response.catch(() => {});
        const bytes = new Uint8Array(await abortable(captured.blob.arrayBuffer(), lifetime));
        if (await abortable(sha256(bytes), lifetime) !== captured.sha256) throw inferenceError('source');
        // Content references accept a canonical type/subtype, not MIME
        // parameters. Keep the original Blob and bytes; do not transcode.
        reference = typeof session.content.put === 'function'
          ? await abortable(session.content.put(bytes, { mediaType, signal: lifetime }), lifetime)
          : await (async () => {
              const upload = await abortable(session.content.stage({ bytes: bytes.length, mediaType }), lifetime);
              for (let offset = 0; offset < bytes.length; offset += 65_536) {
                lifetime.throwIfAborted();
                await abortable(upload.write(offset / 65_536, bytes.slice(offset, offset + 65_536)), lifetime);
              }
              return abortable(upload.commit(), lifetime);
            })();
        lifetime.throwIfAborted();
        dispatched = true;
        await session.signals.send(INFERENCE_TOPICS.request, { workerDeviceId, requestId, candidateId: captured.id,
          sha256: captured.sha256, reference, context: captured.context, prompt }, { ttlMs: 30_000, signal: lifetime });
        const suggestion = await abortable(response, lifetime);
        lifetime.throwIfAborted();
        return { suggestion, source: { candidateId: captured.id, sha256: captured.sha256, reference: structuredClone(reference) } };
      } finally {
        clearTimeout(deadline); lifetime.removeEventListener('abort', cancelRemote);
        owner.abort(inferenceError('cancelled'));
        await iterator?.return?.().catch(() => {});
        if (active === owner) active = null;
      }
    },
    close() { closed = true; active?.abort(inferenceError('closed')); },
  };
}
