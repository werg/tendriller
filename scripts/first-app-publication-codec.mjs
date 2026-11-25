// Qualification-only verifier for the actual raw SignedPublication JSON wire
// value. The packed host independently enforces its publisher grant and head;
// this checks envelope integrity solely to match the signed public intent.
import { verifyPublicationManifest, encodeRecord, PUBLICATION_LIMITS } from '@chronolog/authority';
export async function decodeFirstAppPublication(publication) {
  if (encodeRecord(publication).length > PUBLICATION_LIMITS.manifestBytes + 2048) throw Error('Publication fixture envelope exceeds its bound');
  const payload = publication?.payload;
  await verifyPublicationManifest(publication, {
    applicationId: payload?.applicationId,
    executionManifestDigest: payload?.executionManifestDigest,
    grantId: payload?.membershipId,
    publisherKeys: [payload?.author],
  });
  return publication.payload;
}
