// Qualification verifier for raw Chronolog v2 `$publications` SignedOperation wire records.
import { bytesToHex } from '@chronolog/authority';
import { decodeSignedOperation, verifySignedOperation } from '@chronolog/peer-session/kernel';
import { authorityRecordBytes } from '../contract/authority.mjs';

export async function decodeFirstAppPublication(record) {
  const raw = record instanceof Uint8Array ? record : authorityRecordBytes(record, 512 * 1024);
  const signed = decodeSignedOperation(raw);
  const { core, opId } = await verifySignedOperation(signed);
  const update = core.updates.find(u => u.topic === '$publications');
  if (!update || !update.input || typeof update.input !== 'object' || Array.isArray(update.input)) {
    throw Error('Publication operation must update $publications');
  }
  return {
    opId: bytesToHex(opId),
    chainId: bytesToHex(core.chainId),
    author: bytesToHex(core.author),
    operationId: core.operationId,
    ...update.input,
  };
}
