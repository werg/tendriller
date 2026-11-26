// Test-only page creation for the SQL specimens. The creating device signs the page's
// descriptor and genesis membership with its own key (it is the root principal, the
// descriptor authority and an administrator); the host never signs authority. The
// administrator names the specimen's other device keys directly in the genesis, the
// same administrator decision `admission.addKey` makes. The specimen distributes one
// test data key out of band, so no epoch key is ever wrapped: the non-root members carry
// no wrap key, and the root's wrap key is fresh and unretained.
// `log` is the @chronolog/peer-session module the specimen runs against.
export async function signSpecimenGenesis(log, { metadata, identity, members, key }) {
  const applicationId = metadata.selection.id, configuration = metadata.configuration;
  if (!configuration?.executionManifestDigest) throw new Error('The page has no prepared execution graph yet');
  const grant = (publicKey, wrapKey, administrator) => ({ publicKey, wrapKey, reader: true, writer: true, administrator, publisher: false, finalizer: false });
  const descriptor = await log.signAppDescriptor({ applicationId, rootPrincipal: identity.publicKey, authorityPublicKey: identity.publicKey,
    executionManifestDigest: configuration.executionManifestDigest, finalityPolicy: { kind: 'none' } }, identity);
  const membership = await log.signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
    epochKeyDigest: await log.epochKeyCommitment(applicationId, 0, key),
    members: [grant(identity.publicKey, (await log.createWrapKeyPair()).publicKey, true),
      ...members.filter(publicKey => publicKey !== identity.publicKey).map(publicKey => grant(publicKey, null, false))],
    // The admission policy pins the host attestation key and the page owner account, as every page does.
    admission: { mode: 'attested', hostKey: metadata.hostAttestationKey, accounts: [...metadata.admissionAccounts], grant: { reader: true, writer: true } },
    admitted: [], invites: [] }, identity);
  const bundle = { descriptor, memberships: [membership] };
  await log.verifyAuthorityBundle(bundle);
  return bundle;
}
