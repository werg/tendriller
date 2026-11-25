// One fail-closed host-page creation path for workspace CLI, starters and consumers.
// The host credential and signing identity remain in the workspace, never in this intent.
import { randomBytes } from 'node:crypto';
const fail = (code, message) => Object.assign(Error(message), { code });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export async function createWorkspacePage({ workspace, client, store, slug, name = slug, mode, application, signal,
  newApplicationId = () => randomBytes(32).toString('hex') }) {
  signal?.throwIfAborted();
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(slug)) throw fail('invalid_slug', 'Use a lowercase page slug (max 48 characters).');
  if (typeof name !== 'string' || !name.length || name.length > 200 || mode !== undefined && !['interactive', 'dashboard'].includes(mode)
    || application !== undefined && (!application || Object.keys(application).some(key => key !== 'id') || !hex(application.id)))
    throw fail('invalid_page_creation', 'Supply a bounded name, a supported mode and an exact application identity.');
  const { service, agent } = workspace.config;
  let intent = await store.read('intent.json', true);
  const validate = value => {
    if (value?.schemaVersion !== 1 || value.service !== service || value.agentId !== agent.id || !hex(value.applicationId)
      || value.name !== name || value.mode !== mode || application !== undefined && value.applicationId !== application.id)
      throw fail('page_creation_intent_mismatch', 'The retained page creation intent differs. Inspect the original intent; no page was created or adopted.');
    return value;
  };
  if (intent) validate(intent);
  if (workspace.config.pages?.[slug]) {
    const saved = await workspace.page(slug);
    if (intent && saved.application?.id !== intent.applicationId) throw fail('page_creation_intent_mismatch', 'The registered page does not match the original creation intent.');
    return saved;
  }
  if (!intent) {
    const candidate = { schemaVersion: 1, service, agentId: agent.id, applicationId: application?.id ?? newApplicationId(), name, ...(mode === undefined ? {} : { mode }) };
    if (!hex(candidate.applicationId)) throw fail('invalid_page_creation', 'The application identity must be exact 32-byte hex.');
    try { await store.save('intent.json', candidate); }
    catch (error) {
      // Another process may have captured the same reviewed request first. Its
      // original application identity wins; never replace it with our candidate.
      intent = await store.read('intent.json', true);
      if (!intent) throw error;
    }
    intent ??= await store.read('intent.json');
    validate(intent);
  }
  const find = async () => {
    const matches = [];
    for await (const page of client.pages.all({ signal })) {
      signal?.throwIfAborted();
      if (page.application?.id !== intent.applicationId) continue;
      if (page.api !== undefined && new URL(page.api).origin !== service) throw fail('page_creation_service_mismatch', 'The matching page is not on the retained service. Nothing was adopted or created.');
      matches.push(page);
      if (matches.length > 1) throw fail('page_creation_ambiguous', 'More than one granted page matches the original application identity. Inspect the grants; nothing was adopted or created.');
    }
    return matches[0];
  };
  const matching = await find();
  if (matching) return workspace.registerPage(slug, matching);
  const uncertain = () => fail('page_creation_uncertain', `Creation of application ${intent.applicationId} may have been sent. No second page was created. Inspect this agent's granted pages (tendril page list or the dashboard), then retry this same intent to recover only the exact application identity.`);
  const dispatched = await store.read('dispatched.json', true);
  if (dispatched) {
    if (dispatched.applicationId !== intent.applicationId) throw fail('page_creation_intent_mismatch', 'The dispatch marker differs from the original intent.');
    throw uncertain();
  }
  signal?.throwIfAborted();
  if (!await store.claim('dispatched.json', { applicationId: intent.applicationId })) {
    const recovered = await find();
    if (recovered) return workspace.registerPage(slug, recovered);
    throw uncertain();
  }
  const created = await client.pages.create({ name: intent.name, ...(intent.mode === undefined ? {} : { mode: intent.mode }), application: { id: intent.applicationId } }, { signal });
  if (created.application?.id !== intent.applicationId) throw uncertain();
  if (created.api !== undefined && new URL(created.api).origin !== service) throw fail('page_creation_service_mismatch', 'The created page does not belong to the retained service.');
  return workspace.registerPage(slug, created);
}
