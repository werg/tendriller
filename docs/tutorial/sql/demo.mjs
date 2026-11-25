// Optional native read of the existing browser-initialized/provisioned application.
// Schema creation/editing is demonstrated by ordinary transactions in the SQL page.
import { openSession } from './session.mjs';
let owned, primary;
try {
  owned = await openSession({ signal: AbortSignal.timeout(30_000) });
  const snapshot = await owned.session.query('inventory', null);
  console.log(JSON.stringify({ applicationId: owned.session.applicationId, revision: snapshot.revision,
    stock: snapshot.value.stock, catalog: snapshot.value.catalog, provisional: true,
    note: 'This is a coherent local materialization, not global exclusivity or finality. No new schema, data root or device was initialized by this read.' }, null, 2));
} catch (error) { primary = error; throw error; }
finally {
  try { await owned?.close(); }
  catch (cleanup) {
    if (primary !== undefined) throw new AggregateError([primary, cleanup], 'SQL read and owner cleanup both failed', { cause: primary });
    throw cleanup;
  }
}
