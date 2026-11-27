// Test-only Chronolog v2 page genesis creation for the SQL specimens.
export async function signSpecimenGenesis(log, { metadata, identity, members, key, imports, topics }) {
  const wrapKey = (await log.createWrapKeyPair()).publicKey;
  const created = await log.createChainGenesis({
    creator: {
      publicKey: identity.publicKey,
      wrapKey,
      reader: true,
      writer: true,
      administrator: true,
      publisher: true,
      finalizer: false,
    },
    members: members
      .filter(publicKey => publicKey !== identity.publicKey)
      .map(publicKey => ({
        publicKey,
        reader: true,
        writer: true,
        administrator: false,
        publisher: false,
        finalizer: false,
      })),
    privateChain: true,
    hostPublicKey: metadata.hostAttestationKey,
    epoch0Key: key,
    imports,
    topics,
  });
  const genesis = structuredClone(created.genesis);
  genesis.initialTopics.$permissions = {
    ...genesis.initialTopics.$permissions,
    admission: {
      mode: 'attested',
      hostKey: metadata.hostAttestationKey,
      accounts: [...(metadata.admissionAccounts ?? [])],
      grant: { reader: true, writer: true, administrator: true },
      invites: [],
    },
  };
  const genesisBytes = log.encodeGenesisBlock(genesis);
  return {
    chainId: log.bytesToHex(log.genesisChainId(genesisBytes)),
    genesis,
    genesisBytes,
    casNodes: created.casNodes,
    epoch0Key: key,
  };
}
