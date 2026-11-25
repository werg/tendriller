// Qualification-only portable decoder. The packed host independently enforces
// its publisher grant and head; this validates cryptographic envelope integrity
// solely so the private request gate can match the signed public intent.
import { decodeRecord, hexToBytes, verifyPublicationManifest, PUBLICATION_LIMITS } from '@chronolog/authority';
export async function decodeFirstAppPublication(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== 1 || typeof record.record !== 'string' ||
      record.record.length > 2 * (PUBLICATION_LIMITS.manifestBytes + 2048)) throw Error('Invalid publication fixture record');
  const publication = decodeRecord(hexToBytes(record.record));
  const payload = publication?.payload;
  await verifyPublicationManifest(publication, {
    applicationId: payload?.applicationId,
    executionManifestDigest: payload?.executionManifestDigest,
    grantId: payload?.membershipId,
    publisherKeys: [payload?.author],
  });
  return publication.payload;
}
