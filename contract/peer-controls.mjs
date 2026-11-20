/** Thin control transport. Chronolog verifies all returned signed authority evidence. */
export function createPeerControlsClient(participant) {
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
  return Object.freeze({
    async application(options) { return authority(await participant.request('control', 'read', {}, options)); },
    async definition() { return definition(await participant.request('publication', 'definition', {})); },
    async configureApplication(configuration) { return authority(await participant.request('control', 'configure', configuration)); },
    async selectGeneration(signedRequest, options = {}) {
      return generation(await participant.request('control', 'select', { request: signedRequest,
        ...(options.control === undefined ? {} : { control: options.control }) }));
    },
    async administerGeneration(transition, options = {}) {
      return generation(await participant.request('control', 'administer', { transition,
        ...(options.control === undefined ? {} : { control: options.control }) }));
    },
    async publication(id) { return participant.request('publication', 'read', id === undefined ? {} : { id }); },
    async publish(publication, assets) { return participant.request('publication', 'publish', { publication, assets }); },
  });
}
