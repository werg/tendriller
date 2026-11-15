import { createHash } from 'node:crypto';

/** Every byte of immutable metadata contributes to the runtime identity. */
export function runtimeManifest({ version, contract, assets, resources }) {
  const identity = { format: 'tendriller-runtime', version, contract, assets, resources };
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { ...identity, id };
}
export function verifyRuntimeManifest(value) {
  if (value.format !== 'tendriller-runtime' || value.id !== runtimeManifest(value).id)
    throw Error('Runtime manifest identity does not match its contents');
  return value;
}
