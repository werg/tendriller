/** Thin control transport. Chronolog verifies all returned signed authority evidence. */
export function createPeerControlsClient(participant) {
  const request = (facet, action, payload = {}) => participant().request(facet, action, payload);
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
  const definition = value => {
    if (!value || typeof value !== 'object' || value.descriptor?.payload?.profile !== 'peer-generation-v1' ||
        typeof value.descriptor?.signature !== 'string' || typeof value.descriptor.payload.definitionDigest !== 'string' ||
        !value.definition || typeof value.definition.id !== 'string' || typeof value.definition.version !== 'string' ||
        !(value.definition.schema === null || typeof value.definition.schema === 'string') ||
        !Array.isArray(value.definition.commands) || !Array.isArray(value.definition.queries) ||
        !Object.hasOwn(value, 'schema') || value.schema !== null && (!value.schema || typeof value.schema !== 'object' || Array.isArray(value.schema)))
      throw Object.assign(new Error('Invalid peer definition response'), { code: 'invalid_response' });
    return value;
  };
  const publication = value => {
    if (!value || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.publication?.id !== 'string' ||
        typeof value.publication?.signature !== 'string' || value.publication?.payload?.profile !== 'peer-generation-v1')
      throw Object.assign(new Error('Invalid signed publication response'), { code: 'invalid_response' });
    return value;
  };
  return Object.freeze({
    async application() { return authority(await request('control', 'read')); },
    async definition() { return definition(await request('publication', 'definition')); },
    async publication(options = {}) { const value = await request('publication', 'read', options); return value === null ? null : publication(value); },
    async publishPublication(signed, assets) { return publication(await request('publication', 'publish', { publication: signed, assets })); },
    async configureApplication(configuration) { return authority(await request('control', 'configure', configuration)); },
    async selectGeneration(signedRequest, options = {}) {
      return generation(await request('control', 'select', { request: signedRequest,
        ...(options.control === undefined ? {} : { control: options.control }) }));
    },
    async administerGeneration(transition, options = {}) {
      return generation(await request('control', 'administer', { transition,
        ...(options.control === undefined ? {} : { control: options.control }) }));
    },
  });
}
