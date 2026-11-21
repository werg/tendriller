// Reviewed intent is retained before an RPC. The session owns signed attempts.
export function transferIntent(snapshot, { from, to, units }, operationId) {
  if (!['source', 'destination'].includes(from) || !['source', 'destination'].includes(to) || from === to)
    throw Error('Choose two different inventory bins.');
  if (!Number.isSafeInteger(units) || units < 1 || units > 1_000_000) throw Error('Enter 1–1,000,000 whole units.');
  const balances = new Map(snapshot.value.stock.map(row => [row.id, row.units]));
  const expectedSource = balances.get(from), expectedDestination = balances.get(to);
  if (![expectedSource, expectedDestination].every(value => Number.isSafeInteger(value) && value >= 0))
    throw Error('Initialize both bins with npm run demo on the native participant, then refresh.');
  if (units > expectedSource || expectedDestination + units > 1_000_000) throw Error('The reviewed balances cannot support this transfer.');
  return structuredClone({ id: operationId, command: 'transfer', basedOn: snapshot.revision,
    input: { transferId: operationId, from, to, units, expectedSource, expectedDestination } });
}

export function checkIntentSession(pending, session) {
  if (pending.reference.applicationId !== session.applicationId || pending.reference.author !== session.deviceId ||
      pending.reference.historyId !== session.historyId)
    throw Error('This retained operation belongs to another device or history. Reopen its original browser profile and history; do not replace the intent.');
}

export async function retryIntent(session, pending) {
  checkIntentSession(pending, session);
  const state = await session.operations.get(pending.id);
  if (state?.status === 'applied') return state;
  if (['abandoned', 'needsReapply'].includes(state?.status))
    throw Error('Recovery excluded this attempt. Review the original history and current balances before explicitly reapplying; this tutorial does not reapply automatically.');
  if (state) await session.retry(pending.id);
  else await session.command(pending.command, pending.input, { operationId: pending.id, basedOn: pending.basedOn });
  return session.operations.wait(pending.id, { signal: AbortSignal.timeout(15_000) });
}
