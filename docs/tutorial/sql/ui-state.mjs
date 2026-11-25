// Reviewed guard values are local draft context, never an application ordering barrier.
export function transferIntent(snapshot, input, operationId) {
  if (typeof operationId !== 'string' || !operationId) throw Error('Retain a stable operation ID before dispatch');
  const from = String(input.from), to = String(input.to), units = Number(input.units);
  const expectedSource = input.expectedSource ?? snapshot?.value.stock.find(row => row.id === from)?.units;
  const expectedDestination = input.expectedDestination ?? snapshot?.value.stock.find(row => row.id === to)?.units;
  if (!from || !to || from === to || !Number.isSafeInteger(units) || units <= 0 || units > 1_000_000 ||
      ![expectedSource, expectedDestination].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)) throw Error('Review valid bins, quantity and exact balances');
  return structuredClone({ operationId, command: 'transfer', input: { transferId: input.transferId ?? operationId, from, to, units, expectedSource, expectedDestination }, reviewedRevision: snapshot?.revision ?? null });
}
export function checkIntentSession(session, pending) {
  const reference = pending.reference;
  if (reference && (reference.applicationId !== session.applicationId || reference.author !== session.identity.publicKey)) throw Error('Original intent belongs to another application or signer');
  if (typeof pending.operationId !== 'string' || !pending.operationId || pending.command !== 'transfer') throw Error('Retained transfer intent is invalid');
  return pending;
}
export async function retryIntent(session, pending) {
  checkIntentSession(session, pending);
  const retained = await session.operations.get(pending.operationId);
  const operation = retained ? await session.operations.retry(pending.operationId) : await session.command(pending.command, pending.input,
    { operationId: pending.operationId, ...(pending.authorTimestampMs === undefined ? {} : { authorTimestampMs: BigInt(pending.authorTimestampMs) }) });
  return operation.inspect();
}
