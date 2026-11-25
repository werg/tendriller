// Authenticated session signals are visible to application readers. A target
// device is routing metadata, not a private recipient or a grant of authority.
export const INFERENCE_TOPICS = Object.freeze({ request: 'media/inference/request', cancel: 'media/inference/cancel', reply: 'media/inference/reply' });
export const INFERENCE_LIMITS = Object.freeze({ evidenceBytes: 8 * 1024 * 1024, contextBytes: 4096, suggestionBytes: 6000, promptCharacters: 2000 });
export const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
// Bounded clips use the same immutable evidence transport. Provider support is
// separate: the bundled OpenAI image adapter deliberately rejects audio.
export const AUDIO_TYPES = Object.freeze(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav']);
export const MEDIA_TYPES = Object.freeze([...IMAGE_TYPES, ...AUDIO_TYPES]);
// MediaRecorder commonly includes a codecs parameter on its local Blob.
// Content references use the canonical type/subtype; staging normalizes only
// that metadata while preserving the original capture bytes and digest.
// Byte limits bound transport; acquisition controllers additionally bound time.
export function normalizeEvidenceType(type) {
  if (typeof type !== 'string' || type.length > 128 || /[\x00-\x1f\x7f]/u.test(type)) return null;
  if (IMAGE_TYPES.includes(type)) return type;
  const base = type.split(';', 1)[0].trim().toLowerCase();
  return AUDIO_TYPES.includes(base) ? base : null;
}
export function isEvidenceType(type) { return normalizeEvidenceType(type) !== null; }
export const digestPattern = /^[a-f0-9]{64}$/u;
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
export function inferenceError(code) {
  const messages = { cancelled: 'Analysis was cancelled. No suggestion was accepted.', deadline: 'Analysis timed out. Retry only if you want a new provider request.',
    busy: 'The authorized inference peer is busy. Try again after it finishes.', budget: 'The native inference request budget is exhausted.',
    invalid: 'The inference request is invalid or exceeds its limits.', source: 'The immutable evidence bytes do not match this request.',
    conflict: 'This request identity was already used with different inputs.', provider: 'The selected inference provider failed. Check the private native process.',
    closed: 'The inference connection is closed.', unavailable: 'The inference peer is unavailable. Keep the candidate and try again deliberately.' };
  const error = Error(messages[code] ?? 'Analysis could not finish.'); error.code = code; return error;
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function jsonCopy(value, maximum) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > maximum) throw inferenceError('invalid');
  return JSON.parse(encoded);
}
export function requestFingerprint(value) {
  const canonical = item => item === null || typeof item !== 'object' ? JSON.stringify(item)
    : Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
      : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
  return canonical(value);
}
export function validRequest(value, { applicationId, workerDeviceId, maxEvidenceBytes }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'candidateId,context,prompt,reference,requestId,sha256,workerDeviceId'
    || value.workerDeviceId !== workerDeviceId || !validId(value.requestId) || !validId(value.candidateId)
    || !digestPattern.test(value.sha256) || typeof value.prompt !== 'string' || !value.prompt.trim()
    || value.prompt.length > INFERENCE_LIMITS.promptCharacters) throw inferenceError('invalid');
  const ref = value.reference;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)
    || Object.keys(ref).sort().join(',') !== 'applicationId,bytes,epoch,id,mediaType,profile'
    || ref.profile !== 'authored-content-v1' || ref.applicationId !== applicationId
    || !digestPattern.test(ref.id) || !Number.isSafeInteger(ref.epoch) || ref.epoch < 0
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > maxEvidenceBytes
    || !MEDIA_TYPES.includes(ref.mediaType)) throw inferenceError('invalid');
  jsonCopy(value.context, INFERENCE_LIMITS.contextBytes);
  return value;
}
export function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { signal.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, signal.reason ?? inferenceError('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}
