/** Canonical host context committed by a device's signed transition. */
export function peerAccountBindingsContext(accounts = []) {
  const invalid = () => { throw Object.assign(new TypeError('Expected bounded, distinct device/account bindings'), { code: 'invalid_account_bindings' }); };
  if (!Array.isArray(accounts) || accounts.length > 1024) invalid();
  const seen = new Set();
  const normalized = accounts.map(binding => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).length !== 2 || Object.keys(binding).some(key => !['publicKey', 'accountId'].includes(key)) ||
        typeof binding.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(binding.publicKey) || seen.has(binding.publicKey) ||
        typeof binding.accountId !== 'string' || !binding.accountId.length || binding.accountId.length > 200) invalid();
    seen.add(binding.publicKey);
    return Object.freeze({ publicKey: binding.publicKey, accountId: binding.accountId });
  }).sort((a, b) => a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0);
  return normalized.length === 0 ? null : Object.freeze({ kind: 'tendriller-account-bindings/v1', accounts: Object.freeze(normalized) });
}

/** Thin control transport. Chronolog verifies all returned signed authority evidence. */
export function createPeerControlsClient(request) {
  const authority = value => {
    if (!value || typeof value !== 'object' || !value.descriptor?.payload || value.descriptor.payload.profile !== 'peer-generation-v1' ||
        !Array.isArray(value.controls) || !Array.isArray(value.generations))
      throw Object.assign(new Error('Invalid peer authority response'), { code: 'invalid_response' });
    return value;
  };
  const generation = value => {
    if (!value || typeof value.id !== 'string' || value.payload?.profile !== 'peer-generation-v1' || typeof value.signature !== 'string')
      throw Object.assign(new Error('Invalid generation selection response'), { code: 'invalid_response' });
    return value;
  };
  return Object.freeze({
    async application() { return authority(await request('peers/application')); },
    async configureApplication(configuration) { return authority(await request('peers/application', { method: 'PUT', body: configuration })); },
    async selectGeneration(signedRequest, options = {}) {
      return generation(await request('peers/generations', { method: 'POST', body: { request: signedRequest,
        ...(options.control === undefined ? {} : { control: options.control }) } }));
    },
    async administerGeneration(transition, options = {}) {
      return generation(await request('peers/administration', { method: 'POST', body: { transition,
        ...(options.control === undefined ? {} : { control: options.control }) } }));
    },
  });
}
