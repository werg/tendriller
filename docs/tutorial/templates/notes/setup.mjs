import { prepareHost } from '../../shared/helpers/prepare-host.mjs';
import { initializePageData } from '../../shared/helpers/page-data.mjs';
import { definition, imports, topics } from './domain.mjs';

export async function initializePage(context, { requestedFinality, browserFirst = false, ownerGrant, authority } = {}) {
  const prepared = await prepareHost(context, { definition, executionProfile: 'chronolog-v2', requestedFinality });
  return { ...prepared, ...await initializePageData(context, { imports, topics, browserFirst, ownerGrant, authority }) };
}
