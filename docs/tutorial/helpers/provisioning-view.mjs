import { encodeRecord, decodeRecord, verifyRecord, recordDigest } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
const text = value => JSON.stringify(authorityRecord(encodeRecord(value)), null, 2);
const parse = value => decodeRecord(authorityRecordBytes(JSON.parse(value)));
/** Explicit recipient-bound wrapped-key transfer. Neither page code nor host receives plaintext keys. */
export function mountProvisioning({ root, session, peers, local }) {
  const $ = name => root.querySelector(`[data-provisioning="${name}"]`), message = value => { $('status').textContent = value; };
  let reviewed;
  const run = action => async () => { try { await action(); } catch (error) { message(error.message ?? String(error)); } };
  $('request').addEventListener('click', run(async () => {
    const request = await session.provisioning.createProvisioningRequest();
    $('out').value = text(request); message('Public request created. Copy it to an existing authorized device. Keep this browser profile: it holds the private agreement key.');
  }));
  $('in').addEventListener('input', () => { reviewed = undefined; $('grant').disabled = true; });
  $('review').addEventListener('click', run(async () => {
    const request = parse($('in').value);
    await verifyRecord('provisioning-request', request, request.payload.recipient);
    const metadata = await peers.application(), bundle = decodeRecord(authorityRecordBytes(metadata.authority));
    if (request.payload.applicationId !== session.applicationId || request.payload.descriptorId !== await recordDigest(bundle.descriptor)) throw Error('The request belongs to a different application descriptor');
    reviewed = structuredClone(request); $('grant').disabled = false;
    message(`Review recipient fingerprint: ${request.payload.recipient}. Grant only the selected crypto rights. This does not grant SQL namespace/object permissions or publishing/finalizer rights.`);
  }));
  $('grant').addEventListener('click', run(async () => {
    if (!reviewed) throw Error('Review the exact signed recipient request first');
    const request = reviewed, metadata = await peers.application();
    let bundle = decodeRecord(authorityRecordBytes(metadata.authority));
    const head = bundle.memberships.at(-1), previous = head.payload.members.find(member => member.publicKey === request.payload.recipient);
    if (!previous?.reader || $('writer').checked && !previous?.writer) {
      const key = `grant:${request.payload.requestId}`;
      let intent = local.readDraft(key);
      if (!intent) {
        intent = { requestId: crypto.randomUUID(), expectedMembershipId: await recordDigest(head),
          authorTimeAfterMs: (BigInt(Date.now()) > head.payload.authorTimeAfterMs ? BigInt(Date.now()) : head.payload.authorTimeAfterMs + 1n).toString(),
          grant: { publicKey: request.payload.recipient, reader: true, writer: Boolean(previous?.writer || $('writer').checked),
            administrator: previous?.administrator ?? false, publisher: previous?.publisher ?? false, finalizer: previous?.finalizer ?? false } };
        local.writeDraft(intent, key);
      }
      const result = await peers.grant(intent);
      bundle = decodeRecord(authorityRecordBytes(result.authority));
    }
    await session.mergeAuthority(bundle);
    const encrypted = await session.provisioning.exportProvisioning(request);
    $('out').value = text(encrypted); message('Recipient-bound encrypted key package created. Copy it to that recipient and import it there. Keep the original request for retry.');
  }));
  $('import').addEventListener('click', run(async () => {
    const value = parse($('in').value);
    await session.provisioning.importProvisioning(value);
    message('The wrapped keys were verified and stored by this browser’s owner. Ordinary local Save is now available if its writer grant is active.');
  }));
  const external = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Prove an optional native/external device key';
  const keyLabel = document.createElement('label'), keyInput = document.createElement('input'); keyLabel.textContent = 'Public signing key from that retained device'; keyLabel.append(keyInput);
  const challengeButton = document.createElement('button'); challengeButton.type = 'button'; challengeButton.className = 'secondary'; challengeButton.textContent = 'Create account-bound challenge for this key';
  const proofButton = document.createElement('button'); proofButton.type = 'button'; proofButton.className = 'secondary'; proofButton.textContent = 'Record external signed enrollment proof from incoming field';
  const help = document.createElement('p'); help.textContent = 'Create the native device explicitly, copy its public key here, send this public challenge to its sign-enrollment command, then paste its public signed proof into the incoming field. After recording proof, use its provisioning request in the ordinary reviewed wrapped-key flow. No native process is required for browser edits.';
  challengeButton.addEventListener('click', run(async () => { const challenge = await peers.challenge(keyInput.value.trim()); $('out').value = JSON.stringify(challenge, null, 2); message('Copy this public account-bound challenge to that exact retained native device. Its signing key must sign the epoch-bound enrollment request.'); }));
  proofButton.addEventListener('click', run(async () => { const proof = JSON.parse($('in').value); const result = await peers.enroll(proof); if (result.authority) await session.mergeAuthority(decodeRecord(authorityRecordBytes(result.authority))); message('External key proof recorded for this account. No data rights or plaintext keys were granted by proof alone. Review its provisioning request next.'); }));
  external.append(summary, help, keyLabel, challengeButton, proofButton); root.append(external);
  return { close() { reviewed = undefined; } };
}
