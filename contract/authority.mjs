export const AUTHORITY_PARTICIPANT_LIMITS = Object.freeze({ pending: 4, perPrincipal: 2, recordBytes: 1024 * 1024, requestBytes: 4 * 1024 * 1024 });

/** Public control records are canonical Chronolog v2 bytes carried as lowercase hex. */
export function authorityRecord(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected canonical record bytes');
  return { record: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') };
}

export function authorityRecordBytes(value, limit = 1024 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
      typeof value.record !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value.record) || value.record.length > limit * 2) {
    throw Object.assign(new Error('Expected a bounded canonical hex record'), { code: 'authority_record_invalid' });
  }
  return Uint8Array.from(value.record.match(/../g), byte => parseInt(byte, 16));
}

/** Transport only. Callers verify v2 LogGenesis, SignedOperation, and FinalityCheckpoint signatures locally. */
export function createAuthorityClient(dispatch, { applicationId } = {}) {
  const request = async (path, options) => {
    options?.signal?.throwIfAborted();
    const value = await (options === undefined ? dispatch(path) : dispatch(path, options));
    options?.signal?.throwIfAborted();
    return value;
  };
  if (applicationId !== undefined && (typeof applicationId !== 'string' || !/^[a-f0-9]{64}$/.test(applicationId))) {
    throw new TypeError('Pin a stable application ID, not a remote resolver');
  }
  const metadata = async promise => {
    const value = await promise;
    if (applicationId !== undefined && value?.selection?.id !== applicationId) {
      throw Object.assign(Error('Host application scope mismatch'), { code: 'application_scope_mismatch' });
    }
    return value;
  };
  return Object.freeze({
    application: options => metadata(request('application', options)),
    prepare: configuration => metadata(request('application', { method: 'POST', body: configuration })),
    challenge: publicKey => request('peers/enrollment', { method: 'POST', body: { action: 'challenge', publicKey } }),
    enroll: (proof, invite) => metadata(request('peers/enrollment', { method: 'POST', body: { action: 'enroll', proof, ...(invite === undefined ? {} : { invite }) } })),
    enrollAgent: () => metadata(request('peers/enrollment', { method: 'POST', body: { action: 'enroll-agent' } })),
    initialize: ({ genesis, casNodes, publicOps } = {}) => metadata(request('peers/enrollment', {
      method: 'POST',
      body: {
        action: 'initialize',
        genesis,
        ...(casNodes === undefined ? {} : { casNodes }),
        ...(publicOps === undefined ? {} : { publicOps }),
      },
    })),
    syncControl: ({ publicOps, casNodes, checkpoints, knownOpIds, knownCasHashes } = {}, options) => metadata(request('peers/enrollment', {
      method: 'POST',
      body: {
        action: 'sync',
        ...(publicOps === undefined ? {} : { publicOps }),
        ...(casNodes === undefined ? {} : { casNodes }),
        ...(checkpoints === undefined ? {} : { checkpoints }),
        ...(knownOpIds === undefined ? {} : { knownOpIds }),
        ...(knownCasHashes === undefined ? {} : { knownCasHashes }),
      },
      ...options,
    })),
    syncMailbox: ({ encryptedEnvelopes, publicOps, casNodes, knownEnvelopeDigests, knownOpIds, knownCasHashes } = {}, options) => request('peers/enrollment', {
      method: 'POST',
      body: {
        action: 'mailbox',
        ...(encryptedEnvelopes === undefined ? {} : { encryptedEnvelopes }),
        ...(publicOps === undefined ? {} : { publicOps }),
        ...(casNodes === undefined ? {} : { casNodes }),
        ...(knownEnvelopeDigests === undefined ? {} : { knownEnvelopeDigests }),
        ...(knownOpIds === undefined ? {} : { knownOpIds }),
        ...(knownCasHashes === undefined ? {} : { knownCasHashes }),
      },
      ...options,
    }),
    admissions: options => request('peers/enrollment', { method: 'POST', body: { action: 'admissions' }, ...options }),
    publication: id => request('peers/publication', { method: 'POST', body: { action: 'read', ...(id === undefined ? {} : { id }) } }),
    publish: (op, assets) => request('peers/publication', { method: 'POST', body: { action: 'publish', op, assets } }),
    groups: options => request('groups', options),
    setGroupPolicy: (policy, options) => request('groups/policy', { method: 'PUT', body: { policy }, ...options }),
    ackDeparture: (publicKey, options) => request(`groups/departures/${encodeURIComponent(publicKey)}/ack`, { method: 'POST', ...options }),
    async participant(record) {
      authorityRecordBytes(record, AUTHORITY_PARTICIPANT_LIMITS.requestBytes - 32);
      return request('peers/participant', { method: 'POST', body: record });
    },
  });
}
