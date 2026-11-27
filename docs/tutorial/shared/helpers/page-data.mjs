// Agent-first Chronolog v2 page data. `npm run init -- <slug>` creates the page's
// v2 LogGenesis (pinning `$reducers` ES Modules, `$permissions`, `$keys`, `$finality`,
// `$publications`, and the host attestation key) and epoch 0 key before any browser exists.
import { openPageGenesis } from '@tendriller/core/admission';

export async function initializePageData(context, { imports, topics, browserFirst = false, ownerGrant, authority, privateLog, finalitySchedule } = {}) {
  const marker = { applicationId: context.page.applicationId, publicKey: context.signer.publicKey, creator: browserFirst ? 'browser' : 'agent' };
  const existing = await context.readPrivate('initialized.json', true);
  if (existing && JSON.stringify({ ...existing, creator: marker.creator }) !== JSON.stringify(marker)) {
    throw Object.assign(Error('Retained initialized.json belongs to another page or signer; inspect it, nothing was replaced.'), { code: 'page_marker_mismatch' });
  }
  let created = false;
  let metadata = await context.host.peers.application({ signal: context.signal });
  if (!browserFirst || metadata.genesis !== null) {
    const device = await context.openDevice({ create: true });
    try {
      const opened = await openPageGenesis({
        store: device.store,
        identity: device.identity,
        wrapKey: context.wrapKey,
        peers: context.host.peers,
        applicationId: context.page.applicationId,
        imports,
        topics,
        ...(privateLog === undefined ? {} : { privateLog }),
        ...(authority === undefined ? {} : { authority }),
        finalitySchedule,
        create: !browserFirst,
        subject: 'agent',
        ...(ownerGrant === undefined ? {} : { ownerGrant }),
        signal: context.signal,
      });
      created = opened.created;
      metadata = await context.host.peers.application({ signal: context.signal });
    } finally {
      await device.close();
    }
  }
  if (!existing) await context.savePrivate('initialized.json', { ...marker, creator: created ? 'agent' : marker.creator });
  return { created, dataInitialized: metadata.genesis !== null, creator: existing?.creator ?? (created ? 'agent' : marker.creator) };
}
