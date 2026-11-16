import { CONTRACT_VERSION } from '@tendriller/core/contract';

export const CORE_REQUIREMENTS = Object.freeze({ contract: CONTRACT_VERSION, workflows: {} });
export function assertService(descriptor, requirements = CORE_REQUIREMENTS) {
  if (!descriptor || descriptor.contract !== requirements.contract)
    throw Error(`This artifact requires core contract ${requirements.contract}; the service advertises ${descriptor?.contract ?? 'none'}.`);
  for (const [id, required] of Object.entries(requirements.workflows || {})) {
    const installed = descriptor.workflows?.find(module => module.id === id);
    if (!installed || installed.interface_version !== required.interface_version || installed.schema_version !== required.schema_version)
      throw Error(`Workflow '${id}' requires interface ${required.interface_version}, schema ${required.schema_version}; the deployed module does not satisfy it.`);
  }
  return descriptor;
}
export async function checkService(api, { fetch: fetcher = globalThis.fetch, requirements = CORE_REQUIREMENTS } = {}) {
  const url = new URL('/api/service', api);
  const response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Error(`Cannot verify service requirements: HTTP ${response.status}.`);
  return assertService(await response.json(), requirements);
}
