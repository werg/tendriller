export const AUTHORITY_PARTICIPANT_LIMITS = Object.freeze({ pending: 4, perPrincipal: 2, recordBytes: 1024 * 1024, requestBytes: 2 * 1024 * 1024 });
/** Public control records are canonical Chronolog bytes carried as lowercase hex. */
export function authorityRecord(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected canonical record bytes');
  return { record: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') };
}
export function authorityRecordBytes(value, limit = 1024 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      typeof value.record !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value.record) || value.record.length > limit * 2)
    throw Object.assign(new Error('Expected a bounded canonical hex record'), { code: 'authority_record_invalid' });
  return Uint8Array.from(value.record.match(/../g), byte => parseInt(byte, 16));
}
/** Transport only. Callers verify signatures with @chronolog/authority before trusting records. */
export function createAuthorityClient(dispatch, { applicationId } = {}) {
  const request = async (path, options) => { options?.signal?.throwIfAborted(); const value = await (options === undefined ? dispatch(path) : dispatch(path, options)); options?.signal?.throwIfAborted(); return value; };
  if (applicationId !== undefined && (typeof applicationId !== 'string' || !/^[a-f0-9]{64}$/.test(applicationId))) throw new TypeError('Pin a stable application ID, not a remote resolver');
  const metadata = async promise => {
    const value = await promise;
    if (applicationId !== undefined && value?.selection?.id !== applicationId) throw Object.assign(Error('Host application scope mismatch'), { code: 'application_scope_mismatch' });
    return value;
  };
  return Object.freeze({
    application: options => metadata(request('application', options)),
    prepare: configuration => metadata(request('application', { method: 'POST', body: configuration })),
    challenge: publicKey => request('peers/enrollment', { method: 'POST', body: { action: 'challenge', publicKey } }),
    enroll: proof => metadata(request('peers/enrollment', { method: 'POST', body: { action: 'enroll', proof } })),
    grant: input => metadata(request('peers/enrollment', { method: 'POST', body: { ...input, action: 'grant' } })),
    membership: bundle => metadata(request('peers/enrollment', { method: 'POST', body: { action: 'membership', bundle } })),
    publication: id => request('peers/publication', { method: 'POST', body: { action: 'read', ...(id === undefined ? {} : { id }) } }),
    publish: (publication, assets) => request('peers/publication', { method: 'POST', body: { action: 'publish', publication, assets } }),
    async participant(record) { authorityRecordBytes(record, AUTHORITY_PARTICIPANT_LIMITS.recordBytes - 32); return request('peers/participant', { method: 'POST', body: record }); },
  });
}
