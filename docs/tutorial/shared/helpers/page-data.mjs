// Agent-first page data. `npm run init -- <slug>` creates the page's signed descriptor,
// genesis membership (pinning the owner account and the host attestation key) and
// first epoch key in this agent's own page store, before any browser exists. The
// owner's browsers are later admitted by this agent (or any other key holder).
import { openPageAuthority } from '@tendriller/core/admission';

/** Create (or reopen) this page's data as its creator; `browserFirst` leaves creation to the owner's first browser. */
export async function initializePageData(context, { executionManifestDigest, browserFirst = false }) {
  const marker = { applicationId: context.page.applicationId, publicKey: context.signer.publicKey, executionManifestDigest, creator: browserFirst ? 'browser' : 'agent' };
  const existing = await context.readPrivate('initialized.json', true);
  if (existing && JSON.stringify({ ...existing, creator: marker.creator }) !== JSON.stringify(marker)) throw Object.assign(Error('Retained initialized.json belongs to another page, signer or execution graph; inspect it, nothing was replaced.'), { code: 'page_marker_mismatch' });
  let created = false, metadata = await context.host.peers.application({ signal: context.signal });
  if (!browserFirst || metadata.authority !== null) {
    const device = await context.openDevice({ create: true });
    try {
      const opened = await openPageAuthority({ store: device.store, identity: device.identity, wrapKey: context.wrapKey, peers: context.host.peers,
        applicationId: context.page.applicationId, executionManifestDigest, create: !browserFirst, signal: context.signal });
      created = opened.created || opened.authority.descriptor.rootPrincipal === device.identity.publicKey;
      metadata = await context.host.peers.application({ signal: context.signal });
    } finally { await device.close(); }
  }
  // The running agent program watches this marker and opens the page once it exists.
  if (!existing) await context.savePrivate('initialized.json', { ...marker, creator: created ? 'agent' : marker.creator });
  return { created, dataInitialized: metadata.authority !== null, creator: created ? 'agent' : 'browser' };
}
