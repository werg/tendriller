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
    async application() { return authority(await request('peers/application')); },
    async definition() { return definition(await request('peers/definition')); },
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
