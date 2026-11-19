import { INFERENCE_TOPICS, INFERENCE_LIMITS, digestPattern, validId, inferenceError, sha256, jsonCopy, validRequest, requestFingerprint } from './inference-protocol.mjs';

/**
 * Opt-in native computation only. The operator explicitly grants device IDs a
 * bounded process-lifetime spend budget. Credentials stay in infer's closure.
 * This is not recovery finality, a durable effect queue, or a ChatGPT bridge.
 * Replies and request metadata are visible to authorized application readers.
 */
export function servePeerInference({ session, allowedDevices, maxRequests = 1, maxConcurrent = 1,
  maxEvidenceBytes = INFERENCE_LIMITS.evidenceBytes, timeoutMs = 30_000, infer, signal, onStatus = () => {} }) {
  if (!Array.isArray(allowedDevices) || !allowedDevices.length || allowedDevices.length > 32 || allowedDevices.some(id => !digestPattern.test(id))
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4
    || !Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes < 1 || maxEvidenceBytes > INFERENCE_LIMITS.evidenceBytes
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || typeof infer !== 'function') throw inferenceError('invalid');
  const allowed = new Set(allowedDevices), stopped = new AbortController(), records = new Map(), cancellations = new Set(), jobs = new Set();
  const lifetime = signal ? AbortSignal.any([stopped.signal, signal]) : stopped.signal;
  let admitted = 0, cancellationOverflow = false;
  const status = () => ({ admitted, remaining: Math.max(0, maxRequests - admitted), active: jobs.size, stopped: lifetime.aborted });
  const notify = () => onStatus(status());
  const reply = async (value, replySignal = lifetime) => {
    if (replySignal.aborted) return;
    try { await session.signals.send(INFERENCE_TOPICS.reply, value, { ttlMs: 30_000, signal: replySignal }); }
    catch { /* An ephemeral reply can be lost. It is never a reason to rerun inference. */ }
  };
  const base = (authorId, request) => ({ recipient: authorId, requestId: request.requestId,
    candidateId: request.candidateId, sha256: request.sha256, contentId: request.reference.id });
  const reject = (authorId, request, code) => reply({ ...base(authorId, request), kind: 'error', code });
  const run = async (record, authorId, request) => {
    const owner = record.owner, requestSignal = AbortSignal.any([lifetime, owner.signal]);
    const timer = setTimeout(() => owner.abort(inferenceError('deadline')), timeoutMs);
    try {
      requestSignal.throwIfAborted();
      const bytes = new Uint8Array(request.reference.bytes); let offset = 0;
      for await (const chunk of session.content.read(request.reference, { signal: requestSignal })) {
        requestSignal.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || offset + chunk.length > bytes.length) throw inferenceError('source');
        bytes.set(chunk, offset); offset += chunk.length;
      }
      if (offset !== bytes.length || await sha256(bytes) !== request.sha256) throw inferenceError('source');
      requestSignal.throwIfAborted();
      // No session, signer, credential or command function is passed to the
      // provider. Its only output is JSON for an authored review interface.
      const suggestion = await infer({ bytes, mediaType: request.reference.mediaType, prompt: request.prompt,
        context: jsonCopy(request.context, INFERENCE_LIMITS.contextBytes),
        source: { candidateId: request.candidateId, sha256: request.sha256, contentId: request.reference.id }, signal: requestSignal });
      requestSignal.throwIfAborted();
      if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)) throw inferenceError('provider');
      record.response = { ...base(authorId, request), kind: 'suggestion', suggestion: jsonCopy(suggestion, INFERENCE_LIMITS.suggestionBytes) };
    } catch (error) {
      const code = requestSignal.aborted ? (requestSignal.reason?.code === 'deadline' ? 'deadline' : 'cancelled')
        : ['source', 'invalid'].includes(error.code) ? error.code : 'provider';
      record.response = { ...base(authorId, request), kind: 'error', code };
    } finally { clearTimeout(timer); }
    await reply(record.response, record.response.kind === 'suggestion' ? requestSignal : lifetime);
  };
  const done = (async () => {
    notify();
    try {
      for await (const envelope of session.signals.subscribe({ topics: [INFERENCE_TOPICS.request, INFERENCE_TOPICS.cancel], mode: 'all', signal: lifetime })) {
        lifetime.throwIfAborted();
        // Identity comes from the authenticated envelope, never a payload role.
        if (envelope.scope !== session.applicationId || !allowed.has(envelope.authorId)) continue;
        const input = envelope.payload;
        if (!input || input.workerDeviceId !== session.deviceId || !validId(input.requestId)) continue;
        const key = `${envelope.authorId}/${input.requestId}`;
        if (envelope.topic === INFERENCE_TOPICS.cancel) {
          if (Object.keys(input).sort().join(',') !== 'requestId,workerDeviceId') continue;
          if (!cancellations.has(key) && cancellations.size >= maxRequests * 4) cancellationOverflow = true;
          else cancellations.add(key);
          records.get(key)?.owner.abort(inferenceError('cancelled'));
          continue;
        }
        let request;
        try {
          request = validRequest(jsonCopy(input, 12_000), { applicationId: session.applicationId, historyId: session.historyId,
            workerDeviceId: session.deviceId, maxEvidenceBytes });
        } catch { continue; }
        const fingerprint = requestFingerprint(request), previous = records.get(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) await reject(envelope.authorId, request, 'conflict');
          else if (cancellations.has(key)) await reject(envelope.authorId, request, 'cancelled');
          else if (previous.response) await reply(previous.response);
          continue;
        }
        if (cancellations.has(key) || cancellationOverflow) { await reject(envelope.authorId, request, 'cancelled'); continue; }
        if (admitted >= maxRequests) { await reject(envelope.authorId, request, 'budget'); continue; }
        if (jobs.size >= maxConcurrent) { await reject(envelope.authorId, request, 'busy'); continue; }
        const record = { fingerprint, owner: new AbortController(), response: null }; records.set(key, record); admitted++;
        // Keep the physical slot until infer settles, even if it ignores abort.
        // A cancelled waiter must not allow unbounded provider requests.
        const task = run(record, envelope.authorId, request).finally(() => { jobs.delete(task); notify(); });
        jobs.add(task); notify();
      }
    } catch (error) { if (!lifetime.aborted) throw error; }
    finally {
      stopped.abort(inferenceError('closed'));
      for (const record of records.values()) record.owner.abort(inferenceError('closed'));
      await Promise.allSettled(jobs); notify();
    }
  })();
  return { done, snapshot: status, async close() { stopped.abort(inferenceError('closed')); await done; } };
}
